"""A curriculum: the ORDER to go through the corpus, not just what to watch next.

`knowledge_delta` answers "what's new in THIS video". `learning_frontier` answers "which
single term unlocks the most". Neither is a path. A path needs units, an order between
them, and a defensible reason for that order.

THE HONEST PROBLEM
------------------
A curriculum implies prerequisites, and this graph stores none. There is no
(:Term)-[:REQUIRES]->(:Term) edge and nothing to derive one from except three signals,
all of which were measured against the live database before this module was written.

Ground truth used for the test: pairs where one term's name is a strict substring of
another ("Game Theory" must precede "Cooperative Game Theory", "Payoff" before "Payoff
Matrix", "PostgreSQL" before "PostgreSQL 19"). 11 such pairs exist in the corpus.

  signal                                   correct pairs   verdict
  first-teaching time, same video               10 / 10    USED — the ordering spine
  first-teaching time, across videos              0 / 1     rejected for cross-video use
  GDS PageRank over co-occurrence                 7 / 11    REJECTED as prerequisite

PageRank fails the exact test Sameer named: it scores Shapley Value 2.119 above Game
Theory 1.816, i.e. it would teach the specialisation before the field. PageRank measures
how densely a term is discussed, which is a leverage signal (that is what
`learning_frontier` correctly uses it for), not a foundation signal. It is not used here.

First-teaching time works because a speaker builds up in order. Measured inside the
Game Theory talk: Game Theory 0:00 -> Cooperative/Non-Cooperative 0:45 -> Nash
Equilibrium 2:15 -> Coalition 3:00 -> Marginal Contribution + Shapley Value 3:45 ->
Dummy/Interchangeable Player 5:15. Inside the Postgres talk: PostgreSQL 0:00 -> foreign
keys 1:28 -> GIN/JSONB 2:12 -> full-text search 3:40 -> pgvector 5:08 -> MVCC/vacuum
7:20. Those are real syllabi, already ordered, sitting in `start_sec`.

WHAT A UNIT IS
--------------
A unit is a **Louvain community of the segment co-occurrence graph** — a subject area
the corpus organised itself into, with no one labelling it. Measured (stable across 3
runs, identical partition): 15 communities over 148 term nodes, e.g. 31 Postgres terms,
21 core game-theory terms, 9 Shapley/coalition terms, 20 terminal-and-worktree terms.

Communities are near-perfectly video-local (15 of 16 community x video pairs are a
single video); the one that isn't is core game theory, which correctly merges both game
theory talks into ONE unit. So a unit is "a section of a talk", except where two talks
teach the same section, and then it is one unit taught twice. That is exactly what a
curriculum unit should be.

Units are NOT contiguous in time — community 29 is spread over segments 1,4,5,6,16..19,
22,23,24,26,29 of a 45-minute talk. A unit is therefore a set of timecoded ranges, which
is the same shape as a cut list.

HOW UNITS ARE ORDERED
---------------------
Three levels, weakest claim made explicit at each one:

1. TRACKS. Units are grouped by the stated goal most of their terms ADVANCE, and tracks
   run contiguously — finish game theory before starting databases. There is no
   cross-goal prerequisite in this data and inventing one would be a lie. Tracks are
   ordered by how much of the corpus serves the goal (game theory 39 terms, database
   internals 28, context engineering 17), i.e. start where this corpus can take you
   furthest.
2. WITHIN A TRACK: by `depth` = the mean, over the unit's terms, of the earliest point
   in a talk where the term is taught, as a fraction of that talk's runtime. Measured
   on the game theory track this produces: core game theory 0.245 -> rational choice
   0.289 -> Shapley value 0.441 -> repeated games 0.660 -> Tit For Tat / Axelrod 0.854.
   That is the right pedagogical order and nobody hand-wrote it.
3. WITHIN A UNIT: lessons run in the speaker's own order, (video, start_sec).

Where consecutive units come from different talks, the depth comparison is the case that
scored 0/1 in the test above. It is not hidden: those units carry
order_confidence="low" and a reason string saying so.

REMOVING WHAT YOU ALREADY KNOW
------------------------------
Known terms (SAME_AS a known Concept) are not deleted from a unit, they are demoted to
`assumed_known` — the unit still reads coherently because you can see the background it
takes for granted and where you wrote it down. A lesson range is kept only if it teaches
at least one not-yet-known term of that unit; ranges that are pure review are counted in
`review_sec` instead of `watch_sec`. A unit with nothing left to learn drops out of the
path entirely into `completed_units`. That is the thesis, applied to the path: capture
learning, and units disappear from the curriculum.

GOALS THE CORPUS CANNOT TEACH
-----------------------------
Reported, never papered over. Measured right now: speculative decoding 0 terms and GPU
memory hierarchy 0 terms are `uncovered` — no unit is generated and the response says
the corpus cannot teach them; KV-cache optimization (1 term), Bayesian statistics (2) and
RLVR (2) are `thin` — the terms are named inside another unit but there is no unit of
their own, so they are listed as incidental exposure, not as a track.

Everything here is read-only: the GDS projection is a Cypher projection built in memory
under a per-call name and dropped in a finally block; every algorithm uses .stream().
"""

from __future__ import annotations

import re
from uuid import uuid4

from app.context_graph_client import execute_cypher
from app.delta import LEARNABLE_ENTITY_TYPES

# A community this small with no goal attached is noise, not a curriculum unit —
# measured, those are {Vim, Neovim} and {Windows, Bing}. A small community that serves a
# stated goal is kept: {Rational Choice Theory, Optimal Strategy} and {Repeated Game} are
# real game theory, and dropping them would put a hole in the track.
MIN_UNIT_SIZE = 3

# A goal needs this many corpus terms before it earns a track of its own. Below it, the
# corpus mentions the goal in passing but cannot teach it — say that instead of
# generating a one-item "unit" and calling it a curriculum.
MIN_TERMS_FOR_TRACK = 5

_TRACK_UNALIGNED = "no stated goal"


# ---------------------------------------------------------------------------
# Cypher
# ---------------------------------------------------------------------------

# Two terms are related when one segment teaches both; weight = how many segments do.
# That edge is not stored, so this is a GDS Cypher projection built in memory.
_PROJECT = """
MATCH (s:Segment)-[:ABOUT|MENTIONS]->(a)
MATCH (s)-[:ABOUT|MENTIONS]->(b)
WHERE ((a:Topic) OR (a:Entity AND a.type IN $learnable_types))
  AND ((b:Topic) OR (b:Entity AND b.type IN $learnable_types))
  AND elementId(a) < elementId(b)
WITH a, b, count(DISTINCT s) AS w
WITH gds.graph.project($graph, a, b,
  { relationshipProperties: { weight: w } },
  { undirectedRelationshipTypes: ['*'] }) AS g
RETURN g.graphName AS graph, g.nodeCount AS nodes, g.relationshipCount AS rels
"""

_DROP = "CALL gds.graph.drop($graph, false) YIELD graphName RETURN graphName"

# One query does the whole read: community per term, the viewer's relationship to the
# term, and every timecoded place it is taught. `first_pos` is start_sec/duration — the
# only cross-video-comparable form of first-teaching time.
_UNITS = """
CALL gds.louvain.stream($graph, { relationshipWeightProperty: 'weight' })
YIELD nodeId, communityId
WITH communityId, gds.util.asNode(nodeId) AS x
OPTIONAL MATCH (x)-[:SAME_AS]->(k:Concept {status: 'known'})
OPTIONAL MATCH (x)-[:ADVANCES]->(g:Concept {status: 'goal'})
WITH communityId, x,
     head(collect(DISTINCT k)) AS known_c,
     collect(DISTINCT g.name) AS goals
// A concept captured from a video cites the video that taught it, not a note. Without
// this the curriculum says "already in your knowledge base" with no source at all for
// everything the viewer learned HERE — which is most of the knowledge state after a demo.
OPTIONAL MATCH (src:Video {id: known_c.video_id})
MATCH (v:Video)-[:HAS_SEGMENT]->(s:Segment)-[:ABOUT|MENTIONS]->(x)
WITH communityId, x, known_c, goals, src, v, s
ORDER BY v.title, s.idx
RETURN communityId,
       toLower(trim(x.name)) AS key,
       x.name AS name,
       labels(x)[0] AS kind,
       known_c IS NOT NULL AS known,
       known_c.name AS matched_concept,
       known_c.note_path AS note_path,
       src.title AS learned_from,
       goals,
       collect({video_id: v.id, video: v.title, duration_sec: v.duration_sec,
                idx: s.idx, id: s.id, start_sec: s.start_sec, end_sec: s.end_sec,
                summary: s.summary}) AS taught_in
"""

# Stated goals and how much of the corpus can serve them. Counted over distinct term
# NAMES, because ingest MERGEs the same term as both a Topic and an Entity (33 such
# duplicates measured) and counting nodes would double every number.
_GOALS = """
MATCH (g:Concept {status: 'goal'})
OPTIONAL MATCH (x)-[:ADVANCES]->(g)
WHERE (x:Topic) OR (x:Entity AND x.type IN $learnable_types)
RETURN g.name AS goal,
       count(DISTINCT toLower(trim(x.name))) AS corpus_terms,
       collect(DISTINCT x.name)[0..6] AS sample
ORDER BY corpus_terms DESC, goal
"""

_CORPUS = """
MATCH (v:Video)
RETURN count(v) AS videos, sum(coalesce(v.duration_sec, 0)) AS corpus_sec
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "unit"


def _dedup_terms(rows: list[dict]) -> list[dict]:
    """One name is one concept.

    Ingest MERGEs terms under two labels, so 33 names exist as both a Topic and an
    Entity. Louvain sees two nodes and can put them in two different communities
    ("Coalition" lands in both the core game-theory and the Shapley community). Keep the
    copy taught by the most segments — that is the one carrying the real structure — and
    union everything else onto it so no timecode is lost.
    """
    merged: dict[str, dict] = {}
    for r in rows:
        prev = merged.get(r["key"])
        if prev is None:
            merged[r["key"]] = dict(r)
            continue
        loser, winner = (prev, dict(r)) if len(r["taught_in"]) > len(prev["taught_in"]) else (dict(r), prev)
        winner["taught_in"] = winner["taught_in"] + loser["taught_in"]
        winner["known"] = winner["known"] or loser["known"]
        winner["matched_concept"] = winner.get("matched_concept") or loser.get("matched_concept")
        winner["note_path"] = winner.get("note_path") or loser.get("note_path")
        winner["learned_from"] = winner.get("learned_from") or loser.get("learned_from")
        winner["goals"] = list(dict.fromkeys((winner.get("goals") or []) + (loser.get("goals") or [])))
        merged[r["key"]] = winner
    for r in merged.values():
        seen: set[tuple] = set()
        keep = []
        for t in r["taught_in"]:
            sig = (t["video_id"], t["idx"])
            if sig in seen:
                continue
            seen.add(sig)
            keep.append(t)
        r["taught_in"] = sorted(keep, key=lambda t: (t["video"], t["idx"]))
    return list(merged.values())


def _first_pos(term: dict) -> float:
    """Earliest point a talk introduces this term, as a fraction of that talk's runtime.

    Seconds are not comparable across videos (0:45 of a 10-minute talk is a different
    place in the argument than 0:45 of a 45-minute one), and the one cross-video
    prerequisite pair in the corpus is exactly where raw seconds got the order wrong.
    Fraction-of-runtime is the comparable form; it is still the weaker case, which is why
    cross-video adjacency is flagged rather than trusted.
    """
    best = 1.0
    for t in term["taught_in"]:
        dur = t.get("duration_sec") or 0
        if not dur:
            continue
        best = min(best, max((t.get("start_sec") or 0) / dur, 0.0))
    return best


def _first_taught(term: dict) -> dict | None:
    if not term["taught_in"]:
        return None
    t = min(term["taught_in"], key=lambda t: (_pos_of(t), t["video"]))
    return {"video": t["video"], "video_id": t["video_id"],
            "start_sec": round(t.get("start_sec") or 0)}


def _pos_of(t: dict) -> float:
    dur = t.get("duration_sec") or 0
    return (t.get("start_sec") or 0) / dur if dur else 1.0


def _lessons(terms: list[dict], learn_keys: set[str]) -> tuple[list[dict], float]:
    """Turn a unit's terms into timecoded ranges, merging adjacent segments per video.

    A range earns a place only if it teaches something the viewer does not already know.
    Ranges that carry only `assumed_known` terms are returned separately as review time,
    so removing what you know shortens the watch without hiding that the material is
    there.
    """
    by_seg: dict[tuple, dict] = {}
    for term in terms:
        for t in term["taught_in"]:
            seg = by_seg.setdefault(
                (t["video_id"], t["idx"]),
                {"video": t["video"], "video_id": t["video_id"], "segment_id": t["id"],
                 "idx": t["idx"], "start_sec": t.get("start_sec") or 0,
                 "end_sec": t.get("end_sec") or 0, "duration_sec": t.get("duration_sec") or 0,
                 "summary": t.get("summary"), "teaches": [], "review": []},
            )
            (seg["teaches"] if term["key"] in learn_keys else seg["review"]).append(term["name"])

    review_sec = 0.0
    keep = [s for s in by_seg.values() if s["teaches"]]
    for s in by_seg.values():
        if not s["teaches"]:
            review_sec += max(s["end_sec"] - s["start_sec"], 0)

    out: list[dict] = []
    for s in sorted(keep, key=lambda s: (s["video"], s["idx"])):
        prev = out[-1] if out else None
        if prev and prev["video_id"] == s["video_id"] and s["idx"] == prev["_last_idx"] + 1:
            prev["end_sec"] = s["end_sec"]
            prev["teaches"].extend(s["teaches"])
            prev["_last_idx"] = s["idx"]
        else:
            out.append({"video": s["video"], "video_id": s["video_id"],
                        "segment_id": s["segment_id"], "start_sec": s["start_sec"],
                        "end_sec": s["end_sec"], "summary": s["summary"],
                        "teaches": list(s["teaches"]), "_last_idx": s["idx"],
                        "_dur": s["duration_sec"]})
    for lesson in out:
        del lesson["_last_idx"]
        # Pegasus timestamps can overrun the true runtime; the same clamp delta.py uses.
        dur = lesson.pop("_dur") or 0
        if dur:
            lesson["end_sec"] = min(lesson["end_sec"], dur)
        lesson["start_sec"] = round(lesson["start_sec"])
        lesson["end_sec"] = round(max(lesson["end_sec"], lesson["start_sec"]))
        lesson["teaches"] = list(dict.fromkeys(lesson["teaches"]))
    return out, review_sec


def _dominant_goal(terms: list[dict]) -> tuple[str | None, float, dict[str, int]]:
    counts: dict[str, int] = {}
    for t in terms:
        for g in t.get("goals") or []:
            counts[g] = counts.get(g, 0) + 1
    if not counts:
        return None, 0.0, {}
    goal = max(counts, key=lambda g: (counts[g], -len(g)))
    return goal, round(counts[goal] / len(terms), 2), counts


def _title(terms: list[dict], goal: str | None) -> str:
    """Name the unit from its own most-connected terms — no LLM, so it is deterministic
    and cannot invent a topic the unit does not contain."""
    ranked = sorted(terms, key=lambda t: (-len(t["taught_in"]), _first_pos(t), t["name"]))
    names = [t["name"] for t in ranked]
    if goal:
        # "Game Theory: Prisoner's Dilemma & Game Theory" reads as a bug. Drop head terms
        # that restate the track name, unless that would leave the unit unnamed.
        g = goal.lower()
        distinct = [n for n in names if n.lower() not in g and g not in n.lower()]
        names = distinct or names
    label = " & ".join(names[:2])
    return f"{goal.title()}: {label}" if goal else label


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def coverage_report() -> dict:
    """Per stated goal: can this corpus teach it at all?

    Separate from `build_curriculum` so the agent can answer "can you teach me
    speculative decoding?" honestly without building a whole path first.
    """
    rows = await execute_cypher(
        _GOALS, {"learnable_types": LEARNABLE_ENTITY_TYPES}, collect=False
    )
    corpus = await execute_cypher(_CORPUS, collect=False)
    videos = corpus[0]["videos"] if corpus else 0

    goals = []
    for r in rows:
        n = r["corpus_terms"]
        if n == 0:
            verdict, msg = "uncovered", (
                f"Nothing in the {videos} ingested videos teaches this. "
                f"No unit can be generated — ingest a talk that covers it."
            )
        elif n < MIN_TERMS_FOR_TRACK:
            verdict, msg = "thin", (
                f"Only {n} term(s) in the corpus touch this, mentioned inside other "
                f"units rather than taught as a subject. Incidental exposure, not a track."
            )
        else:
            verdict, msg = "covered", f"{n} terms across the corpus serve this goal."
        goals.append({"goal": r["goal"], "corpus_terms": n, "verdict": verdict,
                      "sample_terms": r["sample"], "message": msg})
    return {
        "goals": goals,
        "stats": {
            "goals_total": len(goals),
            "covered": sum(1 for g in goals if g["verdict"] == "covered"),
            "thin": sum(1 for g in goals if g["verdict"] == "thin"),
            "uncovered": sum(1 for g in goals if g["verdict"] == "uncovered"),
            "videos": videos,
        },
    }


async def build_curriculum(goal: str | None = None, max_units: int = 12) -> dict:
    """The ordered path through the corpus, minus what the viewer already knows.

    goal      restrict to one stated goal (fuzzy, case-insensitive substring). None =
              every track, tracks running in order of how much corpus serves them.
    max_units how many units to return in `units`; the rest stay counted in stats.
    """
    graph = f"curriculum_{uuid4().hex[:8]}"
    params = {"learnable_types": LEARNABLE_ENTITY_TYPES, "graph": graph}
    try:
        # An aggregating projection over zero co-occurrence pairs returns zero rows and
        # never creates the graph, so Louvain would then fail on a missing graph name and
        # 500 the route. An un-ingested corpus is a legitimate state, not an error.
        projection = await execute_cypher(_PROJECT, params, collect=False)
        rows = (await execute_cypher(_UNITS, {"graph": graph}, collect=False)
                if projection else [])
    finally:
        try:
            await execute_cypher(_DROP, {"graph": graph}, collect=False)
        except Exception:  # noqa: BLE001 — a leaked in-memory projection must not 500
            pass

    terms = _dedup_terms(rows)
    coverage = await coverage_report()
    goal_terms = {g["goal"]: g["corpus_terms"] for g in coverage["goals"]}
    corpus = await execute_cypher(_CORPUS, collect=False)
    corpus_sec = round(corpus[0]["corpus_sec"]) if corpus else 0

    by_community: dict[int, list[dict]] = {}
    for t in terms:
        by_community.setdefault(t["communityId"], []).append(t)

    units, completed, fringe = [], [], []
    for cid, members in by_community.items():
        dom_goal, share, goal_counts = _dominant_goal(members)
        # Only a goal the corpus can actually serve gets to name a track; a unit whose
        # only goal link is one of the `thin` goals is not a track, it is incidental.
        track_goal = dom_goal if goal_terms.get(dom_goal or "", 0) >= MIN_TERMS_FOR_TRACK else None

        known = [t for t in members if t["known"]]
        learn = [t for t in members if not t["known"]]
        learn_keys = {t["key"] for t in learn}
        lessons, review_sec = _lessons(members, learn_keys)
        watch_sec = sum(max(l["end_sec"] - l["start_sec"], 0) for l in lessons)
        videos = sorted({t["video"] for m in members for t in m["taught_in"]})

        unit = {
            "unit_id": f"{_slug(_title(members, track_goal))}-{cid}",
            "community_id": cid,
            "title": _title(members, track_goal),
            "track": track_goal or _TRACK_UNALIGNED,
            "serves_goal": track_goal,
            "goal_share": share if track_goal else 0.0,
            "other_goals": {g: n for g, n in goal_counts.items() if g != track_goal},
            "depth": round(sum(_first_pos(t) for t in members) / len(members), 3),
            "size": len(members),
            "to_learn": len(learn),
            "known": len(known),
            "known_pct": round(100 * len(known) / len(members)),
            "videos": videos,
            "watch_sec": round(watch_sec),
            "review_sec": round(review_sec),
            "concepts": [
                {"name": t["name"], "kind": t["kind"],
                 "status": "goal" if (t.get("goals") or []) else "novel",
                 "advances": (t.get("goals") or [None])[0],
                 "first_taught": _first_taught(t)}
                for t in sorted(learn, key=lambda t: (_first_pos(t), t["name"]))
            ],
            "assumed_known": [
                {"name": t["name"], "matched_concept": t.get("matched_concept"),
                 # A note filename for a vault concept, the video title for a captured
                 # one — never an absolute path or a raw video id.
                 "source": ((t.get("note_path") or "").rsplit("/", 1)[-1]
                            or t.get("learned_from")),
                 "source_kind": "note" if t.get("note_path") else (
                     "video" if t.get("learned_from") else None),
                 "why": (f"you learned this from {t['learned_from']} — shown as "
                         f"background, not scheduled") if t.get("learned_from") else
                        "already in your knowledge base — shown as background, not scheduled"}
                for t in sorted(known, key=lambda t: t["name"])
            ],
            "lessons": lessons,
        }

        if unit["to_learn"] == 0:
            unit["why"] = f"you already know all {unit['size']} concepts in this unit"
            completed.append(unit)
        elif unit["size"] < MIN_UNIT_SIZE and not track_goal:
            unit["why"] = (
                f"only {unit['size']} terms and no stated goal — too small to be a unit, "
                f"kept here so nothing is silently dropped"
            )
            fringe.append(unit)
        else:
            units.append(unit)

    if goal:
        needle = goal.strip().lower()
        units = [u for u in units if u["serves_goal"] and needle in u["serves_goal"].lower()]
        completed = [u for u in completed if u["serves_goal"] and needle in u["serves_goal"].lower()]
        # A fringe unit has no goal by construction, so under a goal filter it is not a
        # thing that was dropped from THIS path — listing it reads as an unrelated gap.
        fringe = []

    # Track order: the goal this corpus can take you furthest on first. There is no
    # prerequisite between goals in this data, so this is a coverage claim, not a
    # pedagogical one, and the response says so in `method`.
    def _track_rank(u: dict) -> tuple:
        return (-goal_terms.get(u["serves_goal"] or "", -1), u["track"], u["depth"])

    units.sort(key=_track_rank)

    prev = None
    for i, u in enumerate(units, start=1):
        u["order"] = i
        same_track = prev is not None and prev["track"] == u["track"]
        shared_video = same_track and bool(set(prev["videos"]) & set(u["videos"]))
        if not same_track:
            u["order_confidence"] = "track"
            u["why_here"] = (
                f"starts the '{u['track']}' track — "
                f"{goal_terms.get(u['serves_goal'] or '', 0)} corpus terms serve this goal"
                if u["serves_goal"] else
                "no stated goal — scheduled after every goal-aligned track"
            )
        elif shared_video:
            u["order_confidence"] = "high"
            u["why_here"] = (
                f"introduced {round(u['depth'] * 100)}% into its talk, after "
                f"'{prev['title']}' at {round(prev['depth'] * 100)}% — same talk, so this "
                f"is the speaker's own build-up order (10/10 on the prerequisite test)"
            )
        else:
            u["order_confidence"] = "low"
            u["why_here"] = (
                f"introduced {round(u['depth'] * 100)}% into its talk vs "
                f"{round(prev['depth'] * 100)}% for '{prev['title']}', but they are "
                f"different talks — comparing position across talks is the weak case "
                f"(0/1 on the prerequisite test). Treat as a suggestion."
            )
        prev = u

    # Units share segments — one segment can teach terms from three communities, so
    # summing unit watch times overcounts and can exceed the corpus runtime. Union the
    # ranges per video for the number a human is actually promised.
    spans: dict[str, list[tuple[float, float]]] = {}
    for u in units:
        for lesson in u["lessons"]:
            spans.setdefault(lesson["video_id"], []).append(
                (lesson["start_sec"], lesson["end_sec"])
            )
    watch_unique = 0.0
    for ranges in spans.values():
        cur_start, cur_end = None, None
        for start, end in sorted(ranges):
            if cur_end is None or start > cur_end:
                watch_unique += (cur_end - cur_start) if cur_end is not None else 0
                cur_start, cur_end = start, end
            else:
                cur_end = max(cur_end, end)
        if cur_end is not None:
            watch_unique += cur_end - cur_start

    completed.sort(key=lambda u: u["depth"])
    fringe.sort(key=lambda u: -u["size"])
    shown = units[: max(1, int(max_units))]

    # Asking for a path to something the corpus cannot teach must fail loudly, not
    # return an empty list that reads like a bug.
    message = None
    if goal and not units:
        hit = next((g for g in coverage["goals"]
                    if goal.strip().lower() in g["goal"].lower()), None)
        message = (
            f"No curriculum for '{goal}'. {hit['message']}" if hit else
            f"No stated goal matches '{goal}'. Known goals: "
            + ", ".join(g["goal"] for g in coverage["goals"])
        )
    elif not terms:
        message = ("No curriculum yet — nothing ingested carries a learnable term. "
                   "Run the ingest and resolve passes first.")
    elif not units:
        # Not a bug and not an empty state: the whole corpus has been retired into
        # completed_units. That is the thesis reaching its end point.
        message = (f"Nothing left to schedule — you already know all {len(terms)} terms "
                   f"this corpus teaches. Ingest something new.")

    return {
        "goal_filter": goal,
        "message": message,
        "method": {
            "unit": "Louvain community of the segment co-occurrence graph (GDS, "
                    "in-memory Cypher projection, stable across repeated runs)",
            "unit_order": "mean normalized first-teaching position of the unit's terms "
                          "(start_sec / video duration)",
            "track_order": "corpus coverage of the stated goal — not a prerequisite "
                           "claim; no cross-goal ordering exists in this graph",
            "lesson_order": "the speaker's own order (video, start_sec)",
            "rejected": "GDS PageRank — scores Shapley Value 2.119 above Game Theory "
                        "1.816, so it would teach the specialisation before the field. "
                        "It ranks leverage, not foundation.",
            "projection": projection[0] if projection else {},
        },
        "stats": {
            "units": len(units),
            "units_shown": len(shown),
            "completed_units": len(completed),
            "fringe_units": len(fringe),
            "terms_total": len(terms),
            "known": sum(1 for t in terms if t["known"]),
            "to_learn": sum(1 for t in terms if not t["known"]),
            # Sum of the units' own watch times — a unit can revisit a range another
            # unit also uses, so this is "time spent per unit", not wall-clock.
            "watch_sec": sum(u["watch_sec"] for u in units),
            # Wall-clock: the union of every scheduled range. This is the honest
            # "watch X of Y" number, and it is what shrinks as you capture learning.
            "watch_sec_unique": round(watch_unique),
            "review_sec": sum(u["review_sec"] for u in units),
            "corpus_sec": corpus_sec,
            "tracks": list(dict.fromkeys(u["track"] for u in units)),
        },
        "units": shown,
        # Units the knowledge state already retired. Empty today; every capture moves a
        # unit here, which is the path getting shorter because the viewer changed.
        "completed_units": [
            {k: u[k] for k in ("unit_id", "title", "track", "size", "known_pct", "why")}
            for u in completed
        ],
        "fringe_units": [
            {k: u[k] for k in ("unit_id", "title", "size", "videos", "why")}
            for u in fringe
        ],
        # Never papered over: goals this corpus cannot take the viewer to.
        "gaps": [g for g in coverage["goals"] if g["verdict"] != "covered"],
    }
