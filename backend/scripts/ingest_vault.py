"""Ingest the viewer's knowledge state into the graph.

Two sources:
  1. Obsidian vault claim-filenames (privacy-safe: titles only, never note bodies)
       -> (:Concept {status: 'known', source: 'vault', note_path})
  2. data/learning_goals.yaml
       -> (:Concept {status: 'goal', source: 'goals'})

Each concept name is embedded with Marengo (same 512-dim space as video
segments) so scripts/resolve_concepts.py can match them against video
Topics/Entities by cosine similarity.

Run:  uv run python scripts/ingest_vault.py --vault-dir=~/notes [--vault-dir=...]
      or set VAULT_DIRS=~/notes:~/ideas in .env

There is no default vault directory on purpose: the only honest default would be
someone else's folders, and silently ingesting nothing (or the wrong thing) is worse
than an error that tells you what to pass.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import sys
from pathlib import Path

import yaml

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ingest_vault")

sys.path.insert(0, ".")

from app.config import settings  # noqa: E402
from app.context_graph_client import connect_neo4j, close_neo4j, execute_cypher  # noqa: E402
from app import twelvelabs_client as tl  # noqa: E402

# Point this at whichever folders hold claim-per-file notes, via --vault-dir= or the
# VAULT_DIRS env var. Coverage is the whole game: scanning one subfolder left the viewer
# looking like they knew 33 things, so nearly every video term read as novel; widening to
# four folders moved it to 109 and that was the ceiling. Worth excluding are date-named
# journal entries and routine logs — real notes, but nothing a talk could teach.
VAULT_DIRS_ENV = "VAULT_DIRS"
GOALS_FILE = Path(__file__).resolve().parents[2] / "data" / "learning_goals.yaml"

# Filenames that are index/meta files, not knowledge claims.
SKIP_PREFIXES = ("_", "README")
# A stem that is (or ends in) a bare date — daily notes, open-loops-2026-07-22, etc.
_DATE_STEM = re.compile(r"^(.*-)?\d{4}-\d{2}-\d{2}$")


def _norm_key(name: str) -> str:
    return " ".join(name.strip().lower().split())


def _claim_files(vault_dirs: list[str]) -> list[tuple[str, str]]:
    """Yield (concept_name, note_path) from claim-as-filename markdown notes."""
    out = []
    for d in vault_dirs:
        root = Path(d).expanduser()
        if not root.is_dir():
            log.warning("vault dir missing, skipped: %s", root)
            continue
        for p in sorted(root.rglob("*.md")):
            if p.name.startswith(SKIP_PREFIXES):
                continue
            if _DATE_STEM.match(p.stem):  # 2026-07-30.md and friends are journal, not claim
                continue
            name = p.stem.replace("-", " ").strip()
            if len(name.split()) < 2:  # single-word files are indexes, not claims
                continue
            out.append((name, str(p)))
    return out


def _goal_concepts() -> list[str]:
    if not GOALS_FILE.is_file():
        log.warning("no learning goals file at %s", GOALS_FILE)
        return []
    data = yaml.safe_load(GOALS_FILE.read_text()) or {}
    return [g.strip() for g in data.get("goals", []) if g and g.strip()]


async def write_concepts(rows: list[dict]) -> None:
    await execute_cypher(
        """
        UNWIND $rows AS row
        MERGE (c:Concept {key: row.key})
        SET c.name = row.name, c.status = row.status, c.source = row.source,
            c.note_path = row.note_path, c.embedding = row.embedding,
            c.domain = $domain
        """,
        {"rows": rows, "domain": settings.domain_id},
        collect=False,
    )


async def prune_stale_goals(current_keys: list[str]) -> int:
    """Drop goal Concepts that are no longer in learning_goals.yaml.

    MERGE alone never forgets: editing a goal out of the YAML used to leave its node (and
    its ADVANCES edges) in the graph forever, so the graph slowly accumulated every goal
    ever listed and reported a higher count than the file could explain. Scoped to
    source:'goals' — vault concepts and captured video:… concepts are untouched.
    """
    rows = await execute_cypher(
        """
        MATCH (c:Concept {source: 'goals'})
        WHERE NOT c.key IN $keys
        WITH c, c.name AS name
        DETACH DELETE c
        RETURN name
        """,
        {"keys": current_keys},
    )
    if rows:
        log.info("Removed %d goal(s) no longer in learning_goals.yaml: %s",
                 len(rows), ", ".join(r["name"] for r in rows))
    return len(rows)


async def ensure_concept_vector_index(dim: int) -> None:
    await execute_cypher(
        f"""
        CREATE VECTOR INDEX concept_embeddings IF NOT EXISTS
        FOR (n:Concept) ON (n.embedding)
        OPTIONS {{ indexConfig: {{
            `vector.dimensions`: {int(dim)},
            `vector.similarity_function`: 'cosine'
        }} }}
        """,
        collect=False,
    )


async def main() -> None:
    vault_dirs = [a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--vault-dir=")]
    if not vault_dirs:
        env_dirs = os.environ.get(VAULT_DIRS_ENV, "")
        vault_dirs = [d.strip() for d in re.split(r"[:,]", env_dirs) if d.strip()]
    if not vault_dirs:
        log.error(
            "No vault directory given. Point this at your notes, e.g.\n"
            "    uv run python scripts/ingest_vault.py --vault-dir=~/notes\n"
            "or set VAULT_DIRS=~/notes:~/ideas in .env\n"
            "Expects claim-per-file markdown: the FILENAME is read as the concept, "
            "never the note body."
        )
        sys.exit(1)

    missing = [d for d in vault_dirs if not Path(d).expanduser().is_dir()]
    if missing:
        log.error("Not a directory: %s", ", ".join(missing))
        sys.exit(1)

    known = _claim_files(vault_dirs)
    goals = _goal_concepts()
    log.info("Found %d vault concepts, %d learning goals", len(known), len(goals))
    if not known and not goals:
        log.error(
            "Nothing to ingest — scanned %s and found no claim-shaped filenames.",
            ", ".join(vault_dirs),
        )
        sys.exit(1)

    rows = []
    dim = 0
    for name, path in known:
        rows.append({"key": _norm_key(name), "name": name, "status": "known",
                     "source": "vault", "note_path": path})
    for name in goals:
        rows.append({"key": _norm_key(name), "name": name, "status": "goal",
                     "source": "goals", "note_path": None})

    for row in rows:
        try:
            vec = tl.embed_text(row["name"])
            row["embedding"] = vec
            dim = dim or len(vec)
        except Exception as e:
            log.warning("embed failed for '%s': %s", row["name"], e)
            row["embedding"] = None

    await connect_neo4j()
    try:
        await write_concepts(rows)
        await prune_stale_goals([_norm_key(g) for g in goals])
        if dim:
            await ensure_concept_vector_index(dim)
        log.info("Wrote %d Concept nodes (%d known, %d goals).",
                 len(rows), len(known), len(goals))
    finally:
        await close_neo4j()


if __name__ == "__main__":
    asyncio.run(main())
