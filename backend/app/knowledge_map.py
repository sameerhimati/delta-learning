"""The conceptual knowledge map: what the corpus teaches, against what you know.

The graph panel's default view used to render `/api/schema/visualization` — Neo4j's
index and constraint metadata, i.e. boxes labelled Video → Segment → Entity. That is a
picture of the data model, not of anyone's knowledge, so it says nothing about the one
question this product exists to answer.

This builds the map that does:
  nodes  every concept the corpus actually teaches, coloured by the viewer's relationship
         to it (known / goal / novel), plus the stated goals themselves as hubs
  edges  co-occurrence — two concepts taught in the same segment — so subject areas
         cluster on their own, and ADVANCES edges tying clusters to the goals they serve

Read that map and the delta is visible without reading a single number: dense orange
regions are what you have left to learn, green regions are what you have already got,
and the goal hubs show which clusters you actually care about.
"""

from __future__ import annotations

from app.context_graph_client import execute_cypher

from app.delta import LEARNABLE_ENTITY_TYPES

# Enough to show structure, few enough to stay legible in a force-directed layout.
MAX_TERMS = 90

_TERMS = """
MATCH (x)<-[:ABOUT|MENTIONS]-(s:Segment)<-[:HAS_SEGMENT]-(v:Video)
WHERE (x:Topic) OR (x:Entity AND x.type IN $learnable_types)
OPTIONAL MATCH (x)-[:SAME_AS]->(k:Concept {status: 'known'})
OPTIONAL MATCH (x)-[:ADVANCES]->(g:Concept {status: 'goal'})
WITH x,
     collect(DISTINCT v.title) AS videos,
     count(DISTINCT s) AS segment_count,
     head(collect(DISTINCT k)) AS known_c,
     collect(DISTINCT g.name) AS goals
RETURN elementId(x) AS id, x.name AS name, labels(x)[0] AS kind,
       CASE WHEN known_c IS NOT NULL THEN 'known'
            WHEN size(goals) > 0    THEN 'goal'
            ELSE 'novel' END AS status,
       known_c.name AS matched_concept,
       known_c.note_path AS source,
       goals AS advances_goals,
       videos, segment_count
ORDER BY segment_count DESC, name
LIMIT $limit
"""

# Two concepts taught by the same segment are related in the viewer's terms, whatever the
# ontology says. This edge is not stored anywhere — it is what makes the map cluster.
_EDGES = """
MATCH (a)<-[:ABOUT|MENTIONS]-(s:Segment)-[:ABOUT|MENTIONS]->(b)
WHERE elementId(a) IN $ids AND elementId(b) IN $ids AND elementId(a) < elementId(b)
WITH a, b, count(DISTINCT s) AS weight
RETURN elementId(a) AS source, elementId(b) AS target, weight
ORDER BY weight DESC
"""

_GOALS = """
MATCH (c:Concept {status: 'goal'})
OPTIONAL MATCH (x)-[:ADVANCES]->(c)
WHERE elementId(x) IN $ids
RETURN elementId(c) AS id, c.name AS name, collect(elementId(x)) AS term_ids,
       count(x) AS covered_by
ORDER BY covered_by DESC
"""


_STATE = """
MATCH (c:Concept)
OPTIONAL MATCH (x)-[:SAME_AS|ADVANCES]->(c)
WHERE (x:Topic) OR (x:Entity AND x.type IN $learnable_types)
WITH c, count(DISTINCT x) AS corpus_hits
RETURN c.name AS name, c.status AS status, c.source AS source,
       c.note_path AS note_path, c.video_id AS video_id, corpus_hits
ORDER BY c.status, corpus_hits DESC, c.name
"""


async def knowledge_state() -> dict:
    """Everything the system believes the viewer knows or wants to know, and where it
    came from. Without this the knowledge state is invisible — it lives in vault
    filenames and a YAML file, so there is nowhere to look to check it or argue with it.
    """
    rows = await execute_cypher(
        _STATE, {"learnable_types": LEARNABLE_ENTITY_TYPES}, collect=False
    )

    goals, from_vault, from_video = [], [], []
    for r in rows:
        if r["status"] == "goal":
            goals.append({"name": r["name"], "covered_by": r["corpus_hits"],
                          "covered": r["corpus_hits"] > 0})
        elif r["source"] == "video":
            from_video.append({"name": r["name"], "learned_from": r["video_id"],
                               "corpus_hits": r["corpus_hits"]})
        else:
            from_vault.append({
                "name": r["name"],
                # Show the note, not an absolute path into someone's home directory.
                "note": (r["note_path"] or "").rsplit("/", 1)[-1] or None,
                "corpus_hits": r["corpus_hits"],
            })

    # Most vault notes have nothing to do with this corpus; surfacing the ones that do
    # is what makes the list feel like knowledge rather than a file listing.
    matched = [c for c in from_vault if c["corpus_hits"] > 0]
    return {
        "goals": goals,
        "known": {
            "from_vault": from_vault,
            "from_video": from_video,
            "matched_in_corpus": matched,
        },
        "stats": {
            "goals_total": len(goals),
            "goals_covered": sum(1 for g in goals if g["covered"]),
            "known_from_vault": len(from_vault),
            "known_from_video": len(from_video),
            "vault_relevant_to_corpus": len(matched),
        },
    }


async def knowledge_map(limit: int = MAX_TERMS) -> dict:
    """Concept-level graph of the corpus, coloured by the viewer's knowledge state."""
    terms = await execute_cypher(
        _TERMS,
        {"learnable_types": LEARNABLE_ENTITY_TYPES, "limit": limit},
        collect=False,
    )
    if not terms:
        return {"nodes": [], "edges": [], "stats": {"known": 0, "goal": 0, "novel": 0}}

    ids = [t["id"] for t in terms]
    edges = await execute_cypher(_EDGES, {"ids": ids}, collect=False)
    goals = await execute_cypher(_GOALS, {"ids": ids}, collect=False)

    nodes = [{**t, "type": "concept"} for t in terms]
    # Goal hubs are drawn as their own nodes so clusters visibly hang off what he asked
    # to learn, rather than the goal only existing as a badge on individual terms.
    for g in goals:
        nodes.append({"id": g["id"], "name": g["name"], "kind": "Goal", "status": "goal_hub",
                      "type": "goal", "covered_by": g["covered_by"]})
        edges.extend({"source": tid, "target": g["id"], "weight": 1, "kind": "advances"}
                     for tid in g["term_ids"])

    counts = {"known": 0, "goal": 0, "novel": 0}
    for t in terms:
        counts[t["status"]] += 1
    total = sum(counts.values()) or 1
    return {
        "nodes": nodes,
        "edges": edges,
        "stats": {
            **counts,
            "terms_total": total,
            "goals": len(goals),
            # The headline the map is meant to make obvious at a glance.
            "known_pct": round(100 * counts["known"] / total),
        },
    }
