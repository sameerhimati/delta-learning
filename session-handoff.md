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

Graph: 4 Videos, 83 Segments, 63 Topics + 109 Entities, 117 Concepts (109 known from
vault, 8 goals), ~58 `SAME_AS` + ~196 `ADVANCES` edges.

The ontology was deliberately thinned late in the session: the structuring prompt used to
emit every entity it saw (~105 terms per video, including filler like "Artificial
Intelligence" and "Performance Optimization"), which buried the signal and made badges
unreadable. It now emits at most 3 genuinely-teachable topics per segment and none at all
for intros and sponsor reads. Terms per video fell 103→71, 45→27, 30→22, and the capture
beat nearly doubled (25% → 41%) because the concepts that remain are ones that actually
overlap between the two talks.

## THE DEMO BEAT — measured, not claimed

The graph is currently sitting in the clean pre-capture state. Do not capture before
the recording or the beat is already spent.

```
Game Theory B before:  watch 16:08 of 17:46  ·  2 cuts  ·  known 0
POST /api/capture {"video": "How Decision Making"}   → captures 11 concepts
Game Theory B after:   watch  9:32 of 17:46  ·  3 cuts  ·  known 6
```

**41% less to watch — 6:36 saved — from watching one 9-minute video.**
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
5. **"I just watched 'How Decision Making is Actually Science' — capture what it taught me."**
   → captures 11 concepts (Game Theory, Prisoner's Dilemma, Nash Equilibrium, Dominant
   Strategy, Shapley Value…).
   ⚠️ **Name the video explicitly.** Saying "the game theory explainer" makes the agent
   pick the *other* game-theory video, and Q6 then asks about the one you just captured —
   it answers "skip all of it", which is circular and kills the beat. Verified failure.
6. "Now what should I watch in 'A Simple Strategy'?" → **9:32 of 17:47 across 3 cuts**, and
   the agent names the source: *"skip 0:00–5:08 … you learned that from How Decision
   Making."* Cross-video transfer, said out loud. The finale.

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

## Luke / frontend integration — MERGED

Luke works in a **fork**: `https://github.com/huluk98/delta-learning`, branch
`codex/luke-your-cut`. Nothing lands on `origin/main` until it is merged from there:

```
git remote add luke https://github.com/huluk98/delta-learning.git
git fetch luke && git merge luke/codex/luke-your-cut
```

Merged at 3:05pm: 5 commits, +1287/-321 across 10 files, **frontend-only, zero backend
files touched**, `tsc --noEmit` clean. Adds `YourCutPanel.tsx` (523 lines), `StudyNotes.tsx`,
concept coloring by knowledge status in `ContextGraphView`, and a rebuilt `page.tsx` /
`VideoBrowser`. Frontend runs on `:3000` and returns 200.

The API is verified working through the tunnel, including CORS for `http://localhost:3000`:

```
curl https://mold-oliver-prisoner-payroll.trycloudflare.com/api/videos      # 4 videos
curl "https://mold-oliver-prisoner-payroll.trycloudflare.com/api/delta/A%20Simple%20Strategy"
```

If his panel shows no data, in likelihood order: (1) dev server not restarted — Next
inlines `NEXT_PUBLIC_*` at build time so it must be `NEXT_PUBLIC_API_URL=<tunnel>/api npm
run dev`; (2) still reading `frontend/fixtures/delta.json`; (3) double `/api/api/` because
the env var already ends in `/api`.

`GET /api/delta` gained **additive** fields he can use but does not have to:
`skipped` (segments deliberately not recommended, with their concepts, so a skip can be
explained rather than silently vanishing), `minor_concepts`, and
`stats.segments_kept` / `segments_skipped` / `min_novelty_density`. Every original field
is unchanged in name, type, and meaning — a fixture-built panel still works untouched.

## Remaining / known risks

- Quick-tunnel URL is ephemeral. Verify before the recording.
- **Before capture every video reads 91–100% watch.** That is the honest starting state,
  not a bug — the vault covers almost none of this material. The contrast is produced by
  the capture loop, so the demo must show a capture. Lead Q1/Q2 as setup and land on Q5→Q6.
- Ideas raised but deliberately not built (they belong in the README as roadmap): a **quiz**
  to populate the knowledge state directly — the vault is evidence of what Sameer wrote
  down, not what he knows, and this is the real fix for "watch the whole video";
  recommending videos from **outside** the corpus (today `/api/watchlist` ranks only the 4
  ingested ones).
- `data/videos/bbb_1080p_30fps_normal_85sec.mp4` (vendored sample) is **not** ingested.
  Never run bare `make seed` — it would ingest it and pollute the graph.
- Hard stop building 3:00pm → rehearse 3:00–3:15 → record 3:15–3:45 → submit 4:00.
