"""Load data/demo_graph.json into Neo4j. No API keys required.

The delta traversal is pure Cypher, so a graph is all it needs — the OpenAI and
TwelveLabs keys are for *building* a graph, not for reading one. This gets a first-time
reader to a real cut list in about a minute, on a real corpus, with nothing to sign up
for. See export_demo_graph.py for what the snapshot deliberately leaves out.

Run:  uv run python scripts/load_demo_graph.py [--in PATH] [--force]
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("load_demo_graph")

sys.path.insert(0, ".")

from app.config import settings  # noqa: E402
from app.context_graph_client import connect_neo4j, close_neo4j, execute_cypher  # noqa: E402

DEFAULT_IN = Path(__file__).resolve().parents[2] / "data" / "demo_graph.json"

WRITES = [
    ("videos", """
        UNWIND $rows AS row
        MERGE (v:Video {id: row.id})
        SET v.title = row.title, v.url = row.url,
            v.duration_sec = row.duration_sec, v.summary = row.summary,
            v.domain = $domain
    """),
    ("segments", """
        UNWIND $rows AS row
        MERGE (s:Segment {id: row.id})
        SET s.video_id = row.video_id, s.idx = row.idx, s.start_sec = row.start_sec,
            s.end_sec = row.end_sec, s.summary = row.summary, s.domain = $domain
    """),
    ("topics", """
        UNWIND $rows AS row
        MERGE (t:Topic {name: row.name})
        SET t.key = row.key, t.learnable = row.learnable, t.domain = $domain
    """),
    ("entities", """
        UNWIND $rows AS row
        MERGE (e:Entity {name: row.name})
        SET e.key = row.key, e.type = row.type, e.learnable = row.learnable,
            e.domain = $domain
    """),
    ("concepts", """
        UNWIND $rows AS row
        MERGE (c:Concept {key: row.key})
        SET c.name = row.name, c.status = row.status, c.source = row.source,
            c.note_path = row.note_path, c.domain = $domain
    """),
]

REL_WRITES = [
    ("has_segment", """
        UNWIND $rows AS row
        MATCH (v:Video {id: row.video_id}), (s:Segment {id: row.segment_id})
        MERGE (v)-[:HAS_SEGMENT]->(s)
    """),
    ("about", """
        UNWIND $rows AS row
        MATCH (s:Segment {id: row.segment_id}), (t:Topic {name: row.name})
        MERGE (s)-[:ABOUT]->(t)
    """),
    ("mentions", """
        UNWIND $rows AS row
        MATCH (s:Segment {id: row.segment_id}), (e:Entity {name: row.name})
        MERGE (s)-[:MENTIONS]->(e)
    """),
    ("same_as", """
        UNWIND $rows AS row
        MATCH (c:Concept {key: row.concept_key})
        MATCH (x) WHERE (x:Topic OR x:Entity) AND labels(x)[0] = row.kind
              AND x.name = row.name
        MERGE (x)-[:SAME_AS]->(c)
    """),
    ("advances", """
        UNWIND $rows AS row
        MATCH (c:Concept {key: row.concept_key})
        MATCH (x) WHERE (x:Topic OR x:Entity) AND labels(x)[0] = row.kind
              AND x.name = row.name
        MERGE (x)-[:ADVANCES]->(c)
    """),
]


async def main() -> None:
    path, force = DEFAULT_IN, "--force" in sys.argv
    for arg in sys.argv[1:]:
        if arg.startswith("--in="):
            path = Path(arg.split("=", 1)[1])

    if not path.exists():
        log.error("No snapshot at %s", path)
        sys.exit(1)

    if not settings.neo4j_uri:
        log.error(
            "NEO4J_URI is not set. Copy the example env and start a local Neo4j:\n"
            "    cp .env.example .env && make docker-up\n"
            "No OpenAI or TwelveLabs key is needed for the demo."
        )
        sys.exit(1)

    data = json.loads(path.read_text())

    await connect_neo4j()
    try:
        existing = await execute_cypher("MATCH (v:Video) RETURN count(v) AS n")
        n = existing[0]["n"] if existing else 0
        if n and not force:
            log.error(
                "This database already has %d Video node(s). Loading the demo snapshot "
                "on top would mix two corpora. Re-run with --force if that's what you "
                "want, or point NEO4J_DATABASE at an empty database.", n
            )
            sys.exit(1)

        for name, q in WRITES + REL_WRITES:
            rows = (data["nodes"].get(name) or data["relationships"].get(name) or [])
            if not rows:
                continue
            await execute_cypher(q, {"rows": rows, "domain": settings.domain_id},
                                 collect=False)
            log.info("loaded %-12s %4d", name, len(rows))
    finally:
        await close_neo4j()

    log.info("Demo graph loaded. Start the app with `make start`, then ask for a cut list.")


if __name__ == "__main__":
    asyncio.run(main())
