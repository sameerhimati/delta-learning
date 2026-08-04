"""Export the delta-relevant subgraph to data/demo_graph.json.

This is what makes `make demo` possible: a stranger with no API keys can load a real
graph and get a real cut list, instead of reading a README and taking it on faith.

Deliberately NOT exported:

  embedding      512 floats per node. Only resolve_concepts.py and vector search need
                 them, neither of which runs in the demo, and they would multiply the
                 file size by roughly twenty for nothing.
  transcript     Verbatim speech from third-party conference talks. Segment summaries
                 are short Pegasus-generated descriptions and ship; reproducing whole
                 transcripts of someone else's talk in a public repo is a different
                 thing, and not ours to do.
  on_screen_text Same reasoning — it is OCR of someone else's slides.
  Concepts with source='video'
                 These are capture artifacts. Exporting the PRE-capture state is the
                 whole point: the demo's payoff is running capture yourself and
                 watching the cut list shrink. Shipping a post-capture graph would
                 hand over the answer and delete the moment.

Run:  uv run python scripts/export_demo_graph.py [--out PATH]
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path

import yaml

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("export_demo_graph")

sys.path.insert(0, ".")

from app.context_graph_client import connect_neo4j, close_neo4j, execute_cypher  # noqa: E402

DEFAULT_OUT = Path(__file__).resolve().parents[2] / "data" / "demo_graph.json"
GOALS_FILE = Path(__file__).resolve().parents[2] / "data" / "learning_goals.yaml"


def _goal_keys() -> list[str]:
    if not GOALS_FILE.exists():
        return []
    data = yaml.safe_load(GOALS_FILE.read_text()) or {}
    return [" ".join(g.strip().lower().split()) for g in data.get("goals", []) if g and g.strip()]

NODE_QUERIES = {
    "videos": """
        MATCH (v:Video)
        RETURN v.id AS id, v.title AS title, v.url AS url,
               v.duration_sec AS duration_sec, v.summary AS summary
        ORDER BY v.title
    """,
    "segments": """
        MATCH (s:Segment)
        RETURN s.id AS id, s.video_id AS video_id, s.idx AS idx,
               s.start_sec AS start_sec, s.end_sec AS end_sec, s.summary AS summary
        ORDER BY s.video_id, s.idx
    """,
    "topics": """
        MATCH (t:Topic)
        RETURN t.name AS name, t.key AS key, t.learnable AS learnable
        ORDER BY t.name
    """,
    "entities": """
        MATCH (e:Entity)
        RETURN e.name AS name, e.key AS key, e.type AS type, e.learnable AS learnable
        ORDER BY e.name
    """,
    # Vault + goal concepts only. Captured ones are excluded on purpose (see module
    # docstring). Goals are additionally filtered to what learning_goals.yaml lists today:
    # MERGE never forgot goals that were edited out, so a long-lived graph accumulates
    # every goal it has ever seen, and exporting those would ship a knowledge state no one
    # could reproduce from the files in the repo.
    "concepts": """
        MATCH (c:Concept)
        WHERE coalesce(c.source, '') <> 'video'
          AND (c.status <> 'goal' OR c.key IN $goal_keys)
        RETURN c.key AS key, c.name AS name, c.status AS status,
               c.source AS source, c.note_path AS note_path
        ORDER BY c.name
    """,
}

REL_QUERIES = {
    "has_segment": """
        MATCH (v:Video)-[:HAS_SEGMENT]->(s:Segment)
        RETURN v.id AS video_id, s.id AS segment_id
    """,
    "next": """
        MATCH (a:Segment)-[:NEXT]->(b:Segment)
        RETURN a.id AS from_id, b.id AS to_id
    """,
    "about": """
        MATCH (s:Segment)-[:ABOUT]->(t:Topic)
        RETURN s.id AS segment_id, t.name AS name
    """,
    "mentions": """
        MATCH (s:Segment)-[:MENTIONS]->(e:Entity)
        RETURN s.id AS segment_id, e.name AS name
    """,
    "same_as": """
        MATCH (x)-[:SAME_AS]->(c:Concept)
        WHERE (x:Topic OR x:Entity) AND coalesce(c.source, '') <> 'video'
        RETURN labels(x)[0] AS kind, x.name AS name, c.key AS concept_key
    """,
    "advances": """
        MATCH (x)-[:ADVANCES]->(c:Concept)
        WHERE (x:Topic OR x:Entity) AND coalesce(c.source, '') <> 'video'
        RETURN labels(x)[0] AS kind, x.name AS name, c.key AS concept_key
    """,
}


async def main() -> None:
    out = DEFAULT_OUT
    for arg in sys.argv[1:]:
        if arg.startswith("--out="):
            out = Path(arg.split("=", 1)[1])

    await connect_neo4j()
    try:
        data: dict = {
            "_readme": (
                "Snapshot of a real Delta Learning graph, exported by "
                "backend/scripts/export_demo_graph.py and loaded by load_demo_graph.py "
                "(`make demo`). Embeddings, transcripts and on-screen text are omitted; "
                "captured concepts are omitted so the capture beat still has somewhere "
                "to go. Segment summaries are model-generated descriptions of "
                "third-party talks, included as metadata, not as a reproduction."
            ),
            "nodes": {},
            "relationships": {},
        }
        goal_keys = _goal_keys()
        for name, q in NODE_QUERIES.items():
            rows = await execute_cypher(q, {"goal_keys": goal_keys})
            data["nodes"][name] = rows
            log.info("%-10s %4d", name, len(rows))
        for name, q in REL_QUERIES.items():
            rows = await execute_cypher(q)
            data["relationships"][name] = rows
            log.info("%-10s %4d", name, len(rows))
    finally:
        await close_neo4j()

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    kb = out.stat().st_size / 1024
    log.info("Wrote %s (%.0f KB)", out, kb)

    if not data["nodes"]["videos"]:
        log.warning("No videos exported — was the graph empty?")
    if not data["relationships"]["same_as"]:
        log.warning(
            "No SAME_AS edges exported. The demo cut list will show everything as "
            "novel; did resolve_concepts.py run?"
        )


if __name__ == "__main__":
    asyncio.run(main())
