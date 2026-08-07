# API

| Method + path | Purpose |
|---|---|
| `GET /api/delta/{video}` | **The cut list.** `video` = id or title fragment. Returns `stats` (`known` / `novel` / `goal_hits` / `watch_sec` / `skip_sec`), `known_concepts` with the vault note that covers each, `cuts` (timecoded, with per-concept `why`), plus `skipped` and `minor_concepts`. |
| `POST /api/capture` | `{"video": "...", "concepts": [...] \| null}` — null captures everything the cut list recommended. |
| `GET /api/quiz/{video}?count=5` | Questions (with answer keys) testing whether the viewer *already* knows what this video teaches. |
| `GET /api/onboarding/questions?count=5` · `POST /api/onboarding/grade` · `GET /api/onboarding/progress` | **Bootstrap a knowledge state without a vault.** Corpus-wide, highest-leverage concepts first. Ask in small batches — the frontier recomputes each call, so later rounds skip what earlier ones proved. Needs an OpenAI key. |
| `GET /api/watchlist` | All ingested videos ranked by novelty density for this viewer. |
| `POST /api/chat` · `/api/chat/stream` | Agent turn (one-shot / SSE). |
| `GET /api/videos` · `/api/videos/{id}/segments` | Corpus + segments in order. |
| `POST /api/search` | Live multimodal Marengo search over the raw video. |
| `POST /api/quiz/grade` | Grades free-text answers and captures **only** what the viewer proved. |
| `GET /api/knowledge` · `/api/knowledge-map` | The viewer's knowledge state; concept graph coloured by status. |
| `GET /api/curriculum` · `/api/coverage` | Ordered units through the corpus; which goals it can and cannot teach. |
| `GET /api/discover/{goal}` | Real outside-corpus videos for a goal the library cannot teach. |
| `POST /api/ingest` · `GET /api/ingest/{job_id}` | Ingest a video by URL; poll the job. |
| `GET /api/schema` · `POST /api/expand` · `POST /api/cypher` | Graph schema, drill-down, read-only Cypher. |
| `GET /health` | Backend + Neo4j status. |

**Agent tools** (Strands, 15): `knowledge_delta` · `capture_learning` · `quiz_me` ·
`onboarding_quiz` · `grade_onboarding` · `what_should_i_watch` · `learning_path` ·
`learning_frontier` (GDS PageRank) · `find_outside_material` · `add_video` ·
`search_video_moments` · `explore_graph` · `twelvelabs_search` · `run_cypher` ·
`get_graph_schema`.

The first ten are new here; the last five come from the starter.

---
