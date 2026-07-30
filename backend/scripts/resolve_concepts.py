"""Resolve video Topics/Entities against the viewer's Concepts.

The starter's cross-video entity merge is string-equality on normalized names —
"prompt-and-pray". This pass does real resolution between the video side and
the knowledge side:

  1. Embed every learnable Topic/Entity name (Marengo, cached on the node).
  2. Candidate pairs = cosine(topic_embedding, concept_embedding) >= THRESHOLD.
  3. ONE OpenAI structured-outputs call adjudicates all candidates ("is the
     video term the same concept the viewer's note is about?").
  4. Confirmed pairs -> (x)-[:SAME_AS]->(c) edges. Non-destructive: no merges,
     so every decision is inspectable in the graph.

Run after ingest.py and ingest_vault.py:  uv run python scripts/resolve_concepts.py
Idempotent — safe to re-run after adding videos, notes, or goals.
"""

from __future__ import annotations

import asyncio
import logging
import math
import sys

from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("resolve")

sys.path.insert(0, ".")

from app.config import settings  # noqa: E402
from app.context_graph_client import connect_neo4j, close_neo4j, execute_cypher  # noqa: E402
from app.delta import LEARNABLE_ENTITY_TYPES  # noqa: E402
from app import twelvelabs_client as tl  # noqa: E402

# A deliberately broad pre-filter. The OpenAI adjudicator below is the semantic
# acceptance gate; 0.55 retains paraphrased vault claims without treating cosine
# similarity itself as proof that two concepts are the same.
THRESHOLD = 0.55
MAX_CANDIDATES = 120  # one adjudication call; cap keeps the prompt sane


class Verdict(BaseModel):
    video_term: str
    concept: str
    same: bool


class Verdicts(BaseModel):
    pairs: list[Verdict]


ADJUDICATE_SYSTEM = (
    "You judge whether a term extracted from a video refers to the same concept "
    "as a note title from a personal knowledge base. 'Same' means a person who "
    "understands the note would NOT learn something fundamentally new from a "
    "video section about the term — the note may phrase it as a claim while the "
    "video names the bare topic. Related-but-distinct concepts (e.g. 'attention' "
    "vs 'flash attention') are NOT the same. Return a verdict for EVERY pair."
)


def _cos(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def adjudicate(pairs: list[dict]) -> list[Verdict]:
    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key or None)
    listing = "\n".join(
        f"- video term: \"{p['topic_name']}\"  |  note/goal: \"{p['concept_name']}\""
        f"  (cosine {p['score']:.2f})"
        for p in pairs
    )
    response = client.responses.parse(
        model=settings.openai_extraction_model,
        reasoning={"effort": settings.openai_reasoning_effort},
        input=[
            {"role": "system", "content": ADJUDICATE_SYSTEM},
            {"role": "user", "content": f"Candidate pairs:\n\n{listing}"},
        ],
        text_format=Verdicts,
    )
    if response.output_parsed is None:
        raise RuntimeError("OpenAI returned no adjudication.")
    return response.output_parsed.pairs


async def embed_missing_terms() -> None:
    """Cache a Marengo embedding on every learnable Topic/Entity lacking one."""
    rows = await execute_cypher(
        """
        MATCH (x)
        WHERE ((x:Topic) OR (x:Entity AND x.type IN $types)) AND x.embedding IS NULL
        RETURN elementId(x) AS eid, x.name AS name
        """,
        {"types": LEARNABLE_ENTITY_TYPES},
        collect=False,
    )
    log.info("Embedding %d unembedded video terms ...", len(rows))
    for r in rows:
        try:
            vec = tl.embed_text(r["name"])
        except Exception as e:
            log.warning("embed failed for '%s': %s", r["name"], e)
            continue
        await execute_cypher(
            "MATCH (x) WHERE elementId(x) = $eid SET x.embedding = $vec",
            {"eid": r["eid"], "vec": vec},
            collect=False,
        )


async def main() -> None:
    await connect_neo4j()
    try:
        await embed_missing_terms()

        terms = await execute_cypher(
            """
            MATCH (x)
            WHERE ((x:Topic) OR (x:Entity AND x.type IN $types))
              AND x.embedding IS NOT NULL
            RETURN elementId(x) AS eid, x.name AS name, x.embedding AS emb
            """,
            {"types": LEARNABLE_ENTITY_TYPES},
            collect=False,
        )
        concepts = await execute_cypher(
            """
            MATCH (c:Concept) WHERE c.embedding IS NOT NULL
            RETURN elementId(c) AS eid, c.name AS name, c.embedding AS emb
            """,
            collect=False,
        )
        log.info("Comparing %d video terms x %d concepts", len(terms), len(concepts))

        candidates = []
        for t in terms:
            for c in concepts:
                score = _cos(t["emb"], c["emb"])
                if score >= THRESHOLD:
                    candidates.append({
                        "topic_eid": t["eid"], "topic_name": t["name"],
                        "concept_eid": c["eid"], "concept_name": c["name"],
                        "score": score,
                    })
        candidates.sort(key=lambda p: -p["score"])
        candidates = candidates[:MAX_CANDIDATES]
        log.info("%d candidate pairs above cosine %.2f", len(candidates), THRESHOLD)
        if not candidates:
            log.warning("No candidates. Lower THRESHOLD or check embeddings.")
            return

        verdicts = adjudicate(candidates)
        confirmed_names = {(v.video_term.lower(), v.concept.lower())
                           for v in verdicts if v.same}
        confirmed = [p for p in candidates
                     if (p["topic_name"].lower(), p["concept_name"].lower()) in confirmed_names]
        log.info("Adjudicator confirmed %d / %d pairs", len(confirmed), len(candidates))

        for p in confirmed:
            await execute_cypher(
                """
                MATCH (x) WHERE elementId(x) = $teid
                MATCH (c) WHERE elementId(c) = $ceid
                MERGE (x)-[r:SAME_AS]->(c)
                SET r.score = $score
                """,
                {"teid": p["topic_eid"], "ceid": p["concept_eid"], "score": p["score"]},
                collect=False,
            )
            log.info("  SAME_AS: '%s' == '%s' (%.2f)",
                     p["topic_name"], p["concept_name"], p["score"])
    finally:
        await close_neo4j()


if __name__ == "__main__":
    asyncio.run(main())
