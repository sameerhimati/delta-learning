"""Onboarding bootstraps a knowledge state by asking, not by trusting.

The property worth protecting here is refusal: an answer that isn't demonstrably right
must not become `known`. Recording knowledge nobody proved silently deletes the segments
that teach it from every future cut list, which is a failure the viewer cannot see and
cannot easily undo.
"""

import asyncio
import os
from unittest.mock import AsyncMock, patch

import pytest

os.environ.setdefault("OPENAI_API_KEY", "test-placeholder")

from app.delta import _Grade, _Grades
from app.onboarding import grade_onboarding, onboarding_questions


@pytest.fixture
def graph_writes():
    """Capture Cypher writes so we can assert on what would reach the database."""
    with patch("app.onboarding.execute_cypher", new_callable=AsyncMock) as cypher:
        cypher.return_value = [{"learnable_terms": 10, "known_terms": 0}]
        yield cypher


def _grades(*pairs):
    return _Grades(grades=[_Grade(concept=c, correct=ok, verdict="because") for c, ok in pairs])


def test_only_demonstrated_concepts_are_captured(graph_writes):
    answers = [{"concept": "Nash Equilibrium", "answer": "a real answer"},
               {"concept": "Shapley Value", "answer": "it is important"}]

    with patch("app.onboarding.asyncio.to_thread", new_callable=AsyncMock) as call:
        call.return_value = _grades(("Nash Equilibrium", True), ("Shapley Value", False))
        result = asyncio.run(grade_onboarding(answers))

    assert result["captured"] == ["Nash Equilibrium"]
    assert [f["concept"] for f in result["failed"]] == ["Shapley Value"]

    written = [c.args[1]["targets"] for c in graph_writes.call_args_list
               if len(c.args) > 1 and isinstance(c.args[1], dict) and "targets" in c.args[1]]
    assert written, "expected a capture write"
    keys = [t["key"] for t in written[0]]
    # Namespaced, so proving "Nash Equilibrium" cannot MERGE onto a vault note or flip a
    # learning goal of the same name to 'known'.
    assert keys == ["quiz:nash equilibrium"]


def test_ungraded_answer_is_not_captured(graph_writes):
    """A concept the grader says nothing about is unproven, not passed by default."""
    with patch("app.onboarding.asyncio.to_thread", new_callable=AsyncMock) as call:
        call.return_value = _grades(("Something Else", True))
        result = asyncio.run(grade_onboarding([{"concept": "Nash Equilibrium", "answer": "hmm"}]))

    assert result["captured"] == []
    assert result["failed"][0]["concept"] == "Nash Equilibrium"


def test_empty_submission_is_rejected(graph_writes):
    assert "error" in asyncio.run(grade_onboarding([]))
    assert "error" in asyncio.run(grade_onboarding([{"concept": "  ", "answer": "x"}]))


def test_no_openai_key_says_so_rather_than_guessing():
    """There is deliberately no self-report fallback — that's the thing being replaced."""
    with patch("app.onboarding.settings") as settings:
        settings.openai_api_key = ""
        result = asyncio.run(onboarding_questions(5))
    assert "OPENAI_API_KEY" in result["error"]


def test_frontier_falls_back_when_gds_is_missing():
    """Aura's free tier and a plain neo4j image have no GDS; onboarding must still work."""
    from app import onboarding

    calls = []

    async def fake_cypher(query, params=None, **kwargs):
        calls.append(query)
        if "gds." in query:
            raise RuntimeError("no procedure gds.graph.project")
        return [{"term": "PostgreSQL", "pagerank": 9.0, "status": "novel",
                 "serves_goal": None, "video_count": 1, "segment_count": 9,
                 "where_taught": []}]

    with patch.object(onboarding, "execute_cypher", side_effect=fake_cypher):
        terms, used_gds = asyncio.run(onboarding.frontier(5))

    assert used_gds is False
    assert terms[0]["term"] == "PostgreSQL"
    assert any("gds." in q for q in calls), "should have tried GDS first"
