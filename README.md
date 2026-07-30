# Delta Learning

**"The corpus didn't change. I changed."**

Built for *Hack the Video Agent Context Graph* (TwelveLabs · OpenAI · Neo4j · AWS), on top of
the [`video-context-graph`](https://github.com/jpadams/video-context-graph) starter.

---

## The wedge

Every video-understanding tool answers **"what's in this video?"** — search, summarize,
timestamp, chapterize. That question is retrieval, and retrieval is a solved product.

It is also the wrong question for a person with 45 minutes of talk and 10 minutes to spend.
The question that matters is **"what's in this video that I don't already know?"** — and no
retrieval system can answer it, because the answer isn't a property of the video. It's the
difference between the video and *the viewer*.

So we put the viewer in the graph. The viewer's knowledge state — concepts from their
Obsidian vault plus their stated learning goals — lives as `(:Concept)` nodes in the **same
Neo4j graph** as the video segments, linked to video terms by resolved `SAME_AS` / `ADVANCES`
edges. Once both sides are nodes in one graph, "what should I watch?" stops being a ranking
problem and becomes a **set difference you can traverse**, returning a timecoded cut list.

And it compounds: capture what a video taught you, and the knowledge state grows, and the
*next* video's cut list shrinks. Same corpus, less to watch.

---

## The measured beat

Two game-theory talks, ingested independently, no shared metadata — just shared concepts
that MERGE'd into the same graph nodes.

```
Game Theory B ("A Simple Strategy…", 17:46)   BEFORE   watch 16:08 · 2 cuts · 0 known concepts

  → watch Game Theory A ("How Decision Making…", 9:50)
    POST /api/capture {"video": "How Decision Making"}      captures 11 concepts

Game Theory B                                  AFTER   watch 10:16 · 3 cuts · 3 known concepts
                                                        cuts: 5:08–5:52 · 7:20–10:16 · 11:44–17:36
```

**36% less to watch. 5:52 saved on one talk, from having watched a different one.**

And the agent says *why*, out loud, citing the source:
> *"Skip 0:00–5:08 … you learned that from* How Decision Making is Actually Science.*"*

The six concepts it now skips — Game Theory, Prisoner's Dilemma, Dominant Strategy — are
`(:Concept {source:'video'})` nodes created by the capture, reached through the `SAME_AS`
edges on terms that both talks share.

Other verified reads on the same graph:

| Question | Answer |
|---|---|
| "What in the L8 agentic-engineering talk is new to me?" | watch **43:03 of 45:46** — 51 novel + 15 goal-aligned terms, with the 5 real overlaps cited back to the vault notes that cover them (`agent-harnesses.md`, `05-memory.md`, `02-the-agent-loop.md`) |
| "What about the Postgres talk?" | watch **all of 0:00–8:06** — 0 known overlap, so nothing is safe to skip, and it says so |
| "Which of my goals does this corpus cover?" | 1 of 8 strictly linked (game theory); volunteers that Postgres/L8 *support* two more without a strict link, and that KV-cache, GPU memory hierarchy and speculative decoding have **no** coverage |
| "What should I learn first?" | Neo4j **GDS PageRank** over the co-occurrence graph of terms the viewer does *not* know → PostgreSQL (5.15), and the rule is explained |

---

## How it works

### 1. Ingest — video → graph

```
video ──TwelveLabs index (Marengo)──▶ Pegasus analyze  ──▶ timecoded prose
      ──OpenAI structured outputs──▶ segments {summary, on-screen text, transcript,
                                               ≤3 genuinely-teachable topics, entities}
      ──Marengo embed (512-d)─────▶ Neo4j: Video/Segment + MERGE'd Topic/Entity + vector index
```

Topics and Entities are keyed on their normalized name, so a term taught in two videos is
**one node with two teachers**. That MERGE is what makes cross-video transfer possible at all.

### 2. Knowledge state — the viewer → the same graph

`backend/scripts/ingest_vault.py` walks an Obsidian vault and takes **filenames only, never
note bodies** — the vault is written claim-per-file, so the filename *is* the claim. Plus
`data/learning_goals.yaml` for things the viewer wants to learn but doesn't know yet.

```
(:Concept {status: 'known', source: 'vault', note_path})   # 109 — what they've written down
(:Concept {status: 'goal',  source: 'goals'})              #   8 — what they want
(:Concept {status: 'known', source: 'video', key: 'video:…'})  # captured, grows over time
```

Every concept name is embedded with Marengo into the **same 512-d space as the video
segments**, behind a second Neo4j vector index (`concept_embeddings`).

### 3. Resolution — connect the two sides

`backend/scripts/resolve_concepts.py` — this is the hard part, and string equality does not
solve it. Vault concepts are claim-shaped (*"test the workflow before reaching for an agent"*);
video terms are bare noun phrases (*"Agent Orchestration"*). Marengo embeds those far apart
even when they mean the same thing (median best-match cosine on this corpus: **0.43**), so
there is no cosine threshold that accepts true matches without also accepting noise.

So the two models split the job by what each is good at:

- **Marengo ranks** — top-8 nearest Concepts per video term. It never rejects.
- **OpenAI adjudicates** — structured outputs, two passes with different questions:
  - *identity* ("is the video term the same concept this note is about?") → `SAME_AS`
  - *topical relevance* ("would a section on this term help someone pursuing this goal?")
    → `ADVANCES`. Goals are broad, video terms are specific; identity would never fire here.

Non-destructive — nothing merges, so every verdict is inspectable in the graph. A term can be
both `SAME_AS` a known concept and `ADVANCES` a goal, and both edges stand.

### 4. The delta traversal

```
(:Video)-[:HAS_SEGMENT]->(:Segment)-[:ABOUT|MENTIONS]->(:Topic|:Entity)
(:Topic|:Entity)-[:SAME_AS]->(:Concept {status: 'known'})   // skip it
(:Topic|:Entity)-[:ADVANCES]->(:Concept {status: 'goal'})   // watch it
```

Per learnable term: `known` > `goal` > `novel`. **Evidence beats aspiration** — a term you
demonstrably know is skippable even if it also serves a goal, otherwise capture could never
shrink a cut list.

A segment enters the cut list on **novelty density**, not on novelty: at least half its
learnable terms must be new (`MIN_NOVELTY_DENSITY = 0.5` in `backend/app/delta.py`). The
old "any new term keeps the segment" rule put 34/34, 11/11 and 24/25 segments in the cut
lists and pinned every video at *watch 100%*. Sitting through 44 seconds for one unfamiliar
term out of five is exactly the waste this product removes — the term still appears in the
response as a badge, and reading it is cheaper than watching it. Adjacent kept segments
merge into contiguous ranges; dropped-but-not-empty ranges are returned under `skipped`
with their concepts, so a skip can be *explained* rather than silently vanish.

### 5. Capture — the loop that closes

`POST /api/capture` (or "I just watched that") turns everything the cut list told you to
watch into `(:Concept {status:'known', source:'video'})` nodes, wired back to the video terms
with `SAME_AS`. Captured concepts are namespaced `video:…` so capturing a term named "Game
Theory" cannot MERGE onto — and silently delete — the *learning goal* of the same name.

### 6. Quiz — closing the loop from the other side

The vault is evidence of what the viewer **wrote down**, not of what they **know**. That gap
is why every video starts out reading "watch 91–100%".

`GET /api/quiz/{video}` (and the `quiz_me` agent tool) generates one short question per
concept a video would teach — about the concept itself, never trivia about the video — with
an answer key. The agent asks them, grades the replies, and calls `capture_learning` with
**only** the concepts answered correctly. Prove a concept, and it becomes `known` immediately
without sitting through the video that teaches it. Get it wrong and nothing is captured.

---

## Where each sponsor is load-bearing

| Sponsor | Used for | Why it's structural, not decorative |
|---|---|---|
| **TwelveLabs — Pegasus** | `analyze` → timecoded description of each video | The only source of *what happens when*. Cut lists are timecodes; without Pegasus there is nothing to cut. |
| **TwelveLabs — Marengo** | indexing + embedding **both sides**: video terms *and* vault concepts, one 512-d space | This is the load-bearing one. Video terms and a person's notes are only comparable because the same model embedded both. It ranks candidates for resolution and powers segment vector search. |
| **OpenAI — `gpt-5.6`** | Strands agent brain (`OpenAIResponsesModel`) | Runs the tools, grades the quiz, and narrates *why* a range is skippable. |
| **OpenAI — structured outputs (`gpt-5.6-terra`)** | Pegasus prose → typed segments; resolution adjudication; quiz generation | Every schema-validated boundary in the pipeline. The `SAME_AS` / `ADVANCES` acceptance gate *is* an OpenAI structured-output verdict. |
| **AWS Strands** | agent + tool orchestration, SSE streaming, 10 tools | Tool results stream to the frontend and auto-render into the graph panel. |
| **Neo4j** | the graph; 2 vector indexes (`segment_embeddings`, `concept_embeddings`); **GDS 2.13.2** | Viewer and corpus in one graph is the entire premise. GDS PageRank runs over a Cypher-projected co-occurrence graph of terms the viewer does *not* know — that's "what should I learn first". See [`cypher/gds_projections.cypher`](cypher/gds_projections.cypher). |

Current demo graph: **4 videos · 83 segments · 63 topics + 109 entities · 117 concepts**
(109 vault + 8 goals) · ~58 `SAME_AS` · ~196 `ADVANCES`.

---

## Honest limitations

- **The vault is evidence of what was written down, not of what is known.** Someone can
  understand Nash equilibria perfectly and have never made a note about them. This is the
  system's biggest weakness and it is exactly why `quiz_me` exists — but the quiz is
  per-video and reactive; there is no onboarding pass that bootstraps a knowledge state.
- **Before any capture, every video in this corpus reads 91–100% watch.** That is honest,
  not a bug: this vault genuinely contains no game theory and no Postgres, and little on
  agentic engineering. Widening the vault scan from one folder to four moved it 33 → 109
  concepts and that is the ceiling. The contrast in the demo is produced by the **capture
  loop**, not by vault overlap, and the agent says so rather than pretending otherwise.
- **Pegasus segmentation is approximate.** Boundaries and timestamps drift, and analyze is
  capped at 4096 output tokens, so a 45-minute talk gets coarser segments than a 9-minute
  one (~34 segments max). Cut ranges are clamped to the real runtime because Pegasus
  timestamps can overrun it.
- **Resolution is LLM-adjudicated, so it has a taste.** No cosine floor rejects candidates
  (that measurably rejected true matches), which puts the whole precision burden on the
  adjudicator. Verdicts are stored as edges precisely so they can be audited.
- **`/api/watchlist` ranks only ingested videos** — it cannot recommend something not
  already in the graph.

---

## Run it

**Prerequisites:** [uv](https://docs.astral.sh/uv/) (Python 3.10–3.13) · Node 18+ ·
Docker (or Neo4j Aura) · OpenAI + TwelveLabs API keys.

```bash
cp .env.example .env      # NEO4J_*, OPENAI_API_KEY, TWELVE_LABS_API_KEY
make docker-up            # local Neo4j 5.26 — docker-compose ships APOC + GDS 2.13.2
make install              # uv sync + npm install

# build the graph
make seed VIDEOS="data/videos/talk-a.mp4 data/videos/talk-b.mp4"   # video side
make vault                                                          # viewer side
make resolve                                                        # link the two
#   make demo-seed  runs all three in order (seed → vault → resolve)

make start                # backend :8000 + frontend :3000
```

Open **http://localhost:3000** and ask *"I don't have 20 minutes — what in this talk is
actually new to me?"*

Notes:

- `make seed` with **no** `VIDEOS=` ingests every `.mp4` in `data/videos/` (falling back to
  `SAMPLE_VIDEO_URLS`), including the vendored Big Buck Bunny sample. Pass explicit paths
  for a real corpus.
- Already indexed in TwelveLabs? Skip the upload:
  `make seed VIDEOS="--index-id=<TL_INDEX_ID> --video-id=<TL_VIDEO_ID>"`.
- `make vault` defaults to the author's vault folders. Point it at yours:
  `cd backend && uv run python scripts/ingest_vault.py --vault-dir=~/notes --vault-dir=~/ideas`
- Ingestion is idempotent — re-seeding replaces a video's segments, never duplicates them.
- `make test` — backend pytest + frontend `tsc --noEmit` + e2e discovery.

### Reset capture artifacts between demos

Capture is the finale, so rehearsing spends it. This puts the graph back to the clean
pre-capture state without touching the vault or goal concepts (different key namespace):

```cypher
MATCH (c:Concept) WHERE c.key STARTS WITH 'video:' DETACH DELETE c
```

> `make reset` exists and **wipes the entire Neo4j database** — videos, segments, vault,
> goals, everything. It is not the demo reset. Use the Cypher above.

---

## API

| Method + path | Purpose |
|---|---|
| `GET /api/delta/{video}` | **The cut list.** `video` = id or title fragment. Returns `stats` (`known` / `novel` / `goal_hits` / `watch_sec` / `skip_sec`), `known_concepts` with the vault note that covers each, `cuts` (timecoded, with per-concept `why`), plus `skipped` and `minor_concepts`. |
| `POST /api/capture` | `{"video": "...", "concepts": [...] \| null}` — null captures everything the cut list recommended. |
| `GET /api/quiz/{video}?count=5` | Questions (with answer keys) testing whether the viewer *already* knows what this video teaches. |
| `GET /api/watchlist` | All ingested videos ranked by novelty density for this viewer. |
| `POST /api/chat` · `/api/chat/stream` | Agent turn (one-shot / SSE). |
| `GET /api/videos` · `/api/videos/{id}/segments` | Corpus + segments in order. |
| `POST /api/search` | Live multimodal Marengo search over the raw video. |
| `GET /api/schema` · `POST /api/expand` · `POST /api/cypher` | Graph schema, drill-down, read-only Cypher. |
| `GET /health` | Backend + Neo4j status. |

**Agent tools** (Strands): `knowledge_delta` · `capture_learning` · `quiz_me` ·
`what_should_i_watch` · `learning_frontier` (GDS PageRank) · `search_video_moments` ·
`explore_graph` · `twelvelabs_search` · `run_cypher` · `get_graph_schema`.

The first five are new here; the last five come from the starter.

---

## Roadmap

- **Quiz-driven onboarding.** Today the quiz is per-video and reactive. The real fix for
  "watch 100% of it" is a bootstrap pass at signup: adaptive quizzing over the frontier of
  the graph until the knowledge state reflects what the person actually knows, not what they
  happened to take notes on.
- **Rank videos from outside the corpus.** `/api/watchlist` can only rank the four videos
  already ingested. The same delta math run against a TwelveLabs index — or a YouTube search
  — turns "what should I watch?" from a re-ranker into a recommender.
- **Spaced repetition over captured concepts.** Every captured concept has a timestamp and a
  source segment. Decay `status` over time and the graph can re-surface a 12-second range
  from a talk you watched two months ago, instead of assuming knowledge is permanent.

---

## Attribution

Started from [`video-context-graph`](https://github.com/jpadams/video-context-graph) /
[create-context-graph](https://github.com/neo4j-labs/create-context-graph). The starter's
ingest pipeline, NVL graph view, and five generic graph tools are its work; the knowledge
state, resolution pass, delta traversal, capture loop, quiz, GDS projections, and the
"Your Cut" panel are ours.

The vendored sample clip `data/videos/bbb_1080p_30fps_normal_85sec.mp4` is an 85-second
excerpt of *Big Buck Bunny* — © 2008 Blender Foundation,
[CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/), see
[`data/videos/ATTRIBUTION.md`](data/videos/ATTRIBUTION.md). Any other video you ingest is
your responsibility to have the rights to.

Setup troubleshooting and the two-video merge walkthrough from the starter are still in
[`HOWTO.md`](HOWTO.md).
