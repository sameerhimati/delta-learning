# Delta Learning

**"The corpus didn't change. I changed."**

Built for *Hack the Video Agent Context Graph* (TwelveLabs · OpenAI · Neo4j · AWS), on top of
the [`video-context-graph`](https://github.com/jpadams/video-context-graph) starter.

> **See it first, read second.** `make install && make demo` loads a real graph and gives
> you a real timecoded cut list. Docker is the only prerequisite — no API keys.
> [Details below.](#try-it-without-keys)

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

Measured on the author's graph — four talks, one person's Obsidian vault — on 2026-07-30.
That exact graph ships as `data/demo_graph.json`, so every number below is reproducible
with `make demo` and no API keys. Your own corpus will read differently; see
*Honest limitations* for why a fresh vault starts out overlapping very little.

Two game-theory talks, ingested independently, no shared metadata — just shared concepts
that MERGE'd into the same graph nodes.

```
Game Theory B ("A Simple Strategy…", 17:46)   BEFORE   watch 16:08 · 2 cuts · 0 known concepts

  → watch Game Theory A ("How Decision Making…", 9:50)
    POST /api/capture {"video": "How Decision Making"}      captures 11 concepts

Game Theory B                                  AFTER   watch  9:32 ·          3 known concepts
```

**41% less to watch. 6:36 saved on one talk, from having watched a different one.**

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
| "Which of my goals does this corpus cover?" | 1 of the stated goals strictly linked (game theory); volunteers that Postgres/L8 *support* others without a strict link, and names the ones with **no** coverage rather than staying quiet about them |
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

Pegasus describes what it *sees*, so the extracted ontology also contains things nobody
studies — a game-show clip's props, every person and company named in passing, a promo code.
`backend/scripts/classify_terms.py` runs one OpenAI structured-outputs pass over the term
names (each judged alongside the segment it came from) and marks `x.learnable`. Neither the
node label nor `x.type` separates noise from signal — `concept` holds both *Grass Camp* and
*TS Vector*, `product` holds both *FRIENDS10* and *Tmux* — so the judgement has to be
semantic. Queries read `coalesce(x.learnable, true)`, so an unclassified graph behaves
exactly as before and the pass is optional.

### 2. Knowledge state — the viewer → the same graph

`backend/scripts/ingest_vault.py` walks an Obsidian vault and takes **filenames only, never
note bodies** — the vault is written claim-per-file, so the filename *is* the claim. Plus
`data/learning_goals.yaml` for things the viewer wants to learn but doesn't know yet.

```
(:Concept {status: 'known', source: 'vault', note_path})   # 109 — what they've written down
(:Concept {status: 'goal',  source: 'goals'})              #  from learning_goals.yaml
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
| **AWS Strands** | agent + tool orchestration, SSE streaming, 13 tools | Tool results stream to the frontend and auto-render into the graph panel. |
| **Neo4j** | the graph; 2 vector indexes (`segment_embeddings`, `concept_embeddings`); **GDS 2.13.2** | Viewer and corpus in one graph is the entire premise. GDS PageRank runs over a Cypher-projected co-occurrence graph of terms the viewer does *not* know — that's "what should I learn first". See [`cypher/gds_projections.cypher`](cypher/gds_projections.cypher). |

The graph this was measured on — **4 videos · 83 segments · 63 topics · 109 entities ·
109 vault concepts** plus the goals in `learning_goals.yaml` — is what ships in
`data/demo_graph.json`. `make demo` loads it; the exact counts are printed as it does.

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

## Try it without keys

Building a graph needs OpenAI and TwelveLabs. *Reading* one doesn't — the delta
traversal is pure Cypher. So the repo ships a snapshot of a real graph, and you can get
a real cut list without an account anywhere.

**Prerequisites:** Docker · [uv](https://docs.astral.sh/uv/) (Python 3.10–3.13) · Node 18+.

```bash
make install     # uv sync + npm install
make demo        # Neo4j + load the shipped graph + start the app
```

Open **http://localhost:3000**, pick a talk, open **Your Cut**. You get timecoded
ranges, orange badges for concepts new to you and blue for ones matching a stated goal,
and a skip figure — *watch 9:32 of 17:46* — with each skipped concept traced to the note
that already covers it.

Then run the loop this project exists for. Capture a different talk and watch this one
shrink:

```bash
curl -X POST localhost:8000/api/capture -H 'content-type: application/json' \
  -d '{"video": "How Decision Making"}'
```

Reload Your Cut on *A Simple Strategy*. Same corpus, same graph, less to watch — the
concepts moved.

The snapshot is the author's own graph: four talks, and a knowledge state built from one
person's Obsidian vault. It carries segment summaries, topics, entities and resolved
concept edges, but no embeddings, no transcripts, and no captured concepts. Chat needs
an `OPENAI_API_KEY`; everything above works without one.

To put it back the way it started:

```cypher
MATCH (c:Concept) WHERE c.key STARTS WITH 'video:' DETACH DELETE c
```

---

## Run it on your own videos and your own notes

This is the full pipeline, and it costs money: TwelveLabs indexes and analyzes every
video, OpenAI structures the output and adjudicates every concept match.

**Also needs:** OpenAI API key · TwelveLabs API key · your own notes.

```bash
cp .env.example .env      # NEO4J_*, OPENAI_API_KEY, TWELVE_LABS_API_KEY, VAULT_DIRS
make docker-up            # local Neo4j 5.26 — docker-compose ships APOC + GDS 2.13.2
make install              # uv sync + npm install

# build the graph
make seed VIDEOS="data/videos/talk-a.mp4 data/videos/talk-b.mp4"   # video side
make vault                                                          # viewer side
make resolve                                                        # link the two
#   make demo-seed  runs all three in order (seed → vault → resolve)

# optional: mark transcript noise as not-learnable (one OpenAI pass, idempotent)
cd backend && uv run python scripts/classify_terms.py --dry-run   # inspect first
cd backend && uv run python scripts/classify_terms.py

make start                # backend :8000 + frontend :3000
```

Open **http://localhost:3000** and ask *"I don't have 20 minutes — what in this talk is
actually new to me?"*

Notes:

- **The knowledge state is the part that's yours.** `make vault` reads folders of
  claim-per-file markdown — **filenames only, never note bodies** — from `VAULT_DIRS` in
  `.env` or `--vault-dir=`. There is no default, deliberately: the only default possible
  would be someone else's folders. Edit `data/learning_goals.yaml` for things you want to
  learn but don't know yet.
- Expect a thin first result. A fresh vault overlaps a talk far less than you'd guess —
  see *Honest limitations*. The capture loop is what produces contrast.
- `make seed` with **no** `VIDEOS=` ingests every `.mp4` you've put in `data/videos/`, and
  if that's empty it downloads `SAMPLE_VIDEO_URLS` from `.env` — a short, license-clean
  Big Buck Bunny clip, so the pipeline has something to chew on. Pass explicit paths for a
  real corpus.
- Already indexed in TwelveLabs? Skip the upload:
  `make seed VIDEOS="--index-id=<TL_INDEX_ID> --video-id=<TL_VIDEO_ID>"`.
- Ingestion is idempotent — re-seeding replaces a video's segments, never duplicates them.
- `make export-demo` snapshots your graph the way the shipped one was made.
- `make test` — backend pytest + frontend `tsc --noEmit` + e2e discovery.

### Undo a capture

Capture is one-way by design, so re-running the before/after comparison needs a reset.
This drops captured concepts without touching the vault or goal ones (different key
namespace):

```cypher
MATCH (c:Concept) WHERE c.key STARTS WITH 'video:' DETACH DELETE c
```

> `make reset` exists and **wipes the entire Neo4j database** — videos, segments, vault,
> goals, everything. It is not this. Use the Cypher above.

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
| `POST /api/quiz/grade` | Grades free-text answers and captures **only** what the viewer proved. |
| `GET /api/knowledge` · `/api/knowledge-map` | The viewer's knowledge state; concept graph coloured by status. |
| `GET /api/curriculum` · `/api/coverage` | Ordered units through the corpus; which goals it can and cannot teach. |
| `GET /api/discover/{goal}` | Real outside-corpus videos for a goal the library cannot teach. |
| `POST /api/ingest` · `GET /api/ingest/{job_id}` | Ingest a video by URL; poll the job. |
| `GET /api/schema` · `POST /api/expand` · `POST /api/cypher` | Graph schema, drill-down, read-only Cypher. |
| `GET /health` | Backend + Neo4j status. |

**Agent tools** (Strands, 13): `knowledge_delta` · `capture_learning` · `quiz_me` ·
`what_should_i_watch` · `learning_path` · `learning_frontier` (GDS PageRank) ·
`find_outside_material` · `add_video` · `search_video_moments` · `explore_graph` ·
`twelvelabs_search` · `run_cypher` · `get_graph_schema`.

The first eight are new here; the last five come from the starter.

---

## Roadmap

The three ideas that would make this a product rather than a demo — quiz-driven onboarding,
recommending from outside the corpus, and spaced repetition over captured concepts — plus a
three-sprint plan and the known defect list, are in **[`ROADMAP.md`](ROADMAP.md)**.

---

## License and attribution

The original work here — the knowledge state, resolution pass, delta traversal, capture
loop, quiz, and the "Your Cut" panel — is **MIT** licensed. See [`LICENSE`](LICENSE).

The rest of the tree has two other origins, and one of them is unresolved. The short
version, with the full file-level breakdown in [`NOTICE`](NOTICE):

- **Most of the inherited scaffold is Apache-2.0.** This project is a fork of
  [`video-context-graph`](https://github.com/jpadams/video-context-graph), which was
  itself generated by
  [create-context-graph](https://github.com/neo4j-labs/create-context-graph) — the FastAPI
  app, the Strands agent skeleton, the Neo4j client, the NVL graph view, the Docker
  setup, the Makefile. That generator is Apache-2.0 licensed by Neo4j Labs, so those
  files are permissively licensed and safe to redistribute with attribution.
- **Five files are not.** The fork parent publishes **no license at all**, which under
  default copyright means no rights are granted to anyone. Its genuinely original
  contribution — the video ingestion pipeline (`backend/scripts/ingest.py`), the
  TwelveLabs wrapper (`backend/app/twelvelabs_client.py`), the video ontology
  (`data/ontology.yaml`), `HOWTO.md`, and the component `VideoBrowser.tsx` was derived
  from — is not covered by the MIT grant above, and two of those files are still
  byte-identical to theirs.

Practically: forking a public GitHub repo is permitted by GitHub's Terms of Service;
sublicensing it is not. So this repo as a whole cannot be relicensed, and if you plan to
redistribute or build commercially on it, read [`NOTICE`](NOTICE) first. Upstream has
been [asked to add a license](https://github.com/jpadams/video-context-graph/issues/2),
which would make this simpler for everyone. The delta layer itself depends on that code
only through video ingestion, which is replaceable.

The sample clip `make seed` falls back to is *Big Buck Bunny* — © 2008 Blender
Foundation, [CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/), see
[`data/videos/ATTRIBUTION.md`](data/videos/ATTRIBUTION.md). It is downloaded, not
vendored, so it isn't in this repo. Any video you ingest is your responsibility to have
the rights to.

Setup troubleshooting and the two-video merge walkthrough from the starter are still in
[`HOWTO.md`](HOWTO.md).
