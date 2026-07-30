# Session Handoff
> Last updated: 2026-07-30 ~2:55pm PDT — hackathon build day, hard stop 3:00pm,
> record 3:15–3:45, submit 4:00.

## Completed This Session

- [x] `81f8e9d` Delta layer correctness — `known` now beats `goal` (capture could never
      shrink a cut list before), `capture_learning` no longer skips goal-status concepts,
      captured Concepts namespaced `video:` so they can't overwrite a learning goal,
      resolver switched from an absolute cosine floor to top-K + LLM adjudication,
      Pegasus given a duration-aware token budget, vault scanning widened 33 → 109 concepts.
- [x] `21369a4` Lean ontology — structuring prompt capped at 3 genuinely-teachable topics
      per segment. Terms/video 103→71, 45→27, 30→22. **Capture beat 25% → 41%.**
- [x] `931c5e6` Novelty-density cuts + goal precision + Neo4j GDS wired (`learning_frontier`).
- [x] `6efda81` Stopped serializing 512-float embeddings into agent context (one graph
      question was asking for 386k tokens and returning a rate-limit error).
- [x] `d61d07c` Merged Luke's frontend (5 commits, +1287/−321, frontend-only, tsc clean).
- [x] `6a60291` Recorded the demo-script trap that made the finale circular.
- [x] `0ecfdab` Quiz loop, `/api/knowledge-map`, `/api/knowledge`, Topic/Entity dedupe.

## Current State

- **Branch:** `main`, clean, pushed to `origin/main` at `0ecfdab`.
- **Build:** backend pytest 2/2 green; frontend `tsc --noEmit` clean.
- **Services:** Neo4j (docker, GDS 2.13.2), FastAPI `:8000`, Next `:3000`,
  cloudflared tunnel `https://mold-oliver-prisoner-payroll.trycloudflare.com`.
- **Uncommitted:** none.
- **Blockers:** none. One loose end below.

### ⚠️ Loose end: graph is NOT in clean demo state

A verification subagent ran a capture and left artifacts (`known_from_video: 4`).
**Before rehearsing or recording, run:**
```cypher
MATCH (c:Concept) WHERE c.key STARTS WITH 'video:' DETACH DELETE c
```
Verify with `curl localhost:8000/api/knowledge` → `stats.known_from_video` must be **0**.
This only removes capture artifacts; vault and goal Concepts use a different key namespace.

## Next Session Should

1. **Opening gambit:** run the clean-state Cypher above, then
   `curl -s "localhost:8000/api/delta/A%20Simple%20Strategy"` and confirm
   **watch_sec 968, cuts 2, known 0**. That is the verified pre-capture baseline; if it
   doesn't match, something captured and the finale is already spent.
2. Rehearse the 6-question demo script below. **Q5 must name the video explicitly.**
3. Pull Luke's ongoing UI work: `git fetch luke && git merge luke/codex/luke-your-cut`,
   then `cd frontend && npm exec -- tsc --noEmit --incremental false`.
4. If flat answers read badly on camera, consider the `DISCOUNT_REPEATED_TERMS` lever
   (see Context). Re-measure before recording if you flip it.
5. Post-hackathon: **curriculum generation** — the strongest unbuilt feature.

## The demo — measured, not claimed

```
Game Theory B before:  watch 16:08 of 17:47 · 2 cuts · known 0
POST /api/capture {"video": "How Decision Making"}  → 11 concepts
Game Theory B after:   watch  9:32 of 17:47 · 3 cuts · known 6
```
**41% less to watch, from watching one 9-minute video.**

Six questions, `/api/chat`, same `session_id`, 9–40s each:

1. "What in the L8 agentic engineering talk is new to me?" → 43:03 of 45:46, cites real
   vault notes (`agent-harnesses.md`, `05-memory.md`).
2. "What about the Postgres talk?" → watch all 8:06, 0 known, says why.
3. "Which of my learning goals does this corpus cover, and which does it not?" → honest;
   volunteers that GPU memory hierarchy / KV-cache / speculative decoding are uncovered.
4. "What should I learn first?" → GDS PageRank over the frontier. Picks PostgreSQL (5.15).
5. **"I just watched 'How Decision Making is Actually Science' — capture what it taught me."**
   ⚠️ **Name the video.** Saying "the game theory explainer" makes the agent pick the *other*
   game-theory video, so Q6 then asks about the video it just captured and answers
   "skip all of it" — circular, kills the beat. Verified failure mode.
6. "Now what should I watch in 'A Simple Strategy'?" → 9:32 across 3 cuts, and it names
   *where* the skipped material was learned. The finale.

## Context to Remember

- **The vault holds 109 concepts and exactly 3 touch this corpus** (`02-the-agent-loop.md`,
  `05-memory.md`, `agent-harnesses.md`). This is why every video answers "watch most of it"
  before any capture. It is honest, not a bug — say it out loud rather than hedging. It is
  also *why the quiz exists*: the vault is evidence of what Sameer wrote down, not of what
  he knows.
- **`DISCOUNT_REPEATED_TERMS`** in `backend/app/delta.py`, default `False`. When True a term
  stops counting as new once an earlier segment of the same video taught it. Measured:
  Postgres 91%, L8 73%, GT-B 34%, GT-A 0% — four visibly different verdicts vs the default's
  two-at-100%. Off because it can drop a segment that is 100% novel-to-the-viewer as a
  "repeat", contradicting "mostly new is always kept". One-word flip, but re-measure.
- **Three bugs that would have silently broken the demo**, all found by adversarial review
  rather than by tests: `goal` outranking `known` (capture could never shrink anything);
  captured Concepts sharing a key namespace with goals (capturing "Game Theory" would have
  deleted the stated goal mid-demo); embeddings serialized into agent context (386k-token
  requests → rate-limit errors that read as a broken product).
- **Re-analysis is cheap.** All 4 videos are already indexed in TwelveLabs, so
  `make seed VIDEOS="--index-id=6a6ba9df0d774e7cec6c16a8 --video-id=<vid>"` skips upload
  and re-runs analyze→structure→embed→write. All four in parallel ≈ 2 min.
  Pegasus caps `max_tokens` at **4096** — exceeding it 400s.
- **Never run bare `make seed`** — it would ingest the vendored Big Buck Bunny sample and
  pollute the graph. Never run `make reset`.
- **Luke works in a fork**, `https://github.com/huluk98/delta-learning`, branch
  `codex/luke-your-cut`. Nothing appears on `origin/main` until merged from there. His agent
  is still working on UI/UX. If he ever touches `backend/`, stop and review rather than merge.
- **The graph panel still defaults to `/api/schema/visualization`** (Neo4j index metadata —
  a data-model diagram, not knowledge). `/api/knowledge-map` exists to replace it; Luke has
  been given the prompt but had not landed it as of this handoff.
- `GET /api/delta` gained additive fields only: `skipped`, `minor_concepts`,
  `stats.segments_kept` / `segments_skipped` / `min_novelty_density`, `cuts[].novelty`,
  `known_concepts[].goal_note`. No existing field renamed, retyped, or removed.
- Quick-tunnel URLs are ephemeral — verify before sharing or recording.

## Corpus

| video | runtime | segments | TL video_id |
|---|---|---|---|
| L8 Agentic Engineering | 45:46 | 34 | `6a6baa1c0d774e7cec6c1a66` |
| Postgres | 8:07 | 11 | `6a6bae84eb0afeafecfac472` |
| Game Theory A ("How Decision Making") | 9:50 | 13 | `6a6bae85c1ac59f5d1d0a8a8` |
| Game Theory B ("A Simple Strategy") | 17:47 | 25 | `6a6bae86c1ac59f5d1d0a8b0` |

TL index `6a6ba9df0d774e7cec6c16a8`. Graph: 4 Videos, 83 Segments, 63 Topics,
109 Entities, 117 Concepts (109 vault-known, 8 goals).

## Start Command

```zsh
cd ~/Code/delta-learning
make docker-up          # Neo4j, if not already up
make start              # backend :8000 + frontend :3000
# then, before demoing:
docker exec delta-learning-neo4j-1 cypher-shell -u neo4j -p password \
  "MATCH (c:Concept) WHERE c.key STARTS WITH 'video:' DETACH DELETE c"
open http://localhost:3000
```
