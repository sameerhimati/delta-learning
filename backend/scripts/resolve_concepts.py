"""Resolve video Topics/Entities against the viewer's Concepts.

The starter's cross-video entity merge is string-equality on normalized names —
"prompt-and-pray". This pass does real resolution between the video side and
the knowledge side:

  1. Embed every learnable Topic/Entity name (Marengo, cached on the node).
  2. Rank each term's nearest Concepts by cosine and keep the top TOP_K.
  3. Strict pass: OpenAI adjudicates identity ("is the video term the same
     concept the viewer's note is about?") -> (x)-[:SAME_AS]->(c).
  4. Goal pass: OpenAI adjudicates topical relevance against goal Concepts only
     ("would a section about this term help someone pursuing this goal?")
     -> (x)-[:ADVANCES]->(c). Goals are broad ("game theory") while video terms
     are specific ("Nash Equilibrium"), so identity would never fire here.
  5. Non-destructive: no merges, so every decision is inspectable in the graph.
     A term may be SAME_AS a known Concept AND ADVANCES a goal — both stand.

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

# No absolute cosine floor. Vault concepts are claim-shaped filenames ("test the
# workflow before reaching for an agent") while video terms are bare noun phrases
# ("Agent Orchestration"); Marengo embeds those far apart even when they denote
# the same idea, so any threshold that survives the noise also rejects true
# matches. Marengo still RANKS (it is on both sides of the match) but it no
# longer REJECTS — the OpenAI adjudicator is the only acceptance gate.
TOP_K = 8  # nearest Concepts considered per video term, applied per-term
TERMS_PER_CHUNK = 15  # all pairs for one term stay in one adjudication call
ADJUDICATE_CONCURRENCY = 6  # in-flight OpenAI reasoning calls; above this we hit 429s
EMBED_CONCURRENCY = 8  # in-flight Marengo embed calls


class Verdict(BaseModel):
    video_term: str
    concept: str
    same: bool


class Verdicts(BaseModel):
    pairs: list[Verdict]


SAME_AS_SYSTEM = (
    "You judge whether a term extracted from a video refers to the same concept "
    "as a note title from a personal knowledge base. 'Same' means a person who "
    "understands the note would NOT learn something fundamentally new from a "
    "video section about the term — the note may phrase it as a claim while the "
    "video names the bare topic. Related-but-distinct concepts (e.g. 'attention' "
    "vs 'flash attention') are NOT the same. Return a verdict for EVERY pair."
)

ADVANCES_SYSTEM = (
    "You judge substantive relevance, NOT identity. For each pair, answer: would a "
    "section of a video about the video term teach a real, specific part of the "
    "stated learning goal? Answer same=true when the term is a genuine sub-topic, "
    "mechanism, or worked instance of the goal — goals are broad ('game theory') "
    "and video terms are specific ('Nash equilibrium'), so a true instance counts.\n"
    "Answer FALSE for generic terms that merely share a field with the goal. "
    "'Artificial Intelligence', 'Latency', 'Performance Optimization' and "
    "'Data Science' do NOT advance 'speculative decoding', 'GPU memory hierarchy' "
    "or 'Bayesian statistics' — sharing a discipline is not teaching the goal. If "
    "someone studying the goal would not count this section as progress, answer "
    "false. When genuinely unsure, answer false: claiming a goal is covered when it "
    "is not is worse than missing one. Return a verdict for EVERY pair."
)


def _cos(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0


def adjudicate(pairs: list[dict], system: str) -> list[Verdict]:
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
            {"role": "system", "content": system},
            {"role": "user", "content": f"Candidate pairs:\n\n{listing}"},
        ],
        text_format=Verdicts,
    )
    if response.output_parsed is None:
        raise RuntimeError("OpenAI returned no adjudication.")
    return response.output_parsed.pairs


def _chunk_by_term(pairs: list[dict]) -> list[list[dict]]:
    """Batch pairs into adjudication calls, never splitting one term's pairs."""
    by_term: dict[str, list[dict]] = {}
    for p in pairs:
        by_term.setdefault(p["topic_eid"], []).append(p)
    groups = list(by_term.values())
    return [
        [p for g in groups[i:i + TERMS_PER_CHUNK] for p in g]
        for i in range(0, len(groups), TERMS_PER_CHUNK)
    ]


async def adjudicate_all(pairs: list[dict], system: str, rel: str) -> list[dict]:
    """Adjudicate chunks concurrently, writing each chunk's edges as it lands.

    Writing per chunk rather than after both passes means an interrupted run (or a
    hard deadline) keeps the resolution it already paid for. MERGE keeps it idempotent.
    """
    if not pairs:
        return []
    chunks = _chunk_by_term(pairs)
    log.info("%s: adjudicating %d pairs in %d chunks (max %d in flight)",
             rel, len(pairs), len(chunks), ADJUDICATE_CONCURRENCY)
    sem = asyncio.Semaphore(ADJUDICATE_CONCURRENCY)

    async def one(ch: list[dict]) -> list[dict]:
        async with sem:
            try:
                res = await asyncio.to_thread(adjudicate, ch, system)
            except Exception as e:
                log.warning("%s: chunk of %d pairs failed: %s", rel, len(ch), e)
                return []
        judged = {(v.video_term.lower(), v.concept.lower()) for v in res}
        # A short response silently reads as "rejected"; say so rather than pretend.
        missing = sum(1 for p in ch
                      if (p["topic_name"].lower(), p["concept_name"].lower()) not in judged)
        if missing:
            log.warning("%s: %d/%d pairs in this chunk got no verdict (treated as no)",
                        rel, missing, len(ch))
        ok = {(v.video_term.lower(), v.concept.lower()) for v in res if v.same}
        got = [p for p in ch
               if (p["topic_name"].lower(), p["concept_name"].lower()) in ok]
        await write_edges(got, rel)
        return got

    confirmed = [p for got in await asyncio.gather(*(one(c) for c in chunks)) for p in got]
    log.info("%s: confirmed %d / %d pairs", rel, len(confirmed), len(pairs))
    return confirmed


async def write_edges(pairs: list[dict], rel: str) -> None:
    # rel is a module-local literal ('SAME_AS' | 'ADVANCES'), never user input —
    # Cypher cannot parameterize relationship types.
    for p in pairs:
        await execute_cypher(
            f"""
            MATCH (x) WHERE elementId(x) = $teid
            MATCH (c) WHERE elementId(c) = $ceid
            MERGE (x)-[r:{rel}]->(c)
            SET r.score = $score
            """,
            {"teid": p["topic_eid"], "ceid": p["concept_eid"], "score": p["score"]},
            collect=False,
        )
        log.info("  %s: '%s' -> '%s' (%.2f)",
                 rel, p["topic_name"], p["concept_name"], p["score"])


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

    # Serially these are minutes of round-trips; the corpus has hundreds of terms.
    sem = asyncio.Semaphore(EMBED_CONCURRENCY)

    async def one(r):
        async with sem:
            try:
                return r, await asyncio.to_thread(tl.embed_text, r["name"])
            except Exception as e:
                log.warning("embed failed for '%s': %s", r["name"], e)
                return r, None

    for r, vec in await asyncio.gather(*(one(r) for r in rows)):
        if vec is None:
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
            RETURN elementId(c) AS eid, c.name AS name, c.status AS status,
                   c.embedding AS emb
            """,
            collect=False,
        )
        goals = [c for c in concepts if c["status"] == "goal"]
        log.info("Comparing %d video terms x %d concepts (%d goals)",
                 len(terms), len(concepts), len(goals))

        same_pairs, goal_pairs = [], []
        for t in terms:
            scored = sorted(
                ((c, _cos(t["emb"], c["emb"])) for c in concepts),
                key=lambda cs: -cs[1],
            )
            same_pairs += [
                {"topic_eid": t["eid"], "topic_name": t["name"],
                 "concept_eid": c["eid"], "concept_name": c["name"], "score": s}
                for c, s in scored[:TOP_K]
            ]
            # Only ~8 goals: judge every (term, goal) pair rather than rank them.
            goal_pairs += [
                {"topic_eid": t["eid"], "topic_name": t["name"],
                 "concept_eid": c["eid"], "concept_name": c["name"],
                 "score": _cos(t["emb"], c["emb"])}
                for c in goals
            ]
        log.info("%d identity candidates (top-%d per term), %d goal candidates",
                 len(same_pairs), TOP_K, len(goal_pairs))
        if not same_pairs and not goal_pairs:
            log.warning("No candidates. Check that embeddings exist on both sides.")
            return

        await asyncio.gather(
            adjudicate_all(same_pairs, SAME_AS_SYSTEM, "SAME_AS"),
            adjudicate_all(goal_pairs, ADVANCES_SYSTEM, "ADVANCES"),
        )
    finally:
        await close_neo4j()


if __name__ == "__main__":
    asyncio.run(main())
