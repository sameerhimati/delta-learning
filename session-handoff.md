# Session handoff — 2026-07-30 ~2:05pm (hackathon day)

## State: corpus complete, delta layer works end to end, demo beat measured. Pushed.

Do **not** run `make reset`. Do **not** touch `frontend/` (Luke's).

Pushed to `main`: `81f8e9d` (delta layer correctness) and `931c5e6` (novelty-density
cuts, goal precision, Neo4j GDS). Backend tests 2/2 green.

## Runtime

- Neo4j in docker, `neo4j/password`, GDS **2.13.2 installed** (real PageRank, not a shim).
- FastAPI on `:8000` (`make dev-backend`), auto-reload on.
- Cloudflare quick tunnel live: `https://mold-oliver-prisoner-payroll.trycloudflare.com`
  (verified 200). `cloudflared` pid was 62259 — if it dies, restart and reshare, the URL
  changes every time.
- Luke's env: `NEXT_PUBLIC_API_URL=https://mold-oliver-prisoner-payroll.trycloudflare.com/api`

## Corpus (all 4 ingested, already indexed in TwelveLabs)

| video | runtime | segments | TL video_id |
|---|---|---|---|
| L8 Agentic Engineering | 45:46 | 34 | `6a6baa1c0d774e7cec6c1a66` |
| Postgres | 8:07 | 11 | `6a6bae84eb0afeafecfac472` |
| Game Theory A ("How Decision Making") | 9:50 | 13 | `6a6bae85c1ac59f5d1d0a8a8` |
| Game Theory B ("A Simple Strategy") | 17:47 | 25 | `6a6bae86c1ac59f5d1d0a8b0` |

TL index `6a6ba9df0d774e7cec6c16a8`. **Re-analysis is cheap** — they're already indexed,
so `make seed VIDEOS="--index-id=<idx> --video-id=<vid>"` skips upload and only re-runs
Pegasus → structure → embed → write (~2 min for all four in parallel).

Graph: 419 learnable terms, 117 Concepts (109 known from vault, 8 goals),
~54 `SAME_AS` + ~168 `ADVANCES` edges.

## THE DEMO BEAT — measured, not claimed

Run from a clean state (no `video:`-prefixed Concepts):

```
Game Theory B before:  watch 17:46  ·  1 cut   ·  known 2
POST /api/capture {"video": "How Decision Making"}   → captures 24 concepts
Game Theory B after:   watch 13:22  ·  5 cuts  ·  known 12
```

**25% less to watch, and one undifferentiated blob becomes 5 timecoded cuts.**
That is "the corpus didn't change, I changed", live.

To reset to the clean pre-capture state between rehearsals:
```cypher
MATCH (c:Concept) WHERE c.key STARTS WITH 'video:' DETACH DELETE c
```
That only removes capture artifacts. Vault and goal Concepts are a different key
namespace and are untouched — this is safe to run repeatedly.

## Demo script (6 questions, `/api/chat`, same session_id)

1. "What in the L8 agentic engineering talk is new to me?" → watch nearly all of it,
   83 novel terms. **This is honest, not a bug** — the vault has almost nothing on
   agentic engineering, and the agent explains that it only skips with positive evidence.
2. "What about the Postgres talk?" → also watch it all, 0 known. Same reasoning, said out loud.
3. "Which of my learning goals does this corpus cover, and which does it not?" →
   covers game theory, database internals, context engineering. Reports **zero** coverage
   for speculative decoding, KV-cache optimization, GPU memory hierarchy, Bayesian stats.
   The honesty beat.
4. "What should I learn first?" → `learning_frontier` tool: Neo4j GDS PageRank over the
   co-occurrence graph of terms you do NOT know.
5. "I just watched the game theory explainer — capture what it taught me." → 24 concepts.
6. "Now what should I watch in 'A Simple Strategy'?" → **17:46 → 13:22, 5 cuts.** The finale.

## Honest framing decision (Sameer signed off on the shape, not the numbers)

The vault genuinely contains no game theory and no Postgres knowledge, and little on
agentic engineering. Vault scanning was widened from one subfolder to four (33 → 109
concepts) and that is the ceiling. So **the demo's contrast comes from capture, not from
vault overlap.** Do not promise "watch 4 minutes of an 18-minute talk" off the vault
alone — promise it off the capture loop, which is measured above.

## What changed this session (why, not what)

- `goal` outranked `known`, so capture could never shrink a cut list; and
  `capture_learning` skipped goal-status concepts entirely, making the capture button a
  no-op on exactly the videos a goal covers. Both fixed — this was the finale silently
  failing.
- Captured Concepts MERGE'd on bare names, sharing a key namespace with goals: capturing
  a term called "Game Theory" would have flipped the stated goal to `known` and deleted
  it mid-demo. Now namespaced `video:`.
- Resolver's absolute cosine floor rejected true matches before the LLM saw them (median
  best-match cosine 0.43). Marengo now ranks, the adjudicator decides, chunks write edges
  as they land so an interrupted run keeps its work.
- Pegasus was capped at 2000 tokens and truncated long videos mid-way; now duration-aware
  within its hard 4096 ceiling.
- Cuts required only one novel term in a segment → every video read "watch 100%".
- Goal adjudication answered on shared discipline → claimed 4 goals the corpus misses.

## Remaining / known risks

- Quick-tunnel URL is ephemeral. Verify before the recording.
- L8 and Postgres both read "watch ~100%". Correct, but if two flat answers in a row feel
  weak on camera, lead with Q5→Q6 (the capture beat) and use Q1/Q2 as setup.
- `data/videos/bbb_1080p_30fps_normal_85sec.mp4` (vendored sample) is **not** ingested.
  Never run bare `make seed` — it would ingest it and pollute the graph.
- Hard stop building 3:00pm → rehearse 3:00–3:15 → record 3:15–3:45 → submit 4:00.
