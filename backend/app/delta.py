"""Knowledge-delta logic: what does a video teach that the viewer doesn't know?

The viewer's knowledge state lives in the same graph as the videos:
  (:Concept {key, name, status: 'known'|'goal', source: 'vault'|'video'})
  (:Topic|:Entity)-[:SAME_AS]->(:Concept)    // "same concept" — written by resolve_concepts.py
  (:Topic|:Entity)-[:ADVANCES]->(:Concept)   // "teaches toward this goal" — same script

A video's "learnable" nodes are its Topics plus concept-typed Entities.
Status per learnable node:
  known — SAME_AS a known Concept (skip)
  goal  — ADVANCES a goal Concept (explicitly wants to learn: always watch)
  novel — neither (watch)
The cut list is the merged set of segments mentioning novel/goal concepts.
"""

from __future__ import annotations

from app.config import settings
from app.context_graph_client import execute_cypher

# Topics are always learnable; only conceptual entities are (people/brands are not
# things you "learn" from a talk).
LEARNABLE_ENTITY_TYPES = ["concept", "event", "product"]

# Evidence beats aspiration: a term the viewer demonstrably knows is skippable even when
# it also advances a stated goal — otherwise capture_learning() can never shrink a cut
# list, since Topics are shared across videos and the goal branch would always win.
_LEARNABLE_MATCH = """
MATCH (v:Video {id: $video_id})-[:HAS_SEGMENT]->(s:Segment)-[r:ABOUT|MENTIONS]->(x)
WHERE (x:Topic) OR (x:Entity AND x.type IN $learnable_types)
WITH v, x, collect(DISTINCT s) AS segs
OPTIONAL MATCH (x)-[:SAME_AS]->(k:Concept {status: 'known'})
WITH v, x, segs, collect(DISTINCT k) AS known_c
OPTIONAL MATCH (x)-[:ADVANCES]->(g:Concept {status: 'goal'})
WITH v, x, segs, known_c, collect(DISTINCT g) AS goal_c
WITH v, x, segs, goal_c,
     CASE
       WHEN size(known_c) > 0 THEN 'known'
       WHEN size(goal_c)  > 0 THEN 'goal'
       ELSE 'novel'
     END AS status,
     [c IN known_c + goal_c | c.name][0] AS matched_concept,
     [c IN known_c + goal_c | coalesce(c.note_path, c.video_id)][0] AS matched_source
RETURN v.id AS video_id, v.title AS title, v.duration_sec AS duration_sec,
       x.name AS name, labels(x)[0] AS kind, status, matched_concept, matched_source,
       [c IN goal_c | c.name][0] AS goal_concept,
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
        # A known term can still sit inside a goal; say so rather than silently hiding it.
        if r["status"] == "known" and r.get("goal_concept"):
            entry["goal_note"] = (f"you already know this — and it advances "
                                  f"your goal '{r['goal_concept']}'")
        {"known": known, "novel": novel, "goal": goal}[r["status"]].append(entry)
        if r["status"] in ("novel", "goal"):
            # A goal match is topical, not literal — the viewer asked for "game theory",
            # not for "Nash equilibrium". Name the goal instead of claiming they named it.
            why = (f"advances your goal '{r['goal_concept']}'"
                   if r["status"] == "goal" and r.get("goal_concept")
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

    # Pegasus timestamps are approximate and can overrun the real runtime; without a
    # clamp an 8-minute video reports "watch 12:00 of 8:07" and skip_sec collapses to 0.
    duration = video.get("duration_sec") or 0
    if duration:
        cuts = [c for c in cuts if (c["start_sec"] or 0) < duration]
        for c in cuts:
            c["end_sec"] = min(c["end_sec"] or 0, duration)
    watch_sec = sum(max((c["end_sec"] or 0) - (c["start_sec"] or 0), 0) for c in cuts)
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
    """Mark concepts the viewer just watched as learned: create known Concept nodes
    sourced to the video segments that taught them, plus SAME_AS edges.

    With no explicit names, captures everything the cut list told them to watch.
    Returns the created concepts so the graph panel lights them up.
    """
    delta = await knowledge_delta(title_or_id)
    if "error" in delta:
        return delta
    video_id = delta["video"]["id"]

    wanted = {n.strip().lower() for n in concept_names or [] if n.strip()}
    targets: dict[str, dict] = {}  # key -> target, deduped across cuts
    for cut in delta["cuts"]:
        for con in cut["concepts"]:
            # Goal terms are watched, so watching teaches them too. Capturing them is
            # what lets known beat goal and drop those segments from the next cut list.
            if con["status"] not in ("novel", "goal"):
                continue
            if wanted and con["name"].lower() not in wanted:
                continue
            name = " ".join(con["name"].lower().split())
            # Namespace captured concepts: a bare key would MERGE straight onto a vault
            # note or, worse, onto a learning goal and flip it to 'known' — silently
            # deleting the viewer's stated goal.
            targets.setdefault(f"video:{name}", {
                "name": con["name"], "key": f"video:{name}", "match_key": name,
                "start_sec": cut["start_sec"], "end_sec": cut["end_sec"]})
    targets = list(targets.values())
    if not targets:
        return {"captured": [], "note": "No matching concepts to capture."}

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
        WHERE (x:Topic OR x:Entity) AND toLower(x.name) = t.match_key
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
