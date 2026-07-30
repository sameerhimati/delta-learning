"""Ingest the viewer's knowledge state into the graph.

Two sources:
  1. Obsidian vault claim-filenames (privacy-safe: titles only, never note bodies)
       -> (:Concept {status: 'known', source: 'vault', note_path})
  2. data/learning_goals.yaml
       -> (:Concept {status: 'goal', source: 'goals'})

Each concept name is embedded with Marengo (same 512-dim space as video
segments) so scripts/resolve_concepts.py can match them against video
Topics/Entities by cosine similarity.

Run:  uv run python scripts/ingest_vault.py [--vault-dir DIR ...]
Default vault dirs are Sameer's research/ai-ml + ideas folders.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

import yaml

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ingest_vault")

sys.path.insert(0, ".")

from app.config import settings  # noqa: E402
from app.context_graph_client import connect_neo4j, close_neo4j, execute_cypher  # noqa: E402
from app import twelvelabs_client as tl  # noqa: E402

DEFAULT_VAULT_DIRS = [
    "~/Desktop/knowledge/research/ai-ml",
    "~/Desktop/knowledge/ideas",
]
GOALS_FILE = Path(__file__).resolve().parents[2] / "data" / "learning_goals.yaml"

# Filenames that are index/meta files, not knowledge claims.
SKIP_PREFIXES = ("_", "README")


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
    vault_dirs = vault_dirs or DEFAULT_VAULT_DIRS

    known = _claim_files(vault_dirs)
    goals = _goal_concepts()
    log.info("Found %d vault concepts, %d learning goals", len(known), len(goals))
    if not known and not goals:
        log.error("Nothing to ingest.")
        return

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
        if dim:
            await ensure_concept_vector_index(dim)
        log.info("Wrote %d Concept nodes (%d known, %d goals).",
                 len(rows), len(known), len(goals))
    finally:
        await close_neo4j()


if __name__ == "__main__":
    asyncio.run(main())
