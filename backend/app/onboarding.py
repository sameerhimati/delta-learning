"""Bootstrap a knowledge state by asking, instead of by reading someone's filenames.

The system's biggest weakness, stated plainly in the README: a vault is evidence of what
someone WROTE DOWN, not of what they KNOW. Someone can understand Nash equilibria
perfectly and never have made a note about them. So a fresh knowledge state overlaps a
corpus barely at all, every video reads "watch 100%", and the product's whole claim —
that it shows you only what you don't know — is invisible on first run.

`quiz_me` was the right instinct but it is per-video and reactive: you have to already be
looking at a video for it to help, and it only tests what that one video teaches. This
walks the whole corpus instead, highest-leverage terms first, and writes what the person
can actually demonstrate.

Which terms are highest-leverage is not a guess. The corpus already has a co-occurrence
graph, so GDS PageRank over the terms nobody has claimed yet ranks them by how much other
unknown material they unlock — knowing "PostgreSQL" explains more of a database talk than
knowing one isolated feature of it. Asking in that order means 15 questions move the
knowledge state further than 50 asked alphabetically.

Adaptivity is a property of the projection, not of a scoring rule: the frontier excludes
anything already SAME_AS a known Concept, so every round is recomputed against what was
just proven. Answer "Nash Equilibrium" correctly and the next round stops offering the
terms it dominates. Callers get this by asking for small batches in a loop rather than
all 15 at once.

Captured concepts are keyed `quiz:<name>` and carry source='quiz'. A bare key would MERGE
onto a vault note or, worse, onto a learning goal and flip it to 'known' — silently
deleting the thing the viewer said they wanted to learn. Same reasoning as the `video:`
namespace in delta.capture_learning.

Requires an OpenAI key: questions are generated and graded by the model. There is
deliberately no "tick the things you know" fallback — self-report is exactly the evidence
this module exists to replace.
"""

from __future__ import annotations

import asyncio
import logging

from app.config import settings
from app.context_graph_client import execute_cypher
from app.delta import (
    GRADE_SYSTEM,
    LEARNABLE_ENTITY_TYPES,
    QUIZ_SYSTEM,
    _Grades,
    _Quiz,
)

log = logging.getLogger(__name__)

FRONTIER_GRAPH_NAME = "delta_frontier"

FRONTIER_DROP = (
    f"CALL gds.graph.drop('{FRONTIER_GRAPH_NAME}', false) YIELD graphName RETURN graphName"
)

# Terms co-occur when a segment teaches both. Restricted to what nobody has claimed yet,
# so PageRank ranks leverage over UNKNOWN material rather than over the corpus at large.
FRONTIER_PROJECT = f"""
MATCH (s:Segment)-[:ABOUT|MENTIONS]->(a)
MATCH (s)-[:ABOUT|MENTIONS]->(b)
WHERE ((a:Topic) OR (a:Entity AND a.type IN $learnable_types))
  AND ((b:Topic) OR (b:Entity AND b.type IN $learnable_types))
  AND coalesce(a.learnable, true) AND coalesce(b.learnable, true)
  AND elementId(a) < elementId(b)
  AND NOT (a)-[:SAME_AS]->(:Concept {{status: 'known'}})
  AND NOT (b)-[:SAME_AS]->(:Concept {{status: 'known'}})
WITH a, b, count(DISTINCT s) AS w
WITH gds.graph.project('{FRONTIER_GRAPH_NAME}', a, b,
  {{relationshipProperties: {{weight: w}}}}, {{undirectedRelationshipTypes: ['*']}}) AS g
RETURN g.nodeCount AS nodes, g.relationshipCount AS rels
"""

FRONTIER_RANK = """
CALL gds.pageRank.stream($graph_name, {relationshipWeightProperty: 'weight'})
YIELD nodeId, score
WITH gds.util.asNode(nodeId) AS x, score
MATCH (v:Video)-[:HAS_SEGMENT]->(s:Segment)-[:ABOUT|MENTIONS]->(x)
OPTIONAL MATCH (x)-[:ADVANCES]->(g:Concept {status: 'goal'})
WITH x.name AS term, max(score) AS pagerank, collect(DISTINCT g.name) AS goals,
     count(DISTINCT v) AS video_count, count(DISTINCT s) AS segment_count,
     collect(DISTINCT {video: v.title, start_sec: s.start_sec, end_sec: s.end_sec})[0..2]
       AS where_taught
RETURN term, round(pagerank, 3) AS pagerank,
       CASE WHEN size(goals) > 0 THEN 'goal' ELSE 'novel' END AS status,
       goals[0] AS serves_goal, video_count, segment_count, where_taught
ORDER BY pagerank DESC LIMIT $limit
"""

# Fallback when GDS is unavailable — Aura's free tier and a plain neo4j image both lack
# it. Ranking by how many segments teach a term is a cruder leverage signal than
# PageRank, but it is the same idea and it keeps onboarding working instead of 500ing.
FRONTIER_RANK_NO_GDS = """
MATCH (v:Video)-[:HAS_SEGMENT]->(s:Segment)-[:ABOUT|MENTIONS]->(x)
WHERE ((x:Topic) OR (x:Entity AND x.type IN $learnable_types))
  AND coalesce(x.learnable, true)
  AND NOT (x)-[:SAME_AS]->(:Concept {status: 'known'})
OPTIONAL MATCH (x)-[:ADVANCES]->(g:Concept {status: 'goal'})
WITH x.name AS term, collect(DISTINCT g.name) AS goals,
     count(DISTINCT v) AS video_count, count(DISTINCT s) AS segment_count,
     collect(DISTINCT {video: v.title, start_sec: s.start_sec, end_sec: s.end_sec})[0..2]
       AS where_taught
RETURN term, toFloat(segment_count) AS pagerank,
       CASE WHEN size(goals) > 0 THEN 'goal' ELSE 'novel' END AS status,
       goals[0] AS serves_goal, video_count, segment_count, where_taught
ORDER BY segment_count DESC, term ASC LIMIT $limit
"""

PROGRESS = """
MATCH (s:Segment)-[:ABOUT|MENTIONS]->(x)
WHERE ((x:Topic) OR (x:Entity AND x.type IN $learnable_types))
  AND coalesce(x.learnable, true)
WITH DISTINCT x
OPTIONAL MATCH (x)-[:SAME_AS]->(k:Concept {status: 'known'})
RETURN count(x) AS learnable_terms, count(k) AS known_terms
"""


async def frontier(limit: int = 5) -> tuple[list[dict], bool]:
    """Highest-leverage terms the viewer has not claimed. Returns (terms, used_gds)."""
    params = {"learnable_types": LEARNABLE_ENTITY_TYPES}
    try:
        await execute_cypher(FRONTIER_DROP, collect=False)
        await execute_cypher(FRONTIER_PROJECT, params, collect=False)
        rows = await execute_cypher(
            FRONTIER_RANK,
            {"graph_name": FRONTIER_GRAPH_NAME, "limit": limit},
            collect=False,
        )
        await execute_cypher(FRONTIER_DROP, collect=False)
        return rows, True
    except Exception as e:
        log.info("GDS frontier unavailable (%s); ranking by segment coverage instead", e)
        rows = await execute_cypher(
            FRONTIER_RANK_NO_GDS, {**params, "limit": limit}, collect=False
        )
        return rows, False


async def progress() -> dict:
    rows = await execute_cypher(PROGRESS, {"learnable_types": LEARNABLE_ENTITY_TYPES},
                                collect=False)
    row = rows[0] if rows else {"learnable_terms": 0, "known_terms": 0}
    total, known = row["learnable_terms"], row["known_terms"]
    return {"learnable_terms": total, "known_terms": known,
            "unknown_terms": max(0, total - known),
            "known_pct": round(100 * known / total, 1) if total else 0.0}


async def onboarding_questions(count: int = 5) -> dict:
    """Ask about the highest-leverage terms nobody has claimed yet.

    Batches are meant to be small and repeated: the frontier is recomputed each call
    against what has just been proven, which is where the adaptivity comes from.
    """
    if not settings.openai_api_key:
        return {"error": "Onboarding needs an OPENAI_API_KEY — questions are generated "
                         "and graded by the model. Self-reporting what you know is the "
                         "thing this replaces, so there is no offline mode."}

    count = max(1, min(int(count), 10))
    terms, used_gds = await frontier(count)
    if not terms:
        state = await progress()
        return {"questions": [], "progress": state,
                "note": "Nothing left on the frontier — every term in this corpus is "
                        "already linked to something you know."}

    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key or None)
    listing = "\n".join(f"- {t['term']}" for t in terms)
    response = await asyncio.to_thread(
        lambda: client.responses.parse(
            model=settings.openai_extraction_model,
            reasoning={"effort": settings.openai_reasoning_effort},
            input=[
                {"role": "system", "content": QUIZ_SYSTEM},
                {"role": "user", "content": "These are concepts taught across a video "
                                            f"library:\n\n{listing}"},
            ],
            text_format=_Quiz,
        )
    )
    if response.output_parsed is None:
        return {"error": "Question generation returned nothing."}

    # Trust the graph for leverage and provenance, the model only for wording.
    by_name = {t["term"].lower(): t for t in terms}
    questions = []
    for q in response.output_parsed.questions:
        t = by_name.get(q.concept.lower())
        if not t:
            continue
        questions.append({
            "concept": t["term"], "question": q.question, "answer_key": q.answer_key,
            "status": t["status"], "serves_goal": t.get("serves_goal"),
            "leverage": t.get("pagerank"), "taught_in": t.get("video_count"),
            "where_taught": t.get("where_taught"),
        })
    return {"questions": questions, "progress": await progress(),
            "ranked_by": "gds_pagerank" if used_gds else "segment_coverage"}


async def grade_onboarding(answers: list[dict]) -> dict:
    """Grade answers and record ONLY what was demonstrated, as source='quiz' Concepts."""
    if not settings.openai_api_key:
        return {"error": "Grading needs an OPENAI_API_KEY."}

    submitted = [{"concept": str(a.get("concept", "")).strip(),
                  "answer": str(a.get("answer", "")).strip()}
                 for a in answers if str(a.get("concept", "")).strip()]
    if not submitted:
        return {"error": "No answers submitted."}

    from openai import OpenAI

    def _call() -> _Grades:
        client = OpenAI(api_key=settings.openai_api_key or None)
        listing = "\n".join(
            f'- concept: "{a["concept"]}"\n  answer: "{a["answer"] or "(no answer given)"}"'
            for a in submitted
        )
        r = client.responses.parse(
            model=settings.openai_extraction_model,
            reasoning={"effort": settings.openai_reasoning_effort},
            input=[{"role": "system", "content": GRADE_SYSTEM},
                   {"role": "user", "content": f"Grade these answers:\n\n{listing}"}],
            text_format=_Grades,
        )
        if r.output_parsed is None:
            raise RuntimeError("OpenAI returned no grades.")
        return r.output_parsed

    graded = (await asyncio.to_thread(_call)).grades
    by_name = {g.concept.strip().lower(): g for g in graded}

    passed, failed = [], []
    for a in submitted:
        g = by_name.get(a["concept"].lower())
        # An ungraded answer is an unproven one, so it is not captured.
        entry = {"concept": a["concept"],
                 "verdict": g.verdict if g else "Not graded, so left unproven."}
        (passed if (g and g.correct) else failed).append(entry)

    captured = []
    if passed:
        targets = [{"key": f"quiz:{' '.join(p['concept'].lower().split())}",
                    "name": p["concept"],
                    "match_key": " ".join(p["concept"].lower().split())}
                   for p in passed]
        # Best-effort embedding so later resolution passes can match these; the demo
        # graph runs without a TwelveLabs key and must not fail here.
        from app import twelvelabs_client as tl
        for t in targets:
            try:
                t["embedding"] = tl.embed_text(t["name"])
            except Exception:
                t["embedding"] = None
        await execute_cypher(
            """
            UNWIND $targets AS t
            MERGE (c:Concept {key: t.key})
            ON CREATE SET c.name = t.name, c.source = 'quiz',
                          c.embedding = t.embedding, c.domain = $domain
            SET c.status = 'known'
            WITH c, t
            MATCH (x)
            WHERE (x:Topic OR x:Entity) AND toLower(x.name) = t.match_key
            MERGE (x)-[:SAME_AS]->(c)
            RETURN DISTINCT c
            """,
            {"targets": targets, "domain": settings.domain_id},
            tool_name="grade_onboarding",
        )
        captured = [t["name"] for t in targets]

    state = await progress()
    return {
        "passed": passed,
        "failed": failed,
        "captured": captured,
        "progress": state,
        "summary": (f"{len(passed)} of {len(submitted)} demonstrated. "
                    f"You now account for {state['known_pct']}% of what this corpus "
                    f"teaches."),
    }
