# Delta Learning — hackathon build context

**"The corpus didn't change. I changed."** — Hack the Video Agent Context Graph
(OpenAI + Neo4j + AWS + TwelveLabs), July 30 2026. Submission incl. 3-min demo recording due 4pm.

Fork of `jpadams/video-context-graph` (remote `upstream`). The starter answers "what's in
the videos?" — we answer the question retrieval structurally cannot: **"what's in this video
that the viewer doesn't already know?"** The viewer's knowledge state (Obsidian vault concept
titles + learning goals) lives in the SAME Neo4j graph as the video segments. "What should I
watch?" is a set-difference traversal returning a timecoded cut list. Capturing learned
segments grows the knowledge state, so the next video's cut list shrinks.

## Division of labor — two people, two Claude Code sessions, one repo

**Sameer + his Claude: backend.** Owns `backend/`, `cypher/`, `data/`, `Makefile`.
Runs the shared runtime (Neo4j docker + FastAPI on :8000). Keys live only in his `.env`.

**Luke + his Claude: frontend + garnish.** Owns `frontend/`. Do NOT touch `backend/`.
Tasks, in priority order:
1. **"Your Cut" panel** — renders `GET /api/delta/{video}` (contract below). Timecoded
   watch-ranges with concept badges (novel=orange, goal=blue), skip stats
   ("watch 4:30 of 18:00"), known concepts with their vault-note source, and a
   "Capture learnings" button → `POST /api/capture {video, concepts?}`.
2. **Concept node coloring** in `ContextGraphView.tsx` by `status` using
   `CONCEPT_STATUS_COLORS` in `lib/config.ts` (Concept nodes carry a `status` property).
3. Garnish (only if 1–2 are done): repoint `cypher/gds_projections.cypher` at the real
   ontology (Concept/Topic co-occurrence → Louvain communities, PageRank).

**Runtime topology:** ONE shared backend. Luke does NOT run Neo4j or FastAPI; his dev
server points at Sameer's laptop: `NEXT_PUBLIC_API_URL=http://<sameer-lan-ip>:8000/api npm run dev`.
Ask Sameer for the IP. Frontend-only commits; pull often, push small.

**Fallback rule:** the demo must survive Luke not finishing — chat + default graph view
already demo everything (agent tools return the same data). The panel is polish, not spine.

## The frozen contract — `GET /api/delta/{video}` (video = title fragment or id)

```json
{ "video": {"id": "...", "title": "...", "duration_sec": 1080},
  "stats": {"concepts_total": 14, "known": 11, "novel": 2, "goal_hits": 1,
             "watch_sec": 270, "skip_sec": 810},
  "known_concepts": [{"name": "...", "status": "known", "matched_concept": "...", "source": "note-path.md"}],
  "cuts": [{"start_sec": 192, "end_sec": 340, "summary": "...", "segment_id": "vid#3",
             "concepts": [{"name": "KV-cache eviction", "status": "novel",
                            "why": "not in your knowledge base"}]}] }
```
Also: `POST /api/capture {"video": "...", "concepts": ["..."] | null}` (null = all novel),
`GET /api/watchlist` (videos ranked by novelty).

## Architecture (what's new vs the starter)

- `backend/app/delta.py` — knowledge_delta / capture_learning / rank_videos (core logic)
- `backend/scripts/ingest_vault.py` — vault claim-filenames + `data/learning_goals.yaml`
  → `(:Concept {status: known|goal, embedding})`. Titles only, never note bodies.
- `backend/scripts/resolve_concepts.py` — Marengo embedding cosine candidates + one OpenAI
  structured-outputs adjudication → `(Topic|Entity)-[:SAME_AS]->(Concept)` edges
- Agent tools (`backend/app/agent.py`): `knowledge_delta`, `capture_learning`,
  `what_should_i_watch` + the starter's five. Tool results auto-render in the graph panel.
- Sponsor stack: TwelveLabs Pegasus (analyze) + Marengo (index/embed, both sides of the
  match), OpenAI (structuring, adjudication, agent brain), Strands (orchestration), Neo4j (graph).

## Commands

- `make docker-up` → Neo4j (Sameer only) · `make install` · `make start` (backend+frontend)
- Ingest: `make seed VIDEOS="data/videos/x.mp4 ..."` → `make vault` → `make resolve`
  (or `make demo-seed`). yt-dlp fetches talks: `yt-dlp -f "mp4" -o "data/videos/%(title)s.mp4" <url>`
- Re-ingest is idempotent. `make reset` wipes the DB — never run it without asking Sameer.

## Deadline discipline

Hard stop building 3:00pm → rehearse demo 3:00–3:15 → record 3:15–3:45 → submit 4:00.
When in doubt: cut scope, keep the chat demo working end-to-end.
