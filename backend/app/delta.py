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
The cut list is the set of segments whose novelty *density* clears
MIN_NOVELTY_DENSITY, merged where adjacent. Segments that carry something new but
fail the density test are reported separately under "skipped" so nothing is hidden.
"""

from __future__ import annotations

import asyncio
import re

from pydantic import BaseModel

from app.config import settings
from app.context_graph_client import execute_cypher

# Topics are always learnable; only conceptual entities are (people/brands are not
# things you "learn" from a talk).
LEARNABLE_ENTITY_TYPES = ["concept", "event", "product"]

# Fraction of a segment's learnable terms that must be new (novel or goal) before the
# segment is worth the viewer's time.
#
# Why 0.5: a segment carries 1-9 terms, so "any term is new" (the old rule, i.e. 0.0)
# recommends effectively every segment — measured on the live graph it put 34/34, 11/11,
# 24/25 segments in the cut lists and every video reported watch == 100% of runtime.
# Sitting through 44 seconds for one unfamiliar term out of five is precisely the waste
# this product claims to remove; the term itself is still shown in the response, and
# reading it in a badge is cheaper than watching.
#
# 0.5 is the majority line: a segment that is mostly new is always kept, a segment that
# is mostly review is always dropped, and a 50/50 segment gets the benefit of the doubt.
# Measured, it separates the corpus into genuinely different verdicts instead of a flat
# 100%: L8 100%, Postgres 100%, Game Theory B 75%, Game Theory A 0%. Raising it to 0.6
# reads better on stage (Game Theory B falls to 63%) but starts discarding segments that
# are 55% new, which contradicts the promise above — honesty over drama.
MIN_NOVELTY_DENSITY = 0.5

# Second-order rule, measured but OFF by default: a term stops being new once an earlier
# segment of the SAME video has taught it, so the 6th mention of "Nash equilibrium" no
# longer earns its segment a place in the cut list. Measured at 0.5 it separates the
# corpus much harder — Postgres 91%, L8 73%, Game Theory B 34%, Game Theory A 0% — but a
# segment can then be 100% novel-to-the-viewer and still be dropped as a repeat, which
# contradicts "mostly new is always kept". Flip to True for a more dramatic stage demo;
# the trade is a smaller capture drop on Game Theory B (46.3% -> 33.9%, vs 99.9% -> 75.2%).
DISCOUNT_REPEATED_TERMS = False

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
     [c IN known_c + goal_c | coalesce(c.note_path, c.video_id)][0] AS matched_source,
     [c IN known_c | c.video_id][0] AS learned_from_id
// A captured concept records the id of the video that taught it. Showing a raw
// '6a6baa1c0d774e7cec6c1a66' to a human is meaningless — resolve it to the title.
OPTIONAL MATCH (src:Video {id: learned_from_id})
RETURN v.id AS video_id, v.title AS title, v.duration_sec AS duration_sec,
       src.title AS learned_from,
       x.name AS name, labels(x)[0] AS kind, status, matched_concept, matched_source,
       [c IN goal_c | c.name][0] AS goal_concept,
       [s IN segs | {id: s.id, idx: s.idx, start_sec: s.start_sec, end_sec: s.end_sec,
                     summary: s.summary}] AS segments
"""


def _title_tokens(text: str) -> set[str]:
    """Lowercase alphanumeric tokens. yt-dlp writes titles like
    `L8_Principal_s_Agentic_Engineering_Workflow`, so word boundaries in the stored
    title are underscores that no one types."""
    return {t for t in re.split(r"[^a-z0-9]+", text.lower()) if t}


async def find_video(title_or_id: str) -> dict | None:
    """Resolve a video by id, substring, or — failing those — title tokens.

    Substring alone made every underscore-titled video unreachable by natural phrasing:
    'L8 agentic engineering' matched nothing because the stored title separates those
    words with underscores, so only the fragment 'L8' worked. A 404 there reads as a
    broken app, which is exactly what someone typing a real title into chat would find.
    """
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
    if rows:
        return rows[0]

    wanted = _title_tokens(title_or_id)
    if not wanted:
        return None

    candidates = await execute_cypher(
        "MATCH (v:Video) RETURN v.id AS id, v.title AS title, v.duration_sec AS duration_sec",
        {},
        collect=False,
    )
    # Rank by how much of the query a title accounts for, then prefer the shorter title
    # so a generic query cannot be captured by whichever video has the longest name.
    scored = [
        (len(wanted & _title_tokens(c["title"])) / len(wanted), -len(c["title"]), c)
        for c in candidates or []
    ]
    scored.sort(key=lambda s: (s[0], s[1]), reverse=True)
    # Half the query's words is the floor: below that this is a different video, and
    # confidently returning the wrong one is worse than saying it isn't here.
    return scored[0][2] if scored and scored[0][0] >= 0.5 else None


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

    # ingest MERGEs Topics and Entities under separate labels, so the same term can exist
    # as both — "Agent Memory" came back twice, double-counting it in the stats and giving
    # the panel two list items with identical identity. One name is one concept: union
    # their segments and let the strongest status win (known > goal > novel).
    _RANK = {"known": 0, "goal": 1, "novel": 2}
    merged: dict[str, dict] = {}
    for r in rows:
        key = r["name"].strip().lower()
        prev = merged.get(key)
        if prev is None:
            merged[key] = dict(r)
            continue
        if _RANK[r["status"]] < _RANK[prev["status"]]:
            keep_segments = prev["segments"]
            merged[key] = dict(r)
            merged[key]["segments"] = keep_segments + r["segments"]
        else:
            prev["segments"] = prev["segments"] + r["segments"]
            prev["goal_concept"] = prev.get("goal_concept") or r.get("goal_concept")
    for r in merged.values():
        seen_idx = set()
        r["segments"] = [s for s in r["segments"]
                         if not (s["idx"] in seen_idx or seen_idx.add(s["idx"]))]
    rows = list(merged.values())

    known, novel, goal = [], [], []
    segments: dict[int, dict] = {}  # idx -> segment + every learnable term it carries
    for r in rows:
        # Every "where did this come from" string a human reads is built here. A vault
        # concept cites its note; a captured one cites the video that taught it BY TITLE.
        src = r.get("matched_source") or ""
        note = src.rsplit("/", 1)[-1] if src.endswith(".md") else None
        # `source` is what the panel renders, so it must be readable: the note filename for
        # a vault concept, the video title for a captured one. The raw path/id stays
        # available as source_ref for anything that needs to address the thing.
        entry = {"name": r["name"], "status": r["status"], "kind": r["kind"],
                 "matched_concept": r.get("matched_concept"),
                 "source": note or r.get("learned_from") or r.get("matched_source"),
                 "source_ref": r.get("matched_source"),
                 "source_kind": "note" if note else ("video" if r.get("learned_from") else None)}
        # A known term can still sit inside a goal. The old wording ran the two clauses
        # together into "you already know this — and it advances your goal 'X'", which
        # reads as nonsense: if you know it, it is no longer something to go learn. Say
        # what it actually means — this is progress already made against a stated goal.
        if r["status"] == "known" and r.get("goal_concept"):
            entry["goal_note"] = f"progress on your goal: {r['goal_concept']}"
            entry["goal"] = r["goal_concept"]
        {"known": known, "novel": novel, "goal": goal}[r["status"]].append(entry)
        # A goal match is topical, not literal — the viewer asked for "game theory",
        # not for "Nash equilibrium". Name the goal instead of claiming they named it.
        if r["status"] == "goal" and r.get("goal_concept"):
            why = f"advances your goal '{r['goal_concept']}'"
        elif r["status"] == "novel":
            why = "not in your knowledge base"
        elif note:
            why = f"you already know this — your note {note}"
        elif r.get("learned_from"):
            why = f"you learned this from {r['learned_from']}"
        else:
            why = "you already know this"
        for s in r["segments"]:
            seg = segments.setdefault(s["idx"], {**s, "concepts": []})
            seg["concepts"].append({"name": r["name"], "status": r["status"], "why": why})

    # Novelty density decides the cut. Recommending a segment because one of its nine
    # terms is unfamiliar is what pinned every video at "watch 100%".
    watch_idx, skimp_idx = [], []
    taught: set[str] = set()
    for idx in sorted(segments):
        seg = segments[idx]
        new = [c for c in seg["concepts"] if c["status"] in ("novel", "goal")]
        first = [c for c in new if c["name"] not in taught] if DISCOUNT_REPEATED_TERMS else new
        taught.update(c["name"] for c in new)
        seg["novelty"] = round(len(first) / len(seg["concepts"]), 2)
        if not new:
            continue  # pure review: never in either list
        keep = bool(first) and seg["novelty"] >= MIN_NOVELTY_DENSITY
        (watch_idx if keep else skimp_idx).append(idx)

    def _merge(indices: list[int], keep_all_concepts: bool) -> list[dict]:
        """Merge adjacent segments into contiguous ranges."""
        out: list[dict] = []
        for idx in sorted(indices):
            s = segments[idx]
            cons = (s["concepts"] if keep_all_concepts
                    else [c for c in s["concepts"] if c["status"] in ("novel", "goal")])
            if out and idx == out[-1]["_last_idx"] + 1:
                out[-1]["end_sec"] = s["end_sec"]
                out[-1]["concepts"].extend(cons)
                out[-1]["_novelty"].append(s["novelty"])
                out[-1]["_last_idx"] = idx
            else:
                out.append({"start_sec": s["start_sec"], "end_sec": s["end_sec"],
                            "summary": s["summary"], "segment_id": s["id"],
                            "concepts": list(cons), "_novelty": [s["novelty"]],
                            "_last_idx": idx})
        for c in out:
            del c["_last_idx"]
            c["novelty"] = round(sum(c["_novelty"]) / len(c["_novelty"]), 2)
            del c["_novelty"]
            seen = set()
            c["concepts"] = [x for x in c["concepts"]
                             if not (x["name"] in seen or seen.add(x["name"]))]
        return out

    cuts = _merge(watch_idx, keep_all_concepts=False)
    # Skipped-but-not-empty: mostly review, but it did carry something new. Keep every
    # concept (known included) so the agent can say what it dropped and why, rather than
    # silently swallowing a novel term.
    skipped = _merge(skimp_idx, keep_all_concepts=True)

    # Pegasus timestamps are approximate and can overrun the real runtime; without a
    # clamp an 8-minute video reports "watch 12:00 of 8:07" and skip_sec collapses to 0.
    duration = video.get("duration_sec") or 0
    if duration:
        cuts = [c for c in cuts if (c["start_sec"] or 0) < duration]
        skipped = [c for c in skipped if (c["start_sec"] or 0) < duration]
        for c in cuts + skipped:
            c["end_sec"] = min(c["end_sec"] or 0, duration)
    watch_sec = sum(max((c["end_sec"] or 0) - (c["start_sec"] or 0), 0) for c in cuts)
    cut_names = {c["name"] for cut in cuts for c in cut["concepts"]}
    minor = [c for s in skipped for c in s["concepts"]
             if c["status"] in ("novel", "goal") and c["name"] not in cut_names]
    return {
        "video": video,
        "stats": {
            "concepts_total": len(known) + len(novel) + len(goal),
            "known": len(known), "novel": len(novel), "goal_hits": len(goal),
            "watch_sec": round(watch_sec), "skip_sec": round(max(duration - watch_sec, 0)),
            # additive: how the density rule split the timeline
            "segments_kept": len(watch_idx), "segments_skipped": len(skimp_idx),
            "min_novelty_density": MIN_NOVELTY_DENSITY,
        },
        "known_concepts": known,
        "cuts": cuts,
        # additive: ranges the density rule dropped, and the new-but-minor terms that
        # appear ONLY there — the agent should mention these instead of burying them.
        "skipped": skipped,
        "minor_concepts": [{"name": c["name"], "status": c["status"], "why": c["why"]}
                           for c in {m["name"]: m for m in minor}.values()],
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
    # Default capture = what the cut list told them to watch. Named capture may also
    # reach into skipped ranges: the viewer can legitimately say "I already picked that
    # one up" about a term the density rule judged too minor to be worth a cut.
    sources = delta["cuts"] + (delta["skipped"] if wanted else [])
    targets: dict[str, dict] = {}  # key -> target, deduped across cuts
    for cut in sources:
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


class _QuizItem(BaseModel):
    concept: str
    question: str
    answer_key: str


class _Quiz(BaseModel):
    questions: list[_QuizItem]


QUIZ_SYSTEM = (
    "You write one short quiz question per concept to test whether someone already "
    "understands that concept. The questions are about the CONCEPT ITSELF, answerable "
    "from general knowledge by anyone who understands it — never trivia about a "
    "particular video, speaker, slide, or example ('what did the speaker say', 'what "
    "was on the slide' are forbidden). Each question must be answerable in one or two "
    "sentences and must be specific enough that a vague gesture at the topic fails it. "
    "answer_key is a one-line model answer a grader can check against. Use the concept "
    "name verbatim in the 'concept' field. Return exactly one question per concept."
)


class _Grade(BaseModel):
    concept: str
    correct: bool
    verdict: str


class _Grades(BaseModel):
    grades: list[_Grade]


GRADE_SYSTEM = (
    "You grade short free-text answers about a concept against a model answer. Mark "
    "correct=true only when the answer shows real understanding of the concept — the "
    "wording need not match the model answer, but a vague gesture at the topic, a "
    "restatement of the question, a guess, or an empty answer is NOT correct. When you "
    "are unsure, mark it false: wrongly recording that someone knows something makes a "
    "video's teaching invisible to them forever. 'verdict' is one short sentence the "
    "learner will read, saying what they got right or what they missed. Use the concept "
    "name verbatim. Return exactly one grade per submitted answer."
)


async def grade_quiz(title_or_id: str, answers: list[dict]) -> dict:
    """Grade quiz answers and capture ONLY the concepts actually demonstrated.

    This is what makes 'I watched it' honest. Capturing a whole video on a button press
    records knowledge nobody proved — the same mistake as trusting vault filenames, and
    it silently deletes those segments from every future recommendation. Here a concept
    becomes known only when the viewer answers for it, and anything failed stays novel,
    so the cut list keeps recommending exactly the parts they could not demonstrate.
    """
    video = await find_video(title_or_id)
    if not video:
        return {"error": f"No ingested video matches '{title_or_id}'."}
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
        # No grade returned means unproven, which means not captured.
        entry = {"concept": a["concept"],
                 "verdict": g.verdict if g else "Not graded, so left unproven."}
        (passed if (g and g.correct) else failed).append(entry)

    captured = []
    if passed:
        result = await capture_learning(title_or_id, [p["concept"] for p in passed])
        captured = result.get("captured", [])

    return {
        "video": video,
        "passed": passed,
        "failed": failed,
        "captured": captured,
        # The whole point: what you could not demonstrate is still recommended.
        "still_recommended": [f["concept"] for f in failed],
        "summary": (f"{len(passed)} of {len(submitted)} demonstrated. "
                    f"{len(failed)} still in your cut list."),
    }


async def quiz_questions(title_or_id: str, count: int = 5) -> dict:
    """Quiz the viewer on what a video would teach them, so demonstrated knowledge —
    not just what they wrote down — can grow the knowledge state.

    The knowledge state is built from vault note titles, which is evidence of what the
    viewer WROTE, not of what they KNOW. Proving a concept here lets capture_learning
    mark it known without sitting through the video that teaches it. Grading happens in
    the chat agent; this only produces the questions.
    """
    delta = await knowledge_delta(title_or_id)
    if "error" in delta:
        return delta

    # Prefer concepts the video actually teaches (they carry a timecode to cite), then
    # fall back to new-but-minor terms so short cut lists still fill a quiz.
    candidates: dict[str, dict] = {}
    for cut in delta["cuts"]:
        for con in cut["concepts"]:
            if con["status"] in ("novel", "goal"):
                candidates.setdefault(con["name"], {
                    "concept": con["name"], "status": con["status"],
                    "segment_id": cut["segment_id"], "start_sec": cut["start_sec"]})
    for con in delta["minor_concepts"]:
        candidates.setdefault(con["name"], {"concept": con["name"], "status": con["status"],
                                            "segment_id": None, "start_sec": None})
    picked = list(candidates.values())[:max(1, min(int(count), 10))]
    if not picked:
        return {"video": delta["video"], "questions": [],
                "note": "Nothing new left to test — you already know everything this video teaches."}

    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key or None)
    listing = "\n".join(f"- {p['concept']}" for p in picked)
    response = await asyncio.to_thread(
        lambda: client.responses.parse(
            model=settings.openai_extraction_model,
            reasoning={"effort": settings.openai_reasoning_effort},
            input=[
                {"role": "system", "content": QUIZ_SYSTEM},
                {"role": "user", "content": f"Video: {delta['video']['title']}\n\n"
                                            f"Concepts to test:\n\n{listing}"},
            ],
            text_format=_Quiz,
        )
    )
    if response.output_parsed is None:
        return {"error": "Quiz generation returned nothing."}

    # Trust the graph for the timecode, the model only for the wording: match verdicts
    # back onto the concepts we asked about, and drop any the model invented.
    by_name = {p["concept"].lower(): p for p in picked}
    questions = []
    for q in response.output_parsed.questions:
        p = by_name.get(q.concept.lower())
        if not p:
            continue
        questions.append({"concept": p["concept"], "question": q.question,
                          "answer_key": q.answer_key, "status": p["status"],
                          "segment_id": p["segment_id"], "start_sec": p["start_sec"]})
    return {"video": delta["video"], "questions": questions}


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
