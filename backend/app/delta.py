"""Knowledge-delta logic: what does a video teach that the viewer doesn't know?

The viewer's knowledge state lives in the same graph as the videos:
  (:Concept {key, name, status: 'known'|'goal', source: 'vault'|'video'})
  (:Topic|:Entity)-[:SAME_AS]->(:Concept)   // written by scripts/resolve_concepts.py

A video's "learnable" nodes are its Topics plus concept-typed Entities.
Status per learnable node:
  goal  — SAME_AS a goal Concept (explicitly wants to learn: always watch)
  known — SAME_AS a known Concept (skip)
  novel — no SAME_AS match (watch)
The cut list is the merged set of segments mentioning novel/goal concepts.
"""

from __future__ import annotations

from app.config import settings
from app.context_graph_client import execute_cypher

# Topics are always learnable; only conceptual entities are (people/brands are not
# things you "learn" from a talk).
LEARNABLE_ENTITY_TYPES = ["concept", "event", "product"]

_LEARNABLE_MATCH = """
MATCH (v:Video {id: $video_id})-[:HAS_SEGMENT]->(s:Segment)-[r:ABOUT|MENTIONS]->(x)
WHERE (x:Topic) OR (x:Entity AND x.type IN $learnable_types)
OPTIONAL MATCH (x)-[:SAME_AS]->(c:Concept)
WITH v, x, collect(DISTINCT s) AS segs, collect(DISTINCT c) AS matches
WITH v, x, segs,
     CASE
       WHEN any(c IN matches WHERE c.status = 'goal')  THEN 'goal'
       WHEN any(c IN matches WHERE c.status = 'known') THEN 'known'
       ELSE 'novel'
     END AS status,
     [c IN matches WHERE c.status IN ['known','goal'] | c.name][0] AS matched_concept,
     [c IN matches WHERE c.status IN ['known','goal'] | coalesce(c.note_path, c.video_id)][0] AS matched_source
RETURN v.id AS video_id, v.title AS title, v.duration_sec AS duration_sec,
       x.name AS name, labels(x)[0] AS kind, status, matched_concept, matched_source,
       [s IN segs | {id: s.id, idx: s.idx, start_sec: s.start_sec, end_sec: s.end_sec,
                     summary: s.summary}] AS segments
"""


async def find_video(title_or_id: str) -> dict | None:
    """Resolve a video by id or fuzzy title match."""
    rows = await execute_cypher(
        """
        MATCH (v:Video)
        WHERE v.id = $q OR toLower(v.title) CONTAINS toLower($q)
        RETURN v.id AS id, v.title AS title, v.duration_sec AS duration_sec
        ORDER BY size(v.title) LIMIT 1
        """,
        {"q": title_or_id},
        collect=False,
    )
    return rows[0] if rows else None


async def knowledge_delta(title_or_id: str) -> dict:
    """The frozen cut-list contract for one video (see plan / frontend panel)."""
    video = await find_video(title_or_id)
    if not video:
        return {"error": f"No ingested video matches '{title_or_id}'."}

    rows = await execute_cypher(
        _LEARNABLE_MATCH,
        {"video_id": video["id"], "learnable_types": LEARNABLE_ENTITY_TYPES},
        tool_name="knowledge_delta",
    )

    known, novel, goal = [], [], []
    watch_segments: dict[int, dict] = {}  # idx -> segment (+ concepts that put it there)
    for r in rows:
        entry = {"name": r["name"], "status": r["status"], "kind": r["kind"],
                 "matched_concept": r.get("matched_concept"),
                 "source": r.get("matched_source")}
        {"known": known, "novel": novel, "goal": goal}[r["status"]].append(entry)
        if r["status"] in ("novel", "goal"):
            why = ("you asked to learn this" if r["status"] == "goal"
                   else "not in your knowledge base")
            for s in r["segments"]:
                seg = watch_segments.setdefault(
                    s["idx"], {**s, "concepts": []})
                seg["concepts"].append({"name": r["name"], "status": r["status"], "why": why})

    # Merge adjacent watch segments into contiguous cuts.
    cuts = []
    for idx in sorted(watch_segments):
        s = watch_segments[idx]
        if cuts and idx == cuts[-1]["_last_idx"] + 1:
            cuts[-1]["end_sec"] = s["end_sec"]
            cuts[-1]["concepts"].extend(s["concepts"])
            cuts[-1]["_last_idx"] = idx
        else:
            cuts.append({"start_sec": s["start_sec"], "end_sec": s["end_sec"],
                         "summary": s["summary"], "segment_id": s["id"],
                         "concepts": list(s["concepts"]), "_last_idx": idx})
    for c in cuts:
        del c["_last_idx"]
        seen = set()
        c["concepts"] = [x for x in c["concepts"]
                         if not (x["name"] in seen or seen.add(x["name"]))]

    watch_sec = sum((c["end_sec"] or 0) - (c["start_sec"] or 0) for c in cuts)
    duration = video.get("duration_sec") or 0
    return {
        "video": video,
        "stats": {
            "concepts_total": len(known) + len(novel) + len(goal),
            "known": len(known), "novel": len(novel), "goal_hits": len(goal),
            "watch_sec": round(watch_sec), "skip_sec": round(max(duration - watch_sec, 0)),
        },
        "known_concepts": known,
        "cuts": cuts,
    }


async def capture_learning(title_or_id: str, concept_names: list[str] | None = None) -> dict:
    """Mark novel concepts from a video as learned: create known Concept nodes
    sourced to the video segments that taught them, plus SAME_AS edges.

    With no explicit names, captures every novel concept in the video.
    Returns the created concepts so the graph panel lights them up.
    """
    delta = await knowledge_delta(title_or_id)
    if "error" in delta:
        return delta
    video_id = delta["video"]["id"]

    wanted = {n.strip().lower() for n in concept_names or [] if n.strip()}
    targets = []
    for cut in delta["cuts"]:
        for con in cut["concepts"]:
            if con["status"] != "novel":
                continue
            if wanted and con["name"].lower() not in wanted:
                continue
            targets.append({"name": con["name"],
                            "key": " ".join(con["name"].lower().split()),
                            "start_sec": cut["start_sec"], "end_sec": cut["end_sec"]})
    if not targets:
        return {"captured": [], "note": "No matching novel concepts to capture."}

    # Embed each new concept so future resolution passes can match against it.
    from app import twelvelabs_client as tl
    for t in targets:
        try:
            t["embedding"] = tl.embed_text(t["name"])
        except Exception:
            t["embedding"] = None

    rows = await execute_cypher(
        """
        UNWIND $targets AS t
        MERGE (c:Concept {key: t.key})
        ON CREATE SET c.name = t.name, c.status = 'known', c.source = 'video',
                      c.video_id = $video_id, c.start_sec = t.start_sec,
                      c.end_sec = t.end_sec, c.embedding = t.embedding,
                      c.domain = $domain
        SET c.status = 'known'
        WITH c, t
        MATCH (x)
        WHERE (x:Topic OR x:Entity) AND toLower(x.name) = t.key
        MERGE (x)-[:SAME_AS]->(c)
        RETURN DISTINCT c
        """,
        {"targets": targets, "video_id": video_id, "domain": settings.domain_id},
        tool_name="capture_learning",
    )
    return {"captured": [t["name"] for t in targets],
            "source_video": delta["video"]["title"], "nodes": len(rows)}


async def rank_videos() -> list[dict]:
    """Rank all ingested videos by how much novel-to-the-viewer content they hold."""
    vids = await execute_cypher(
        "MATCH (v:Video) RETURN v.id AS id, v.title AS title ORDER BY v.title",
        collect=False,
    )
    ranked = []
    for v in vids:
        d = await knowledge_delta(v["id"])
        if "error" in d:
            continue
        s = d["stats"]
        ranked.append({
            "title": d["video"]["title"], "video_id": v["id"],
            "novel": s["novel"], "goal_hits": s["goal_hits"], "known": s["known"],
            "watch_sec": s["watch_sec"],
            "novelty_score": round((s["novel"] + 2 * s["goal_hits"])
                                   / max(s["concepts_total"], 1), 2),
        })
    ranked.sort(key=lambda r: (r["novelty_score"], r["novel"]), reverse=True)
    return ranked
