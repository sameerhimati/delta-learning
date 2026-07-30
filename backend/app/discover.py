"""Outside-corpus recommendations: real videos for goals this library cannot teach.

knowledge_delta answers "what in THIS video is new to me". Its honest failure mode is a
dead end: a viewer states "speculative decoding" as a goal, the corpus has zero ADVANCES
edges into it, and the only truthful answer is "nothing here covers that". That is where
the product currently stops talking.

This closes it. The graph picks the least-covered goals, those goal names become search
queries, and yt-dlp's `ytsearchN:` returns what actually exists on YouTube. So the answer
becomes "nothing here covers that — watch these three instead".

Hallucination is structurally impossible: no model emits a video id or title here. Every
field is transcribed from yt-dlp's JSON, and the URL is CONSTRUCTED from the returned id
rather than copied out of any text. The only thing not from YouTube is the query string,
and that comes from a goal the viewer wrote down. A bad query yields an irrelevant but
REAL video; it can never yield a dead link.
"""

from __future__ import annotations

import asyncio
import json
import math
import re
import shutil
import subprocess
import unicodedata

from app.context_graph_client import execute_cypher

# Measured: a single ytsearch5 returns in 1.4-1.9s, and the whole fan-out runs in
# parallel, so 12s is ~6x headroom while keeping the worst case under the demo's
# patience. yt-dlp with no network exits in 0.5s, so the timeout only fires on a hang.
YTDLP_TIMEOUT = 12

# Bare goal names are already strong queries (measured); the qualifiers exist to widen
# the candidate pool, not to fix the query. Deterministic on purpose — no LLM in the
# path means nothing between the viewer's stated goal and YouTube's result set.
_QUALIFIERS = ["explained", "tutorial deep dive"]

# YouTube search ordering shifts between runs — two identical runs minutes apart
# returned different top-3 sets for the same goal. Cache per goal so the second time
# anyone asks on stage (or the frontend re-renders) the answer is identical and instant.
_CACHE: dict[str, list[dict]] = {}

_UNCOVERED_GOALS = """
MATCH (g:Concept {status: 'goal'})
OPTIONAL MATCH (t)-[:ADVANCES]->(g)
WITH g, count(DISTINCT t) AS coverage, collect(DISTINCT t.name)[0..3] AS corpus_terms
RETURN g.name AS goal, coverage, corpus_terms
ORDER BY coverage ASC, goal
LIMIT $limit
"""

_MATCH_GOAL = """
MATCH (g:Concept {status: 'goal'})
WHERE toLower(g.name) CONTAINS toLower($q) OR toLower($q) CONTAINS toLower(g.name)
OPTIONAL MATCH (t)-[:ADVANCES]->(g)
RETURN g.name AS goal, count(DISTINCT t) AS coverage,
       collect(DISTINCT t.name)[0..3] AS corpus_terms
ORDER BY size(goal)
LIMIT 1
"""

# Fallback when the asked-for topic is not one of the stated goals: measure coverage
# the only other way the graph can — how many learnable terms even mention it.
_FREE_TOPIC = """
MATCH (:Segment)-[:ABOUT|MENTIONS]->(x)
WHERE (x:Topic OR x:Entity) AND toLower(x.name) CONTAINS toLower($q)
RETURN count(DISTINCT x) AS coverage, collect(DISTINCT x.name)[0..3] AS corpus_terms
"""

_INGESTED_TITLES = "MATCH (v:Video) RETURN v.title AS title"

# The graph panel re-renders whatever a tool returns, so light up the goals being filled
# — with their ADVANCES edges, or visibly without any, which IS the gap.
_GOAL_NODES = """
MATCH (c:Concept {status: 'goal'}) WHERE c.name IN $names
OPTIONAL MATCH (t)-[r:ADVANCES]->(c)
RETURN c, r, t
LIMIT 40
"""


def _norm(title: str) -> str:
    """Normalize a title for cross-source comparison.

    NFKC is load-bearing, not decoration: yt-dlp sanitized the ingested filenames with a
    FULLWIDTH COLON (U+FF1A) and underscores, so a plain lowercase compare misses real
    duplicates — `ytsearch5:game theory explained` returns two videos already in the
    corpus and an ASCII compare would recommend the viewer watch what they just watched.
    """
    return re.sub(r"[^a-z0-9]+", " ", unicodedata.normalize("NFKC", title).lower()).strip()


def _queries_for(goal: str) -> list[str]:
    return [goal] + [f"{goal} {q}" for q in _QUALIFIERS]


def _yt_search(query: str, n: int = 5) -> list[dict]:
    """One blocking yt-dlp search. Returns [] on ANY failure — never raises.

    Call via asyncio.to_thread: this spawns a subprocess and would otherwise stall the
    event loop for the whole API.
    """
    try:
        proc = subprocess.run(
            ["yt-dlp", f"ytsearch{n}:{query}", "--dump-json", "--flat-playlist",
             "--no-warnings", "--socket-timeout", "8"],
            capture_output=True, text=True, timeout=YTDLP_TIMEOUT,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return []

    out: list[dict] = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue  # yt-dlp occasionally interleaves non-JSON chatter
        vid, title = d.get("id"), d.get("title")
        if not vid or not title:
            continue  # a record we cannot address is a record we will not recommend
        out.append({
            "video_id": vid,
            "title": title,
            # Built from the id, never copied from text — this is why a link cannot be hallucinated.
            "url": f"https://www.youtube.com/watch?v={vid}",
            "channel": d.get("channel") or d.get("uploader"),
            "duration_sec": d.get("duration"),
            "view_count": d.get("view_count"),
            "query": query,
        })
    return out


def _score(rec: dict, goal: str) -> float:
    """Rank on-topic, teachable-length, audience-validated material."""
    title = _norm(rec["title"])
    goal_tokens = set(_norm(goal).split())
    overlap = len(goal_tokens & set(title.split())) / max(len(goal_tokens), 1)
    duration = rec.get("duration_sec") or 0
    views = rec.get("view_count") or 0
    return round(
        3.0 * overlap
        + (2.0 if _norm(goal) in title else 0.0)
        # 5-40 minutes is a talk or a lecture; outside it is a short or a 4-hour stream.
        + (1.0 if 300 <= duration <= 2400 else 0.3)
        + min(math.log10(views + 10) / 6, 1.0),
        3,
    )


# A goal is "brushed" rather than covered while a handful of terms touch it — below this
# the corpus cannot honestly claim to teach the subject.
_THIN_COVERAGE = 4


def _why(goal: str, coverage: int, corpus_terms: list[str], stated: bool = True) -> str:
    """The sentence a person reads. Every recommendation must say which gap it fills."""
    terms = ", ".join(t for t in corpus_terms if t)
    via = f" ({terms})" if terms else ""
    if not stated:
        # An ad-hoc topic has no ADVANCES edges to count, so coverage here is only "how
        # many terms mention it". Say exactly that rather than implying the stronger claim.
        return (f"no term in your library mentions '{goal}'" if coverage == 0
                else f"your library mentions '{goal}' in {coverage} terms{via}")
    if coverage == 0:
        return f"nothing in your library teaches '{goal}'"
    if coverage < _THIN_COVERAGE:
        return (f"your library only brushes '{goal}' — {coverage} term"
                f"{'' if coverage == 1 else 's'}{via}")
    # Claiming a gap that isn't there would be the same lie in the other direction.
    return (f"your library already covers '{goal}' with {coverage} terms{via}; "
            f"this goes beyond it")


async def _recommend(goal: str, coverage: int, corpus_terms: list[str],
                     ingested: set[str], per_goal: int, stated: bool = True) -> dict:
    """Search, dedupe, rank and cap the recommendations for one goal."""
    queries = _queries_for(goal)
    why = _why(goal, coverage, corpus_terms, stated)

    pool = _CACHE.get(goal)
    if pool is None:
        # All queries in flight at once: 3 sequential searches would cost ~5s, in
        # parallel they cost the slowest one.
        batches = await asyncio.gather(
            *(asyncio.to_thread(_yt_search, q, 5) for q in queries),
            return_exceptions=True,
        )
        pool = [r for b in batches if isinstance(b, list) for r in b]
        for r in pool:
            r["score"] = _score(r, goal)
        pool.sort(key=lambda r: r["score"], reverse=True)
        if pool:
            _CACHE[goal] = pool

    picked: list[dict] = []
    seen_ids: set[str] = set()
    seen_channels: set[str] = set()
    dropped_as_ingested: list[str] = []
    for r in pool:
        # Same id from two queries is real: one video came back from both the
        # speculative-decoding and the KV-cache fan-outs.
        if r["video_id"] in seen_ids:
            continue
        if _norm(r["title"]) in ingested:
            dropped_as_ingested.append(r["title"])
            seen_ids.add(r["video_id"])
            continue
        channel = (r.get("channel") or "").lower()
        # One per channel: a lecture series otherwise fills every slot with itself.
        if channel and channel in seen_channels:
            continue
        seen_ids.add(r["video_id"])
        seen_channels.add(channel)
        picked.append({**r, "fills_gap": why})
        if len(picked) >= per_goal:
            break

    gap = {
        "goal": goal,
        "corpus_coverage": coverage,
        "corpus_terms": [t for t in corpus_terms if t],
        "why": why,
        "queries": queries,
        "recommendations": picked,
    }
    if dropped_as_ingested:
        # Proof the dedupe is doing something, and honest about what was withheld.
        gap["already_in_your_library"] = dropped_as_ingested
    if not picked:
        # yt-dlp returns nothing rather than padding with loose matches, so empty is a
        # real answer and must be said, not papered over.
        gap["note"] = f"No outside videos found for '{goal}'."
    return gap


async def _ingested_titles() -> set[str]:
    rows = await execute_cypher(_INGESTED_TITLES, collect=False)
    return {_norm(r["title"]) for r in rows if r.get("title")}


async def _light_up_goals(names: list[str]) -> None:
    """Best-effort panel render. A failure here must not cost the recommendations."""
    try:
        await execute_cypher(_GOAL_NODES, {"names": names}, tool_name="find_outside_material")
    except Exception:
        pass


def _unavailable(gaps: list[dict]) -> dict:
    return {
        "gaps": gaps,
        "source": "youtube:yt-dlp",
        "error": "yt-dlp is not installed on the server, so outside-corpus search is "
                 "unavailable. The gaps below are still real; install yt-dlp to fill them.",
    }


async def discover_for_goals(max_goals: int = 3, per_goal: int = 3) -> dict:
    """Least-covered stated goals -> real videos outside the ingested corpus."""
    max_goals = max(1, min(int(max_goals), 5))
    per_goal = max(1, min(int(per_goal), 5))
    rows = await execute_cypher(_UNCOVERED_GOALS, {"limit": max_goals}, collect=False)
    if not rows:
        return {"gaps": [], "source": "youtube:yt-dlp",
                "note": "No learning goals are set, so there is no gap to fill."}

    bare = [{"goal": r["goal"], "corpus_coverage": r["coverage"],
             "corpus_terms": r["corpus_terms"], "why": _why(r["goal"], r["coverage"],
                                                            r["corpus_terms"])}
            for r in rows]
    if not shutil.which("yt-dlp"):
        return _unavailable(bare)

    ingested = await _ingested_titles()
    gaps = await asyncio.gather(*(
        _recommend(r["goal"], r["coverage"], r["corpus_terms"], ingested, per_goal)
        for r in rows
    ))
    await _light_up_goals([r["goal"] for r in rows])
    return {"gaps": list(gaps), "source": "youtube:yt-dlp"}


async def discover_for_goal(goal: str, per_goal: int = 3) -> dict:
    """One named topic. Coverage is measured before searching, so the response always
    states what the library does and does not already teach about it."""
    goal = " ".join(goal.split())
    if not goal:
        return await discover_for_goals(per_goal=per_goal)
    per_goal = max(1, min(int(per_goal), 5))

    # Prefer a stated goal so the answer cites the viewer's own words. Falling back to a
    # term scan keeps the coverage number honest for a topic they never declared.
    rows = await execute_cypher(_MATCH_GOAL, {"q": goal}, collect=False)
    stated = bool(rows)
    if stated:
        name, coverage, terms = rows[0]["goal"], rows[0]["coverage"], rows[0]["corpus_terms"]
    else:
        scan = await execute_cypher(_FREE_TOPIC, {"q": goal}, collect=False)
        name, coverage = goal, (scan[0]["coverage"] if scan else 0)
        terms = scan[0]["corpus_terms"] if scan else []

    if not shutil.which("yt-dlp"):
        return _unavailable([{"goal": name, "corpus_coverage": coverage,
                              "corpus_terms": terms,
                              "why": _why(name, coverage, terms, stated)}])

    ingested = await _ingested_titles()
    gap = await _recommend(name, coverage, terms, ingested, per_goal, stated)
    gap["stated_goal"] = stated
    if stated:
        await _light_up_goals([name])
    return {"gaps": [gap], "source": "youtube:yt-dlp"}
