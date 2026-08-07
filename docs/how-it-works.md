# How it works

The full pipeline, from a video file to a timecoded cut list. Split out of the README so
the front page stays short; this is the part worth reading if you want to reuse the
design rather than just run it.

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
(:Concept {status: 'known', source: 'vault', note_path})   # what they've written down
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

### 7. Onboarding — the way in for someone with no vault

The quiz above is reactive: you have to already be looking at a video, and it only tests
what that video teaches. Someone arriving with no notes at all still faces four videos that
all read "watch 91–100%", which is the least persuasive possible first impression.

`GET /api/onboarding/questions` (and the `onboarding_quiz` tool) walks the **whole corpus**
instead, asking about the terms that unlock the most other unknown material first — GDS
PageRank over the co-occurrence graph of terms nobody has claimed yet, the same projection
`learning_frontier` uses. Fifteen questions asked in that order move a knowledge state
much further than fifty asked alphabetically.

The adaptivity is a property of the projection rather than a scoring rule: the frontier
excludes anything already `SAME_AS` a known Concept, so each batch is recomputed against
what the last one proved. Ask in rounds of five and the questions narrow on their own.

Measured on the shipped snapshot with the vault concepts removed — a genuine cold start:

```
before   L8 94.1%   Postgres 90.8%   Game Theory 90.7%    0 of 136 terms known
  5 questions, 3 answered properly and 2 waved at
after    L8 94.1%   Postgres 90.8%   Game Theory 82.5%    5 of 136 terms known
```

The two vague answers were refused, which is the point — `PostgreSQL`,
`Prisoner's Dilemma` and `Shapley Value` were captured as `(:Concept {source:'quiz'})`,
and the two hand-waves stayed unknown and are still recommended. Note that Postgres does
not move even though `PostgreSQL` is now known: one term out of many in a segment does not
clear the novelty-density bar, and pretending otherwise would be the dishonest version.

---

## Where each sponsor is load-bearing

| Sponsor | Used for | Why it's structural, not decorative |
|---|---|---|
| **TwelveLabs — Pegasus** | `analyze` → timecoded description of each video | The only source of *what happens when*. Cut lists are timecodes; without Pegasus there is nothing to cut. |
| **TwelveLabs — Marengo** | indexing + embedding **both sides**: video terms *and* vault concepts, one 512-d space | This is the load-bearing one. Video terms and a person's notes are only comparable because the same model embedded both. It ranks candidates for resolution and powers segment vector search. |
| **OpenAI — `gpt-5.6`** | Strands agent brain (`OpenAIResponsesModel`) | Runs the tools, grades the quiz, and narrates *why* a range is skippable. |
| **OpenAI — structured outputs (`gpt-5.6-terra`)** | Pegasus prose → typed segments; resolution adjudication; quiz generation | Every schema-validated boundary in the pipeline. The `SAME_AS` / `ADVANCES` acceptance gate *is* an OpenAI structured-output verdict. |
| **AWS Strands** | agent + tool orchestration, SSE streaming, 15 tools | Tool results stream to the frontend and auto-render into the graph panel. |
| **Neo4j** | the graph; 2 vector indexes (`segment_embeddings`, `concept_embeddings`); **GDS 2.13.2** | Viewer and corpus in one graph is the entire premise. GDS PageRank runs over a Cypher-projected co-occurrence graph of terms the viewer does *not* know — that's "what should I learn first". See [`cypher/gds_projections.cypher`](../cypher/gds_projections.cypher). |

The graph this was measured on holds **4 videos · 83 segments · 63 topics · 109 entities**
and a knowledge state of 109 notes. `data/demo_graph.json` ships that graph with the
knowledge state trimmed to its **54** publishable notes — the author's study and writing
folders — plus the 5 goals in `learning_goals.yaml`. Nothing removed was linked to a video,
so every number on this page reproduces from `make demo`; the exact counts print as it
loads.

---
