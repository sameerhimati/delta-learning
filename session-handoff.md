# Session handoff — 2026-07-30 ~12:57pm (hackathon day)

## Handoff state

Sprint 1 is partially complete. The shared runtime is up, the L8 talk is fully
ingested, and resolution has been calibrated once. Do **not** run `make reset`.

- `.env` now contains a valid OpenAI key; never print, commit, or copy it.
- Neo4j was already running. FastAPI was started with `make dev-backend` on `:8000`.
- Cloudflare quick tunnel was started and was externally reachable at:
  `https://mold-oliver-prisoner-payroll.trycloudflare.com`
  (Quick-tunnel URLs are ephemeral; verify before sharing/reusing.)
- Verified both `http://127.0.0.1:8000/api/videos` and the public
  `/api/videos` route returned HTTP 200 before corpus completion.
- Never edit `frontend/`; Luke owns it.

## Completed and verified

1. **L8 first, explicit absolute path** — successfully ingested:
   - File: `/Users/sameer/Code/delta-learning/data/videos/L8_Principal_s_Agentic_Engineering_Workflow.mp4`
   - TwelveLabs index: `video-context-graph` / `6a6ba9df0d774e7cec6c16a8`
   - Video id: `6a6baa1c0d774e7cec6c1a66`
   - Result: 11 analyzed segments written to Neo4j; `segment_embeddings` vector
     index ready at 512 dimensions.
2. Ran `make resolve` at the original `0.70` threshold. It created one
   `SAME_AS` edge: `Agent Harness` → `agent harnesses` (0.91).
3. Measured the L8 delta through the live API:
   - `concepts_total: 60`, `known: 1`, `novel: 59`, `goal_hits: 0`
   - It currently recommends the whole 45:46 because the known term does not
     eliminate a complete segment.
4. Inspected semantic scores and changed the *candidate pre-filter* in
   `backend/scripts/resolve_concepts.py` from `0.70` to `0.55`. OpenAI remains
   the semantic acceptance gate; this is not a blind similarity match.
   - Re-running `make resolve` produced 27 candidates.
   - The adjudicator confirmed one additional `SAME_AS` edge:
     `Agent Harness` → `agent anatomy loop harness and the stack` (0.73).
   - There are now `SAME_AS > 0` (two edges), but only **one distinct L8 term**
     is known. The required “several known concepts” gate is **not yet met**.
5. Chat behavior now explicitly explains the policy: skip only concepts with
   positive evidence of existing knowledge; recommend a full video when none
   exists; distinguish a learning goal from prior knowledge. Backend tests pass
   (2/2).

## Git state

- Pushed to `main`: `ebac33c Clarify full-video recommendations`
- `backend/scripts/resolve_concepts.py` has the threshold change above and is
  intentionally **uncommitted** at handoff. Inspect/verify it, then either
  commit it as its own checkpoint or refine/revert it deliberately.
- Video files are ignored by Git. No frontend files were modified.

## Downloaded, not yet seeded

All files below are present and must be passed by explicit **absolute** path.
The Makefile changes into `backend/`, so `data/videos/...` fails from `make seed`.

- `/Users/sameer/Code/delta-learning/data/videos/Postgres_is_the_Only_Database_You_Need_in_2026.mp4` (8:07)
- `/Users/sameer/Code/delta-learning/data/videos/How Decision Making is Actually Science： Game Theory Explained.mp4` (9:50)
- `/Users/sameer/Code/delta-learning/data/videos/Game Theory： A Simple Strategy That Will Change Your Life Forever.mp4` (17:47)

Because the game-video filenames contain spaces, quote each path *inside* the
`VIDEOS` make variable. Safest: seed one at a time, beginning with Postgres:

```zsh
make seed VIDEOS='"/Users/sameer/Code/delta-learning/data/videos/Postgres_is_the_Only_Database_You_Need_in_2026.mp4"'
make seed VIDEOS='"/Users/sameer/Code/delta-learning/data/videos/How Decision Making is Actually Science： Game Theory Explained.mp4"'
make seed VIDEOS='"/Users/sameer/Code/delta-learning/data/videos/Game Theory： A Simple Strategy That Will Change Your Life Forever.mp4"'
```

Then run `make resolve` again and measure `GET /api/delta/<title-fragment>` for
all four videos. The vault contains **game theory as a learning goal**, not as
known knowledge: the game talks should be recommended in full because nothing
is safe to skip, while also explaining that they serve a stated goal.

## Required next gates

1. Make the L8 delta show several *distinct* known concepts without fabricating
   matches. Lower the candidate pre-filter only if the LLM adjudicator can
   truthfully approve more pairs; otherwise improve matching context/terms and
   rerun. Use the API, not inference, to verify.
2. Seed Postgres and both game talks using the exact commands above; resolve
   again; verify `SAME_AS > 0` and the expected L8/Postgres/game cut-list story.
3. Golden-path test through `/api/chat`:
   - What in the agentic engineering talk is new to me?
   - Which learning goals does this corpus cover? (be honest about gaps)
   - Capture what those segments taught me.
   - Re-ask on an **overlapping agentic talk** and prove its cut list shrinks.

   Important product constraint: the new game-theory videos do **not** overlap
   L8, so capturing L8 cannot legitimately shrink their cut lists. Keep one
   10–20 minute overlapping agentic talk for the capture-shrink finale, or
   explicitly revise that demo claim before recording.
4. Before rehearsal: pull Luke’s frontend commits, smoke-test the hosted API
   integration, then commit and push each completed sprint. Hard stop building
   3:00pm; rehearse 3:00–3:15; record at 3:15; submit by 4:00.

## Luke integration prompt already supplied

Luke’s frontend consumes:

`NEXT_PUBLIC_API_URL=https://mold-oliver-prisoner-payroll.trycloudflare.com/api`

He should use the fixture first, implement the frozen `/api/delta` panel and
capture action, make small frontend-only commits, and never alter backend files.
