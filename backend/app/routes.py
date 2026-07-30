"""API routes for the Video Agent Context Graph."""

from __future__ import annotations

import asyncio
import json
import uuid as _uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from starlette.responses import StreamingResponse

from app.agent import handle_message, handle_message_stream
from app.context_graph_client import (
    execute_cypher, get_schema, get_schema_visualization, expand_node,
    get_collector, is_connected,
)

router = APIRouter()


def _require_neo4j():
    if not is_connected():
        raise HTTPException(
            status_code=503,
            detail="Neo4j is unavailable. Check your connection and restart the server.",
        )


class ChatRequest(BaseModel):
    message: str = Field(..., max_length=4000)
    session_id: str | None = None


class ChatResponse(BaseModel):
    response: str
    session_id: str
    graph_data: dict | None = None
    tool_calls: list[dict] | None = None


class CypherRequest(BaseModel):
    query: str
    parameters: dict | None = None


class ExpandRequest(BaseModel):
    element_id: str


class SearchRequest(BaseModel):
    query: str = Field(..., max_length=2000)
    limit: int = 8


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------

@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    _require_neo4j()
    try:
        collector = get_collector()
        collector.drain()
        collector.drain_tool_calls()
        result = await handle_message(request.message, request.session_id)
        if result.get("graph_data") is None:
            collected = collector.drain()
            if collected:
                result["graph_data"] = {"results": collected}
        tool_calls = collector.drain_tool_calls()
        if tool_calls:
            result["tool_calls"] = tool_calls
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """Streaming SSE chat. Events: session_id, tool_start, tool_end, text_delta, done, error."""
    _require_neo4j()
    session_id = request.session_id or str(_uuid.uuid4())
    collector = get_collector()
    collector.drain()
    collector.drain_tool_calls()

    event_queue: asyncio.Queue = asyncio.Queue()
    collector.set_event_queue(event_queue)

    async def run_agent():
        try:
            await handle_message_stream(request.message, session_id)
        except Exception as e:
            try:
                event_queue.put_nowait({"event": "error", "data": {"detail": str(e)}})
            except Exception:
                pass
        finally:
            await asyncio.sleep(0.1)
            collector.clear_event_queue()

    async def event_generator():
        task = asyncio.create_task(run_agent())
        yield f"event: session_id\ndata: {json.dumps({'session_id': session_id})}\n\n"
        idle_timeout = 120.0
        overall_timeout = 300.0
        loop = asyncio.get_event_loop()
        start_time = loop.time()
        try:
            while True:
                if loop.time() - start_time > overall_timeout:
                    yield f"event: error\ndata: {json.dumps({'detail': 'Request exceeded maximum duration'})}\n\n"
                    break
                try:
                    event = await asyncio.wait_for(event_queue.get(), timeout=idle_timeout)
                except asyncio.TimeoutError:
                    yield f"event: error\ndata: {json.dumps({'detail': 'Request timed out'})}\n\n"
                    break
                event_type = event["event"]
                event_data = json.dumps(event["data"], default=str)
                yield f"event: {event_type}\ndata: {event_data}\n\n"
                if event_type in ("done", "error"):
                    break
        finally:
            if not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------------------
# Graph / schema
# ---------------------------------------------------------------------------

@router.get("/schema")
async def schema():
    _require_neo4j()
    return await get_schema()


@router.get("/schema/visualization")
async def schema_visualization():
    _require_neo4j()
    return await get_schema_visualization()


@router.post("/expand")
async def expand(request: ExpandRequest):
    _require_neo4j()
    return await expand_node(request.element_id)


@router.post("/cypher")
async def cypher(request: CypherRequest):
    _require_neo4j()
    try:
        results = await execute_cypher(request.query, dict(request.parameters or {}))
        return {"results": results}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ---------------------------------------------------------------------------
# Video-specific
# ---------------------------------------------------------------------------

@router.get("/videos")
async def list_videos():
    """List indexed videos with their segment counts."""
    _require_neo4j()
    results = await execute_cypher(
        """
        MATCH (v:Video)
        OPTIONAL MATCH (v)-[:HAS_SEGMENT]->(s:Segment)
        RETURN v.id AS id, v.title AS title, v.url AS url,
               v.duration_sec AS duration_sec, v.summary AS summary,
               count(s) AS segment_count
        ORDER BY v.title
        """,
        collect=False,
    )
    return {"videos": results}


@router.get("/videos/{video_id}/segments")
async def video_segments(video_id: str):
    """Return a video's segments in temporal order."""
    _require_neo4j()
    results = await execute_cypher(
        """
        MATCH (v:Video {id: $vid})-[:HAS_SEGMENT]->(s:Segment)
        OPTIONAL MATCH (s)-[:MENTIONS]->(e:Entity)
        OPTIONAL MATCH (s)-[:ABOUT]->(t:Topic)
        OPTIONAL MATCH (t2)-[:SAME_AS]->(k:Concept {status: 'known'})
        WHERE t2 = t OR t2 = e
        RETURN s.id AS id, s.idx AS idx, s.start_sec AS start_sec, s.end_sec AS end_sec,
               s.summary AS summary, s.on_screen_text AS on_screen_text,
               // Pegasus captures spoken words per segment; without this the UI can show
               // a cut list but never what is actually said inside a recommended range.
               s.transcript AS transcript,
               collect(DISTINCT e.name) AS entities,
               collect(DISTINCT t.name) AS topics,
               collect(DISTINCT k.name) AS known_concepts
        ORDER BY s.start_sec
        """,
        {"vid": video_id},
        collect=False,
    )
    return {"video_id": video_id, "segments": results}


class CaptureRequest(BaseModel):
    video: str
    concepts: list[str] | None = None


@router.get("/delta/{video}")
async def delta(video: str):
    """The 'Your Cut' contract: what this video teaches that the viewer doesn't know."""
    _require_neo4j()
    from app.delta import knowledge_delta
    result = await knowledge_delta(video)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.post("/capture")
async def capture(request: CaptureRequest):
    """Mark novel concepts from a video as learned (grows the knowledge state)."""
    _require_neo4j()
    from app.delta import capture_learning
    result = await capture_learning(request.video, request.concepts)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.get("/quiz/{video}")
async def quiz(video: str, count: int = 5):
    """Questions testing whether the viewer already knows what this video would teach."""
    _require_neo4j()
    from app.delta import quiz_questions
    result = await quiz_questions(video, count)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.get("/knowledge-map")
async def knowledge_map_view(limit: int = 90):
    """Concept-level map of the corpus coloured by the viewer's knowledge state.

    This is what the graph panel should show by default — `/schema/visualization` renders
    Neo4j's index metadata, which says nothing about what anyone knows.
    """
    _require_neo4j()
    from app.knowledge_map import knowledge_map
    return await knowledge_map(limit)


@router.get("/knowledge")
async def knowledge():
    """The viewer's knowledge state: goals with coverage, and what they know, from where."""
    _require_neo4j()
    from app.knowledge_map import knowledge_state
    return await knowledge_state()


@router.get("/watchlist")
async def watchlist():
    """All ingested videos ranked by novel-content density for this viewer."""
    _require_neo4j()
    from app.delta import rank_videos
    return {"videos": await rank_videos()}


@router.post("/search")
async def search(request: SearchRequest):
    """Live multimodal search over the raw videos via TwelveLabs (Marengo)."""
    from app.twelvelabs_client import ensure_index
    from app.twelvelabs_client import search as tl_search
    try:
        index_id = await asyncio.to_thread(ensure_index)
        hits = await asyncio.to_thread(tl_search, index_id, request.query, None, "clip", request.limit)
        return {"results": hits}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"TwelveLabs search failed: {e}")


@router.get("/scenarios")
async def scenarios():
    """Demo prompts for the frontend."""
    return {
        "domain": "Delta Learning",
        "scenarios": [
            {"name": "What's new to me", "prompts": [
                "I don't have 20 minutes — what in this talk is actually new to me?",
                "What should I watch next?",
            ]},
            {"name": "Grow the knowledge base", "prompts": [
                "I watched those segments — capture what they taught me",
                "Which of my learning goals does this corpus cover?",
            ]},
            {"name": "Explore", "prompts": [
                "What videos do we have and what are they about?",
                "Which concepts do I already know that show up across videos?",
            ]},
        ],
    }
