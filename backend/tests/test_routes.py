"""Tests for the Video Context Graph API."""

import os
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

# Set a placeholder before the Strands agent is imported. Unit tests never
# make an OpenAI request.
os.environ.setdefault("OPENAI_API_KEY", "test-placeholder")

from app.main import app


@pytest.fixture(autouse=True)
def mock_backend():
    """Mock only the video application's actual Neo4j lifecycle."""
    with (
        patch("app.main.connect_neo4j", new_callable=AsyncMock),
        patch("app.main.close_neo4j", new_callable=AsyncMock),
        patch("app.main.is_connected", return_value=True),
        patch("app.routes.is_connected", return_value=True),
    ):
        yield


client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["domain"] == "video-context-graph"


def test_scenarios():
    response = client.get("/api/scenarios")
    assert response.status_code == 200
    data = response.json()
    assert data["domain"] == "Delta Learning"
    assert {scenario["name"] for scenario in data["scenarios"]} == {
        "What's new to me",
        "Grow the knowledge base",
        "Explore",
    }


def test_discover_drops_ingested_and_caps_channels(monkeypatch):
    """Outside-corpus search must never recommend a video already in the library, and
    one lecture series must not fill every slot. No network: yt-dlp is stubbed."""
    import asyncio

    from app import discover

    # The ingested title carries a FULLWIDTH COLON and underscores, exactly as yt-dlp
    # wrote it at download time — the case a naive ASCII compare misses.
    ingested = {discover._norm("Game Theory： A Simple Strategy_ Explained")}
    fake = [
        {"video_id": "aaa", "title": "Game Theory: A Simple Strategy - Explained",
         "url": "u", "channel": "Corpus", "duration_sec": 600, "view_count": 1000},
        {"video_id": "bbb", "title": "Speculative decoding deep dive",
         "url": "u", "channel": "Series", "duration_sec": 900, "view_count": 5000},
        {"video_id": "ccc", "title": "Speculative decoding part 2",
         "url": "u", "channel": "Series", "duration_sec": 900, "view_count": 4000},
        {"video_id": "bbb", "title": "Speculative decoding deep dive",
         "url": "u", "channel": "Series", "duration_sec": 900, "view_count": 5000},
        {"video_id": "ddd", "title": "Speculative decoding from scratch",
         "url": "u", "channel": "Other", "duration_sec": 900, "view_count": 3000},
    ]
    monkeypatch.setattr(discover, "_yt_search", lambda q, n=5: list(fake))
    monkeypatch.setattr(discover, "_CACHE", {})

    gap = asyncio.run(discover._recommend("speculative decoding", 0, [], ingested, 3))

    assert [r["video_id"] for r in gap["recommendations"]] == ["bbb", "ddd"]
    assert gap["already_in_your_library"] == ["Game Theory: A Simple Strategy - Explained"]
    assert gap["recommendations"][0]["fills_gap"] == (
        "nothing in your library teaches 'speculative decoding'"
    )


def test_discover_survives_missing_ytdlp(monkeypatch):
    """A missing or hanging binary must degrade to a clear message, never a 500."""
    from app import discover

    monkeypatch.setattr(discover.subprocess, "run",
                        lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError()))
    assert discover._yt_search("anything") == []
