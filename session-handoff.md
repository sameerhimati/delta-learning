# Session handoff — 2026-07-30 ~12:35pm (hackathon day)

## State: backend delta layer DONE and pushed. Pipeline blocked only on OpenAI key + ingest.

Done & verified:
- Neo4j up (docker, `neo4j/password`), schema applied incl. Concept constraint.
- Vault ingested: 38 Concept nodes (33 known from claim-filenames, 5 goals). TwelveLabs key verified live (Marengo embeds working). Re-run `make vault` after editing `data/learning_goals.yaml` (goals were just broadened — game theory, Bayesian stats, database internals, context engineering, speculative decoding).
- Delta layer: `app/delta.py`, agent tools (`knowledge_delta`, `capture_learning`, `what_should_i_watch`), routes (`/api/delta/{video}`, `/api/capture`, `/api/watchlist`). Tests pass (2/2).
- Demo talks downloading via yt-dlp (background) into `data/videos/`:
  1. "Postgres is the Only Database You Need in 2026" (8:07) — vault-sparse → novelty demo
  2. "L8 Principal's Agentic Engineering Workflow" (45:46) — vault-dense → skip demo. INGEST THIS ONE FIRST (indexing time scales with length).
- Repo public at sameerhimati/delta-learning; Luke's brief is in CLAUDE.md (frontend + garnish only).

## Next steps, in order
1. OpenAI key into `.env` (placeholder `OPENAI_API_KEY=your-openai-key-here` still there).
2. `make seed VIDEOS="data/videos/<agentic-talk>.mp4 data/videos/<postgres-talk>.mp4"` — EXPLICIT paths (bare `make seed` would also ingest the vendored Big Buck Bunny sample and pollute the graph).
3. `make resolve` — links video topics to vault concepts (SAME_AS edges). Verify: SAME_AS count > 0, and the agentic talk shows several `known` concepts (else lower THRESHOLD in `scripts/resolve_concepts.py`).
4. STILL NEEDED: a third talk overlapping the agentic one (agents/LLM engineering, 10–20 min) — it powers the finale beat: capture learnings from talk A → talk B's cut list shrinks. yt-dlp it, seed it.
5. Golden-path test in terminal before any frontend work — the four demo questions against `/api/chat`:
   - "What in the agentic engineering talk is new to me?"
   - "Which of my learning goals does this corpus cover?" (expect: honest "nothing on game theory")
   - "Capture what those segments taught me"
   - Re-ask #1 on the third talk → cut list MUST shrink. This is the demo's load-bearing claim.
6. Schedule: hard stop building 3:00 → rehearse → record 3:15–3:45 → submit 4:00.

## Watch-outs
- 45:46 talk: Pegasus analyze is capped at 60 min but takes minutes — kick seed off and let it run.
- `make reset` wipes the DB including vault concepts — never casually.
- Keys live only in `.env` (gitignored). The TwelveLabs key was pasted in chat earlier — consider rotating it after the hackathon.
