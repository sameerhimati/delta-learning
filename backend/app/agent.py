"""Video Context Graph agent — Strands + OpenAI brain, video graph tools."""

from __future__ import annotations

import asyncio
import json
import os

from strands import Agent
from strands.models.openai_responses import OpenAIResponsesModel
from strands.tools import tool

from app.config import settings
from app.context_graph_client import execute_cypher, get_schema
from app.delta import capture_learning as _capture_learning
from app.delta import knowledge_delta as _knowledge_delta
from app.delta import quiz_questions as _quiz_questions
from app.delta import rank_videos as _rank_videos
from app.memory import store_message, get_context, resolve_session_id
from app.vector_client import segment_vector_search

# Ensure OPENAI_API_KEY is on the environment for the OpenAI client.
if not os.environ.get("OPENAI_API_KEY") and settings.openai_api_key:
    os.environ["OPENAI_API_KEY"] = settings.openai_api_key


_main_loop: asyncio.AbstractEventLoop | None = None


def _capture_loop():
    global _main_loop
    _main_loop = asyncio.get_running_loop()


def _run_sync(coro):
    """Run an async coroutine from a synchronous worker thread on the main loop."""
    loop = _main_loop
    if loop is not None and loop.is_running():
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result(timeout=30)
    return asyncio.run(coro)


SYSTEM_PROMPT = """You are a video intelligence assistant. You answer questions over a Neo4j
knowledge graph built from videos analyzed by TwelveLabs. The graph contains:
- Video nodes (id, title, url, duration_sec, summary)
- Segment nodes (time-coded: start_sec, end_sec, summary, on_screen_text, transcript)
- Entity and Topic nodes that are SHARED across videos (the same entity in two videos is ONE node)
Relationships: (Video)-[:HAS_SEGMENT]->(Segment), (Segment)-[:NEXT]->(Segment),
(Segment)-[:MENTIONS]->(Entity), (Segment)-[:ABOUT]->(Topic).

THE VIEWER IS IN THE GRAPH TOO. Concept nodes model what the user already knows
(status='known', sourced from their knowledge vault or previously captured video
learnings) and what they want to learn (status='goal'). (Topic|Entity)-[:SAME_AS]->(Concept)
edges link video content to the viewer's knowledge state. This lets you answer the
question retrieval cannot: "what's in this video that I don't already know?"
- "what should I watch / what's new to me in X" -> knowledge_delta. Present the cut
  list as timecoded ranges with WHY (novel vs an explicit learning goal), then the
  skipped concepts with the vault note that covers each ("you already know X — it's
  your note 'x.md'").
- Explain the recommendation rule in plain language: a range is worth watching when a
  majority of the terms it covers are new to the viewer. A single unfamiliar term buried
  in five familiar ones is not worth the minutes — read it in the badge instead.
- knowledge_delta also returns "skipped" (ranges that hold something new but failed that
  test) and "minor_concepts" (new terms that appear ONLY in those ranges). Never bury
  them: say what you cut and why — "I skipped 12:00-14:30; it covers X and Y you already
  know, plus Z which is new but minor." If minor_concepts is non-empty, name them.
- A concept is called known only when the graph has positive evidence of it. If a delta
  has no known concepts, recommend the full video and say that no saved-knowledge overlap
  was found, so no portion is safe to skip. If it has goal hits, also say that the video
  serves that stated learning goal; a goal is interest, not evidence of prior knowledge.
- "I watched it / I learned that / capture this" -> capture_learning. Afterwards,
  tell the user their knowledge state grew — future videos will skip these concepts.
- "quiz me / test me / do I already know this" -> quiz_me. The knowledge state is built
  from what the viewer WROTE DOWN, so it understates what they KNOW; a quiz proves a
  concept without making them watch the video that teaches it. Ask the returned questions
  (numbered, no answer keys), wait for their answers, then grade them yourself against
  each answer_key. Then call capture_learning(video, concepts="<comma-separated names of
  ONLY the concepts they got RIGHT>"). Never capture a concept they got wrong, skipped,
  or hedged on. Afterwards say plainly which concepts were marked known, which were not
  and why, and that their cut lists for those concepts will now shrink.
- "which video should I watch next" -> what_should_i_watch.
- "what should I learn first / where do I start / highest-leverage gap" -> learning_frontier
  (GDS PageRank over the terms you don't know yet); cite the video + timecode it returns.
Be honest about coverage: if a video contains nothing on a goal, say so explicitly.
- Then do not stop there: call find_outside_material for that goal and recommend what it
  returns, citing each title, channel, length and URL verbatim. Say plainly that these
  are outside the ingested library. Never write a YouTube URL that did not come from
  that tool; if it returns no recommendations, say none were found.

Tool selection:
- "find the moment where..." / semantic recall -> search_video_moments
- "what involves / connects X", "which entities span videos" -> explore_graph or run_cypher
- fresh multimodal recall straight from TwelveLabs -> twelvelabs_search
- schema questions -> get_graph_schema; anything custom -> run_cypher (read-only)

ALWAYS ground answers in tool results — never invent videos, entities, or timecodes.
When you cite a moment, give the video title and the segment start/end times so the
user can jump to it.

THE GRAPH PANEL IS DRIVEN BY YOUR TOOL CALLS: it re-renders to display the nodes your
tools return. So whenever the user asks to see, show, highlight, find, or explore a
specific segment, moment, entity, topic, or video — including one you already
discussed earlier — you MUST call a graph tool (search_video_moments, explore_graph,
or run_cypher) to surface those nodes, even if you already know the answer from the
conversation. Do not answer such requests from memory alone. When you use run_cypher
for this, return whole nodes (e.g. `RETURN v, s, e`) rather than scalar properties so
they render in the graph. To show a specific segment, match it by video + start time,
e.g. MATCH (v:Video)-[:HAS_SEGMENT]->(s:Segment) WHERE s.start_sec = 65 OPTIONAL MATCH
(s)-[:MENTIONS]->(e) RETURN v, s, e.

CRITICAL: Call tools DIRECTLY without preamble. Do NOT say "I'll search..." first —
just call the tool. Only write prose AFTER you have tool results."""


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@tool
def search_video_moments(query: str) -> str:
    """Semantic search for the video moments (segments) most relevant to a natural-language query. Use for "find the moment where..." questions."""
    from app.twelvelabs_client import embed_text
    try:
        vec = embed_text(query)
    except Exception as e:
        return json.dumps({"error": f"embedding failed: {e}"})
    results = _run_sync(segment_vector_search(vec, top_k=8))
    return json.dumps(results, default=str)


@tool
def explore_graph(name: str) -> str:
    """Explore everything involving an entity, topic, or video by name — across all videos. Returns the connected subgraph."""
    cypher = """
    MATCH (n)
    WHERE (n:Entity OR n:Topic OR n:Video)
      AND toLower(coalesce(n.name, n.title)) CONTAINS toLower($name)
    OPTIONAL MATCH (n)-[r]-(m)
    RETURN n, r, m
    LIMIT 60
    """
    results = _run_sync(execute_cypher(cypher, {"name": name}, tool_name="explore_graph"))
    return json.dumps(results, default=str)


@tool
def twelvelabs_search(query: str) -> str:
    """Search the raw videos directly via TwelveLabs (multimodal Marengo search) for the freshest clip matches. Use when the graph may be missing detail."""
    from app.twelvelabs_client import ensure_index, search
    try:
        index_id = ensure_index()
        hits = search(index_id, query, limit=8)
    except Exception as e:
        return json.dumps({"error": f"twelvelabs search failed: {e}"})
    # Light up the matched videos in the graph view.
    vids = [h["video_id"] for h in hits if h.get("video_id")]
    if vids:
        _run_sync(execute_cypher(
            """
            MATCH (v:Video) WHERE v.id IN $vids
            OPTIONAL MATCH (v)-[r:HAS_SEGMENT]->(s:Segment)
            RETURN v, r, s
            """,
            {"vids": vids}, tool_name="twelvelabs_search",
        ))
    return json.dumps({"clips": hits}, default=str)


@tool
def knowledge_delta(video: str) -> str:
    """Compute what a video teaches that the viewer does NOT already know: the personalized, timecoded cut list. Use for "what should I watch in X" / "what's new to me". `video` is a title fragment or video id."""
    result = _run_sync(_knowledge_delta(video))
    return json.dumps(result, default=str)


@tool
def capture_learning(video: str, concepts: str = "") -> str:
    """Capture concepts the viewer just learned from a video into their knowledge base (status becomes 'known', sourced to the teaching segment). `concepts` is comma-separated names; empty captures ALL novel concepts in the video."""
    names = [c for c in (s.strip() for s in concepts.split(",")) if c] or None
    result = _run_sync(_capture_learning(video, names))
    return json.dumps(result, default=str)


@tool
def quiz_me(video: str, count: int = 5) -> str:
    """Generate a short quiz on the concepts a video would teach the viewer, to test whether they ALREADY know them. Use for "quiz me on X" / "test me" / "do I already know this". `video` is a title fragment or video id. Returns questions with an answer_key for grading."""
    result = _run_sync(_quiz_questions(video, count))
    return json.dumps(result, default=str)


@tool
def onboarding_quiz(count: int = 5) -> str:
    """Bootstrap the viewer's knowledge state by testing them across the WHOLE corpus, highest-leverage concepts first (GDS PageRank over the terms they have not claimed). Use on a first run, or for "what do I already know", "set me up", "I haven't told you anything about myself", "why does everything say watch 100%". Unlike quiz_me this is not tied to one video. Ask the returned questions, then call grade_onboarding with the answers. Small batches are better than one big one: the frontier recomputes after each round, so later questions adapt to what was just proven."""
    from app.onboarding import onboarding_questions
    return json.dumps(_run_sync(onboarding_questions(count)), default=str)


@tool
def grade_onboarding(answers_json: str) -> str:
    """Grade onboarding answers and record ONLY the concepts the viewer demonstrated, as known Concepts sourced to the quiz. `answers_json` is a JSON list of {"concept": "...", "answer": "..."}. Anything wrong or vague stays unknown, so the cut lists keep recommending it. Returns per-concept verdicts plus how much of the corpus the viewer now accounts for."""
    from app.onboarding import grade_onboarding as _grade
    try:
        answers = json.loads(answers_json)
    except Exception as e:
        return json.dumps({"error": f"answers_json must be a JSON list: {e}"})
    if not isinstance(answers, list):
        return json.dumps({"error": "answers_json must be a JSON list of objects."})
    return json.dumps(_run_sync(_grade(answers)), default=str)


@tool
def learning_path(goal: str = "") -> str:
    """Build an ordered curriculum through the corpus: units of related concepts, in the order they should be learned, skipping what the viewer already knows. Use for "what's my learning path", "give me a curriculum", "how should I work through this", "where do I start and what comes after". `goal` restricts the path to one stated learning goal; empty covers everything. Each unit carries its timecoded lessons and how far through it the viewer already is."""
    from app.curriculum import build_curriculum
    return json.dumps(_run_sync(build_curriculum(goal.strip() or None)), default=str)


@tool
def add_video(url: str) -> str:
    """Ingest a new video into the library from a URL, so the corpus can grow to cover a gap. Use after recommending outside material when the user says "add that one" / "ingest this" / pastes a URL. Returns a job to poll -- indexing and analysis take minutes, so tell the user it is running and report the job id rather than waiting."""
    from app.ingest_api import start_ingest
    return json.dumps(_run_sync(start_ingest(url)), default=str)


@tool
def find_outside_material(goal: str = "") -> str:
    """Find REAL videos OUTSIDE the ingested library that teach a goal this corpus does not cover. Use whenever the answer would otherwise be a dead end: "nothing here covers X, what should I watch instead", "what should I watch that isn't in my library", or immediately after you tell the user a goal has zero/low coverage. `goal` is a topic or learning goal; empty auto-selects the least-covered goals. Every result comes from a live YouTube search — never invent, recall, or guess a video URL yourself; cite only what this tool returns, and if it returns nothing, say nothing was found."""
    from app.discover import discover_for_goal, discover_for_goals
    result = _run_sync(discover_for_goal(goal) if goal.strip() else discover_for_goals())
    return json.dumps(result, default=str)


@tool
def what_should_i_watch() -> str:
    """Rank all ingested videos by novel-content density for this viewer — which video is most worth their time right now."""
    result = _run_sync(_rank_videos())
    return json.dumps(result, default=str)


# Neo4j GDS: co-occurrence graph of the terms the viewer does NOT know yet, then
# PageRank over it. See cypher/gds_projections.cypher for the annotated versions.
# Defined in app.onboarding, which walks the same frontier to bootstrap a knowledge
# state — one copy, so the two can't drift into ranking things differently.
from app.onboarding import (  # noqa: E402
    FRONTIER_DROP as _FRONTIER_DROP,
    FRONTIER_GRAPH_NAME as _FRONTIER_GRAPH_NAME,
    FRONTIER_PROJECT as _FRONTIER_PROJECT,
    FRONTIER_RANK as _FRONTIER_RANK,
)

# Light up the top frontier terms in the graph panel.
_FRONTIER_GRAPH = """
MATCH (v:Video)-[:HAS_SEGMENT]->(s:Segment)-[r:ABOUT|MENTIONS]->(x)
WHERE x.name IN $terms
RETURN v, s, r, x LIMIT 40
"""


@tool
def learning_frontier(limit: int = 8) -> str:
    """Rank what the viewer should learn FIRST: runs Neo4j GDS PageRank over the co-occurrence graph of only the terms they do NOT already know, so the top terms are the ones unlocking the most other unknown material. Use for "what should I learn first / where do I start / what's the highest-leverage thing I'm missing"."""
    from app.delta import LEARNABLE_ENTITY_TYPES
    params = {"learnable_types": LEARNABLE_ENTITY_TYPES}
    try:
        _run_sync(execute_cypher(_FRONTIER_DROP, collect=False))
        projection = _run_sync(execute_cypher(_FRONTIER_PROJECT, params, collect=False))
        rows = _run_sync(execute_cypher(
            _FRONTIER_RANK,
            {"graph_name": _FRONTIER_GRAPH_NAME, "limit": max(1, min(int(limit), 25))},
            collect=False,
        ))
        _run_sync(execute_cypher(_FRONTIER_DROP, collect=False))
    except Exception as e:
        return json.dumps({"error": f"GDS learning_frontier failed: {e}"})
    terms = [r["term"] for r in rows]
    if terms:
        _run_sync(execute_cypher(
            _FRONTIER_GRAPH, {"terms": terms}, tool_name="learning_frontier",
        ))
    return json.dumps({
        "method": "Neo4j GDS PageRank over segment co-occurrence, restricted to terms "
                  "with no SAME_AS link to a known Concept",
        "frontier_size": projection[0] if projection else {},
        "frontier": rows,
    }, default=str)


@tool
def run_cypher(query: str, parameters: str = "{}") -> str:
    """Execute a read-only Cypher query against the video knowledge graph."""
    try:
        params = json.loads(parameters) if parameters else {}
    except json.JSONDecodeError:
        return json.dumps({"error": "Invalid JSON parameters"})
    try:
        result = _run_sync(execute_cypher(query, params, tool_name="run_cypher"))
        return json.dumps(result, default=str)
    except Exception as e:
        return json.dumps({"error": f"Cypher query failed: {e}"})


@tool
def get_graph_schema() -> str:
    """Get the knowledge graph schema (node labels and relationship types)."""
    result = _run_sync(get_schema())
    return json.dumps(result, default=str)


model = OpenAIResponsesModel(
    client_args={"api_key": os.environ.get("OPENAI_API_KEY", settings.openai_api_key)},
    model_id=settings.openai_model,
    params={
        "reasoning": {"effort": settings.openai_reasoning_effort},
        "max_output_tokens": 2000,
    },
)

agent = Agent(
    model=model,
    system_prompt=SYSTEM_PROMPT,
    tools=[
        knowledge_delta,
        capture_learning,
        quiz_me,
        onboarding_quiz,
        grade_onboarding,
        what_should_i_watch,
        learning_path,
        find_outside_material,
        add_video,
        learning_frontier,
        search_video_moments,
        explore_graph,
        twelvelabs_search,
        run_cypher,
        get_graph_schema,
    ],
)


def _extract_text(result) -> str:
    if hasattr(result, "text"):
        return str(result.text)
    if hasattr(result, "message"):
        msg = result.message
        if hasattr(msg, "content"):
            parts = []
            for block in (msg.content if isinstance(msg.content, list) else [msg.content]):
                if hasattr(block, "text"):
                    parts.append(block.text)
                elif isinstance(block, str):
                    parts.append(block)
            if parts:
                return "\n".join(parts)
    try:
        return str(result)
    except Exception:
        return "I processed your request but couldn't format the response."


def _reset_agent_history() -> None:
    """Drop the shared Agent's own message buffer before each turn.

    `agent` is a process-wide singleton and Strands accumulates every turn it has
    ever seen in `agent.messages` — across sessions. Conversation context is already
    supplied per-session by _build_input, so that buffer is redundant, and it leaks:
    a judge clicking "+" for a fresh thread would get answers informed by the
    previous person's conversation. Verified by planting a fact in one session and
    reading it back from a brand-new one.

    Safe because routes.py serializes chat turns behind a lock, so no other request
    is mid-flight when this runs.
    """
    agent.messages.clear()


def _build_input(message: str, history: list[dict]) -> str:
    if history:
        history_block = "\n\n".join(
            f"[{m['role'].upper()}]\n{m['content']}" for m in history
        )
        return (
            f"<conversation_history>\n{history_block}\n</conversation_history>\n\n"
            f"[USER]\n{message}"
        )
    return message


async def handle_message(message: str, session_id: str | None = None) -> dict:
    """Handle an incoming chat message (non-streaming)."""
    session_id = resolve_session_id(session_id)
    await store_message(session_id, "user", message)
    context = await get_context(session_id, query=message)
    input_message = _build_input(message, context.get("messages", []))
    _reset_agent_history()

    _capture_loop()
    try:
        result = await asyncio.wait_for(asyncio.to_thread(agent, input_message), timeout=90.0)
        response_text = _extract_text(result)
    except asyncio.TimeoutError:
        response_text = "The request timed out after 90 seconds. Please try a simpler question."
    except Exception as e:
        import logging
        logging.getLogger(__name__).error("Agent error: %s", e, exc_info=True)
        response_text = f"An error occurred: {e}"

    await store_message(session_id, "assistant", response_text)
    return {"response": response_text, "session_id": session_id, "graph_data": None}


async def handle_message_stream(message: str, session_id: str | None = None) -> dict:
    """Stream a chat response token-by-token via the SSE collector."""
    from app.context_graph_client import get_collector

    session_id = resolve_session_id(session_id)
    collector = get_collector()

    await store_message(session_id, "user", message)
    context = await get_context(session_id, query=message)
    input_message = _build_input(message, context.get("messages", []))
    _reset_agent_history()

    _capture_loop()

    full_text_parts: list[str] = []
    try:
        async for event in agent.stream_async(input_message):
            if isinstance(event, dict):
                chunk = event.get("data")
                if chunk:
                    text_chunk = str(chunk)
                    collector.emit_text_delta(text_chunk)
                    full_text_parts.append(text_chunk)
        response_text = "".join(full_text_parts).strip()
    except Exception as e:
        import logging
        logging.getLogger(__name__).error("Agent streaming error: %s", e, exc_info=True)
        response_text = "".join(full_text_parts).strip()
        if not response_text:
            response_text = f"An error occurred: {e}"

    if not response_text.strip():
        response_text = "I searched the graph but couldn't find relevant results. Could you rephrase?"

    await store_message(session_id, "assistant", response_text)
    collector.emit_done(response_text, session_id)
    return {"response": response_text, "session_id": session_id, "graph_data": None}
