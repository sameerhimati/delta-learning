"""Ingest a video from a pasted URL, in the background.

This closes the demo's loop: the agent admits a gap ("nothing in your library
teaches speculative decoding"), recommends real material, the viewer pastes the
link, and the corpus grows. Measured here, indexing + analysis runs 2-3 minutes,
so no HTTP request can wait on it. ``start_ingest()`` validates, de-duplicates
and returns a job id immediately; ``get_job()`` reports the stage the pipeline is
in; ``wait_for_job()`` is for scripts and tests that genuinely want to block.

Pipeline reuse: every step below is scripts/ingest.py or
scripts/resolve_concepts.py. The one thing this module deliberately does NOT
call is ``ingest.ingest_new()`` — that helper runs the TwelveLabs upload,
Pegasus analysis and Marengo embedding synchronously on whatever event loop
awaits it, which is fine for a CLI and fatal for the API server (it would freeze
every other request for minutes). Here the synchronous legs run in worker
threads and only the Neo4j writes touch the loop.

YouTube: TwelveLabs fetches a video URL server-side, but a youtube.com watch
page is not a video file. Those URLs are downloaded with yt-dlp first and
uploaded as a file — which is exactly how the demo corpus was built. Direct
.mp4-style links skip the download and go to TwelveLabs as a URL.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from app.config import settings
from app.context_graph_client import execute_cypher

logger = logging.getLogger(__name__)

# scripts/ is a PEP 420 namespace package next to app/; importing it needs the
# backend dir on sys.path when the server was started from somewhere else.
_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

# TwelveLabs caps uploads at 2 hours; refuse absurd input (livestreams, 10-hour
# mixes) before spending minutes downloading it.
MAX_DURATION_SEC = 7200
# Enough headroom for a slow conference-video download; a stuck job should fail,
# not sit in "downloading" forever.
DOWNLOAD_TIMEOUT_SEC = 900
PROBE_TIMEOUT_SEC = 60
# Keep upload size sane: 720p is plenty for Pegasus and Marengo.
YTDLP_FORMAT = "best[ext=mp4][height<=720]/bestvideo[height<=720]+bestaudio/best[ext=mp4]/best"
# YouTube bot-checks unauthenticated requests from some networks/IPs ("Sign in to
# confirm you're not a bot"), and it can start doing so mid-session. Cookies are
# the documented escape hatch, so every yt-dlp command retries with them.
# Browser cookies need Keychain access, which a background process does not always
# get ("cannot decrypt v10 cookies: no key found") — YTDLP_COOKIES points at a
# cookies.txt exported from a signed-in browser and needs no Keychain at all.
COOKIE_BROWSER = os.getenv("YTDLP_COOKIE_BROWSER", "chrome")
COOKIE_FILE = os.getenv("YTDLP_COOKIES", "")

_VIDEO_FILE_EXT = (".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mpg", ".mpeg", ".ts")

STATUSES = ("queued", "downloading", "indexing", "analyzing", "writing",
            "resolving", "done", "failed")


# ---------------------------------------------------------------------------
# URL validation
# ---------------------------------------------------------------------------

def _is_private_host(host: str) -> bool:
    host = host.strip("[]").lower()
    if host in ("localhost", "") or host.endswith(".local") or host.endswith(".internal"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved


def validate_url(url: str) -> tuple[str, str | None]:
    """Return (clean_url, error). Only public http(s) URLs are accepted.

    A filesystem path must never reach the pipeline through this API:
    ``ingest.ingest_new`` treats any non-http input as a local file, which would
    turn a paste box into "read any file on Sameer's laptop and upload it to
    TwelveLabs". Private/loopback hosts are refused for the same reason — the
    downloader would happily fetch from 169.254.169.254 or localhost:8000.
    """
    url = (url or "").strip()
    if not url:
        return "", "No URL given."
    parsed = urlparse(url)
    if parsed.scheme.lower() not in ("http", "https"):
        return url, ("Only http(s) URLs can be ingested — got "
                     f"'{parsed.scheme or url[:20]}'. Local file paths are not accepted.")
    if not parsed.netloc or _is_private_host(parsed.hostname or ""):
        return url, "That URL does not point at a public host."
    return url, None


def _youtube_id(parsed) -> str | None:
    host = (parsed.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    if host == "youtu.be":
        return parsed.path.strip("/").split("/")[0] or None
    if host in ("youtube.com", "music.youtube.com"):
        if parsed.path == "/watch":
            vals = parse_qs(parsed.query).get("v")
            return vals[0] if vals else None
        m = re.match(r"^/(?:shorts|embed|live|v)/([^/?#]+)", parsed.path)
        if m:
            return m.group(1)
    return None


def canonical_url(url: str) -> str:
    """Collapse the many spellings of one video to a single comparable string.

    youtu.be/X, /shorts/X and watch?v=X&t=90 are all the same video; without this
    a viewer who pastes a share link re-ingests something already in the graph.
    """
    parsed = urlparse(url)
    vid = _youtube_id(parsed)
    if vid:
        return f"https://www.youtube.com/watch?v={vid}"
    return url.split("#", 1)[0].rstrip("/")


def _is_direct_video_url(url: str) -> bool:
    return urlparse(url).path.lower().endswith(_VIDEO_FILE_EXT)


# ---------------------------------------------------------------------------
# yt-dlp (probe + download)
# ---------------------------------------------------------------------------

def _ytdlp_bin() -> str | None:
    return shutil.which("yt-dlp")


def _run_ytdlp(args: list[str], timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(["yt-dlp", *args], capture_output=True, text=True, timeout=timeout)


def _ytdlp_reason(stderr: str) -> str:
    """One readable line out of yt-dlp's noise — never a stack trace."""
    errors = [ln for ln in stderr.splitlines() if ln.startswith("ERROR")]
    line = (errors[-1] if errors else stderr.strip().splitlines()[-1] if stderr.strip()
            else "yt-dlp failed with no output")
    line = line.removeprefix("ERROR:").strip()
    if "not a bot" in line or "Sign in to confirm" in line:
        return ("YouTube is rate-limiting this machine as a bot. Export cookies from a "
                "signed-in browser and restart the server with YTDLP_COOKIES=<cookies.txt>, "
                "or ingest the same talk from another host.")
    if "Private video" in line or "members-only" in line.lower():
        return "That video is private or members-only, so it can't be downloaded."
    if "Video unavailable" in line:
        return "That video is unavailable at this URL."
    return line[:300]


def _cookie_attempts() -> list[list[str]]:
    """Anonymous first, browser cookies second.

    Measured: reading a YouTube page's metadata works anonymously while
    downloading its formats gets bot-checked, so each yt-dlp command has to be
    able to escalate on its own rather than inherit the previous one's verdict.
    """
    attempts: list[list[str]] = [[]]
    if COOKIE_FILE:
        attempts.append(["--cookies", COOKIE_FILE])
    if COOKIE_BROWSER:
        attempts.append(["--cookies-from-browser", COOKIE_BROWSER])
    return attempts


def probe_url(url: str) -> dict:
    """Read title/duration without downloading. Returns {title, duration_sec}.
    Raises RuntimeError with a readable reason."""
    if not _ytdlp_bin():
        raise RuntimeError("yt-dlp is not installed, so page URLs can't be fetched. "
                           "Paste a direct video file URL instead.")
    base = ["--no-playlist", "--skip-download", "--print", "%(title)s\t%(duration)s", url]
    last = ""
    for cookie_args in _cookie_attempts():
        try:
            proc = _run_ytdlp([*cookie_args, *base], PROBE_TIMEOUT_SEC)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"Timed out reading that URL ({PROBE_TIMEOUT_SEC}s).")
        if proc.returncode == 0 and proc.stdout.strip():
            title, _, dur = proc.stdout.strip().splitlines()[0].partition("\t")
            try:
                duration = float(dur)
            except ValueError:
                duration = None  # a live stream has no length
            return {"title": title.strip(), "duration_sec": duration}
        last = _ytdlp_reason(proc.stderr)
    raise RuntimeError(last)


def download_url(url: str, dest_dir: str) -> str:
    """Download into an empty dir and return the file path."""
    base = ["--no-playlist", "-f", YTDLP_FORMAT, "-o", "%(title).150B.%(ext)s",
            "--paths", dest_dir, url]
    last = ""
    for cookie_args in _cookie_attempts():
        try:
            proc = _run_ytdlp([*cookie_args, *base], DOWNLOAD_TIMEOUT_SEC)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f"Download timed out after {DOWNLOAD_TIMEOUT_SEC // 60} minutes.")
        if proc.returncode == 0:
            files = [p for p in Path(dest_dir).iterdir()
                     if p.is_file() and not p.name.startswith(".")]
            if files:
                return str(max(files, key=lambda p: p.stat().st_size))
            last = "yt-dlp reported success but produced no file."
        else:
            last = _ytdlp_reason(proc.stderr)
        for p in Path(dest_dir).iterdir():  # clear partial files before retrying
            p.unlink(missing_ok=True)
    raise RuntimeError(last)


# ---------------------------------------------------------------------------
# Jobs (in-memory — a hackathon does not need these to survive a restart)
# ---------------------------------------------------------------------------

@dataclass
class IngestJob:
    id: str
    url: str
    status: str = "queued"
    message: str = "Queued."
    title: str | None = None
    duration_sec: float | None = None
    video_id: str | None = None
    segment_count: int | None = None
    resolution: dict | None = None
    needs_resolution: bool = False
    error: str | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    task: asyncio.Task | None = field(default=None, repr=False)

    def stage(self, status: str, message: str) -> None:
        self.status = status
        self.message = message
        logger.info("[ingest %s] %s — %s", self.id, status, message)

    def to_dict(self) -> dict:
        end = self.finished_at or time.time()
        return {
            "job_id": self.id, "url": self.url, "status": self.status,
            "message": self.message, "title": self.title,
            "duration_sec": self.duration_sec, "video_id": self.video_id,
            "segment_count": self.segment_count,
            "resolution": self.resolution,
            # True only when the caller asked to skip resolution: until it runs,
            # the new video's terms have no SAME_AS/ADVANCES edges and its whole
            # runtime reads as novel.
            "needs_resolution": self.needs_resolution,
            "error": self.error,
            "elapsed_sec": round(end - self.started_at, 1),
            "done": self.status in ("done", "failed"),
        }


_JOBS: dict[str, IngestJob] = {}
_MAX_JOBS = 50


def _register(job: IngestJob) -> None:
    _JOBS[job.id] = job
    if len(_JOBS) > _MAX_JOBS:  # drop the oldest finished jobs
        for jid, j in sorted(_JOBS.items(), key=lambda kv: kv[1].started_at):
            if len(_JOBS) <= _MAX_JOBS:
                break
            if j.status in ("done", "failed"):
                _JOBS.pop(jid, None)


def get_job(job_id: str) -> dict | None:
    """Poll one job. Plain sync function so an agent tool can call it directly."""
    job = _JOBS.get(job_id)
    return job.to_dict() if job else None


def list_jobs(limit: int = 20) -> list[dict]:
    """Most recent jobs first."""
    jobs = sorted(_JOBS.values(), key=lambda j: j.started_at, reverse=True)
    return [j.to_dict() for j in jobs[:limit]]


async def wait_for_job(job_id: str, timeout: float = 1200.0, poll: float = 2.0) -> dict | None:
    """Block until a job finishes (for scripts/tests, never for a request handler)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        snap = get_job(job_id)
        if snap is None or snap["done"]:
            return snap
        await asyncio.sleep(poll)
    return get_job(job_id)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def _title_key(title: str | None) -> str:
    """Letters and digits only. yt-dlp rewrites a title into a filename before
    upload (':' becomes '：', '/' becomes '⧸'), and the demo corpus was ingested
    that way — so the stored title never equals the YouTube title exactly.
    """
    return re.sub(r"[^a-z0-9]+", "", (title or "").lower())


async def find_ingested(url: str, title: str | None = None) -> dict | None:
    """Is this video already in the graph? Matches the pasted URL, falling back
    to the title because the demo corpus was ingested from downloaded files and
    carries a TwelveLabs HLS url, not the YouTube link it came from.
    """
    # Returning the node rather than v.source_url keeps Neo4j from warning about a
    # property key that only exists on URL-ingested videos.
    rows = await execute_cypher(
        """
        MATCH (v:Video)
        OPTIONAL MATCH (v)-[:HAS_SEGMENT]->(s:Segment)
        RETURN v, count(s) AS segment_count
        """,
        collect=False,
    )
    key = _title_key(title)
    for r in rows:
        v = r["v"]
        if url in (v.get("source_url"), v.get("url")) or (key and _title_key(v.get("title")) == key):
            return {"id": v.get("id"), "title": v.get("title"),
                    "duration_sec": v.get("duration_sec"),
                    "segment_count": r["segment_count"]}
    return None


async def start_ingest(url: str, *, resolve: bool = True) -> dict:
    """Validate a URL and kick off ingestion in the background.

    Returns immediately with one of:
      {"error": ...}                     — rejected, nothing started
      {"status": "already_ingested", ...} — the graph already has this video
      {job dict, "status": "queued"}      — poll get_job(job_id)

    ``resolve=False`` skips the resolution pass and flags needs_resolution.
    """
    url, err = validate_url(url)
    if err:
        return {"error": err}
    url = canonical_url(url)

    for job in _JOBS.values():  # a double-clicked button must not ingest twice
        if job.url == url and job.status not in ("done", "failed"):
            return {"status": "in_progress", "job": job.to_dict(),
                    "message": f"Already ingesting that URL (job {job.id})."}

    direct = _is_direct_video_url(url)
    title = duration = None
    if not direct:
        # Probing first costs a few seconds and buys three things: the real title
        # (so dedup and the job display are readable), the runtime (so a
        # 10-hour livestream is refused before it is downloaded), and a fast,
        # honest failure for a dead link.
        try:
            info = await asyncio.to_thread(probe_url, url)
        except Exception as e:
            return {"error": str(e)}
        title, duration = info["title"], info["duration_sec"]
        if duration is None:
            return {"error": "That URL has no fixed length — a live stream can't be "
                             "indexed. Paste a recording instead."}
        if duration > MAX_DURATION_SEC:
            return {"error": f"That video is {duration / 3600:.1f} hours long; the "
                             f"limit is {MAX_DURATION_SEC // 3600} hours."}

    existing = await find_ingested(url, title)
    if existing:
        return {
            "status": "already_ingested",
            "video": existing,
            "message": (f"'{existing['title']}' is already in the graph "
                        f"({existing['segment_count']} segments) — nothing re-ingested."),
        }

    job = IngestJob(id=uuid.uuid4().hex[:8], url=url, title=title, duration_sec=duration)
    job.needs_resolution = not resolve
    job.message = (f"Queued '{title}'." if title else "Queued.")
    _register(job)
    # Strong reference on the job: a bare create_task can be garbage-collected
    # mid-flight, which would silently strand the job in "queued".
    job.task = asyncio.create_task(_run_job(job, direct=direct, resolve=resolve))
    return job.to_dict()


# ---------------------------------------------------------------------------
# The job itself
# ---------------------------------------------------------------------------

def _analyze_sync(job: IngestJob, video_id: str, duration_sec: float | None) -> dict:
    """Pegasus -> OpenAI structure -> Marengo embeddings. All blocking, so this
    whole function runs in a worker thread; it only mutates the job's message."""
    from app import twelvelabs_client as tl
    from scripts import ingest as ing

    # Same output budget as scripts/ingest.py: at ~45s per segment a 45-minute
    # talk needs tens of them, and the stock cap truncates the analysis midway.
    minutes = (duration_sec or 0) / 60
    max_tokens = max(2000, min(4096, int(minutes * 300)))
    job.message = "Pegasus is watching the video…"
    pegasus_text = tl.analyze_video(video_id, ing._pegasus_prompt(duration_sec),
                                    max_tokens=max_tokens)
    job.message = "Structuring the analysis into segments…"
    structured = ing.structure_with_openai(pegasus_text)

    segments = structured.get("segments", [])
    dim = 0
    for i, s in enumerate(segments):
        job.message = f"Embedding segment {i + 1}/{len(segments)}…"
        basis = " ".join(filter(None, [s.get("summary"), s.get("on_screen_text"),
                                       s.get("transcript")]))
        try:
            vec = tl.embed_text(basis or s.get("summary", ""))
            s["embedding"] = vec
            dim = dim or len(vec)
        except Exception as e:
            logger.warning("[ingest %s] embed failed for a segment: %s", job.id, e)
            s["embedding"] = None
    return {"summary": structured.get("video_summary", ""), "segments": segments, "dim": dim}


async def _run_job(job: IngestJob, *, direct: bool, resolve: bool) -> None:
    from app import twelvelabs_client as tl
    from app.vector_client import ensure_segment_vector_index
    from scripts import ingest as ing

    tmpdir: str | None = None
    try:
        index_id = settings.tl_index_id or await asyncio.to_thread(tl.ensure_index)

        source_file: str | None = None
        if not direct:
            job.stage("downloading", f"Downloading '{job.title or job.url}'…")
            tmpdir = tempfile.mkdtemp(prefix="delta-ingest-")
            source_file = await asyncio.to_thread(download_url, job.url, tmpdir)

        job.stage("indexing", "TwelveLabs is indexing the video (Marengo + Pegasus)…")

        def _on_update(status):
            job.message = f"TwelveLabs indexing: {status}"

        if source_file:
            info = await asyncio.to_thread(
                lambda: tl.ingest_video(index_id, video_file=source_file, on_update=_on_update))
        else:
            info = await asyncio.to_thread(
                lambda: tl.ingest_video(index_id, video_url=job.url, on_update=_on_update))

        video_id = info.get("video_id")
        if not video_id:
            raise RuntimeError(f"TwelveLabs did not return a video id (status: {info.get('status')}).")
        job.video_id = video_id
        job.duration_sec = info.get("duration_sec") or job.duration_sec
        job.title = job.title or (info.get("filename") or job.url.rsplit("/", 1)[-1]).rsplit(".", 1)[0]

        job.stage("analyzing", "Pegasus is watching the video…")
        analysis = await asyncio.to_thread(_analyze_sync, job, video_id, job.duration_sec)
        segments = analysis["segments"]

        job.stage("writing", f"Writing {len(segments)} segments to Neo4j…")
        # A downloaded upload has no public URL to play back, so keep the HLS one
        # in `url` (matching the rest of the corpus) and record where it came from.
        playback = job.url
        if source_file:
            try:
                playback = tl.get_video_meta(index_id, video_id).get("url") or job.url
            except Exception:
                pass
        await ing.write_video(
            {"id": video_id, "title": job.title, "url": playback,
             "duration_sec": job.duration_sec, "summary": analysis["summary"],
             "tl_index_id": index_id},
            segments,
        )
        await execute_cypher(
            "MATCH (v:Video {id: $id}) SET v.source_url = $url",
            {"id": video_id, "url": job.url}, collect=False,
        )
        if analysis["dim"]:
            await ensure_segment_vector_index(analysis["dim"])
        job.segment_count = len(segments)

        if resolve:
            job.stage("resolving", "Matching new concepts against your knowledge base…")
            job.resolution = await _resolve_new_terms(video_id)
        else:
            job.needs_resolution = True

        job.finished_at = time.time()
        res = job.resolution or {}
        job.stage("done", (
            f"Ingested '{job.title}' — {len(segments)} segments"
            + (f", {res.get('same_as', 0)} already-known and {res.get('advances', 0)} "
               f"goal-relevant concepts matched." if resolve
               else ". Resolution not run: everything will read as novel until it is.")
        ))
    except asyncio.CancelledError:
        job.finished_at = time.time()
        job.error = "Cancelled."
        job.stage("failed", "Cancelled.")
        raise
    except Exception as e:
        # The user gets one readable line; the traceback goes to the server log.
        logger.exception("[ingest %s] failed during %s", job.id, job.status)
        job.error = f"{type(e).__name__}: {e}"[:300]
        job.finished_at = time.time()
        job.stage("failed", f"Failed while {job.status}: {job.error}")
    finally:
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Resolution, scoped to the new video
# ---------------------------------------------------------------------------

async def _resolve_new_terms(video_id: str) -> dict:
    """Run scripts/resolve_concepts.py's adjudication over ONLY the terms this
    video added to the corpus.

    Without this the new video has no SAME_AS/ADVANCES edges, so every concept in
    it reads as novel and the cut list is the whole runtime — which is precisely
    the claim this product exists to refute. A full corpus pass takes ~90s and
    re-judges terms that were already resolved; restricting it to the terms that
    arrived with this video costs a fraction of that and is the same computation.

    "New to the corpus" = no cached embedding, which is what resolve_concepts
    writes on every term it has ever considered.
    """
    from scripts import resolve_concepts as rc
    from app.delta import LEARNABLE_ENTITY_TYPES

    new_terms = await execute_cypher(
        """
        MATCH (:Video {id: $vid})-[:HAS_SEGMENT]->(:Segment)-[:ABOUT|MENTIONS]->(x)
        WHERE ((x:Topic) OR (x:Entity AND x.type IN $types)) AND x.embedding IS NULL
        RETURN DISTINCT elementId(x) AS eid
        """,
        {"vid": video_id, "types": LEARNABLE_ENTITY_TYPES},
        collect=False,
    )
    if not new_terms:
        return {"new_terms": 0, "same_as": 0, "advances": 0,
                "note": "Every concept in this video was already resolved."}

    await rc.embed_missing_terms()
    eids = [r["eid"] for r in new_terms]
    terms = await execute_cypher(
        """
        MATCH (x) WHERE elementId(x) IN $eids AND x.embedding IS NOT NULL
        RETURN elementId(x) AS eid, x.name AS name, x.embedding AS emb
        """,
        {"eids": eids}, collect=False,
    )
    concepts = await execute_cypher(
        """
        MATCH (c:Concept) WHERE c.embedding IS NOT NULL
        RETURN elementId(c) AS eid, c.name AS name, c.status AS status, c.embedding AS emb
        """,
        collect=False,
    )
    if not terms or not concepts:
        return {"new_terms": len(new_terms), "same_as": 0, "advances": 0,
                "note": "No embedded concepts to compare against."}

    goals = [c for c in concepts if c["status"] == "goal"]
    same_pairs, goal_pairs = [], []
    for t in terms:
        scored = sorted(((c, rc._cos(t["emb"], c["emb"])) for c in concepts),
                        key=lambda cs: -cs[1])
        same_pairs += [{"topic_eid": t["eid"], "topic_name": t["name"],
                        "concept_eid": c["eid"], "concept_name": c["name"], "score": s}
                       for c, s in scored[:rc.TOP_K]]
        goal_pairs += [{"topic_eid": t["eid"], "topic_name": t["name"],
                        "concept_eid": c["eid"], "concept_name": c["name"],
                        "score": rc._cos(t["emb"], c["emb"])}
                       for c in goals]

    same, advances = await asyncio.gather(
        rc.adjudicate_all(same_pairs, rc.SAME_AS_SYSTEM, "SAME_AS"),
        rc.adjudicate_all(goal_pairs, rc.ADVANCES_SYSTEM, "ADVANCES"),
    )
    return {"new_terms": len(terms), "same_as": len(same), "advances": len(advances),
            "known_matches": sorted({p["concept_name"] for p in same}),
            "goal_matches": sorted({p["concept_name"] for p in advances})}
