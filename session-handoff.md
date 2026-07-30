# Session Handoff
> Last updated: 2026-07-30, end of the long build session.
> **Next session is the last sprint. Start in plan mode.**

## Opening gambit

```zsh
cd ~/Code/delta-learning && git pull
make docker-up && make start          # backend :8000, frontend :3000
docker exec delta-learning-neo4j-1 cypher-shell -u neo4j -p password \
  "MATCH (c:Concept) WHERE c.key STARTS WITH 'video:' DETACH DELETE c"
curl -s "localhost:8000/api/delta/A%20Simple%20Strategy" | python3 -m json.tool | head -20
```
Must read **`watch_sec: 968, 2 cuts, known: 0`**. If it doesn't, something captured and
the demo beat is spent — re-run the delete above. Then read this file's *Defects* section
and enter plan mode. Do not start coding before agreeing the sprint scope.

## Current state

- `main` @ `51370c1`, clean, pushed. Backend pytest **4/4**. Frontend `tsc` clean.
- Neo4j in docker (GDS 2.13.2). Cloudflare tunnel was
  `https://mold-oliver-prisoner-payroll.trycloudflare.com` — **ephemeral, re-check**.
- Corpus: 4 videos — L8 agentic 45:46 (34 seg), Postgres 8:07 (11), Game Theory A
  "How Decision Making" 9:50 (13), Game Theory B "A Simple Strategy" 17:47 (25).
  TL index `6a6ba9df0d774e7cec6c16a8`. 117 Concepts (109 vault-known, 8 goals).

## THE DEMO BEAT — re-verified this session, not stale

```
Game Theory B before:  968s (16:08) · 2 cuts · known 0
POST /api/capture {"video": "How Decision Making"}  → 11 concepts, 1.4s
Game Theory B after:   616s (10:16) · 3 cuts · known 3
```
Cut count rising while watch time falls is correct — a skipped middle splits one range.

**Climax is the quiz, not the number.** "Capture learnings" opens `QuizFlow`; only
concepts you can answer for are recorded, and what you fail keeps its timecodes. Verified:
one good answer + one bluff + one blank → 1 captured, 2 in `still_recommended`. The grader
refuses fluent-but-wrong answers ("This describes a Pull Request, not Windows").

## What exists

**Backend** — delta traversal + cut lists; capture; quiz (`/api/quiz/{video}`) and
quiz-graded capture (`POST /api/quiz/grade`); knowledge state (`/api/knowledge`);
concept map (`/api/knowledge-map`); curriculum (`/api/curriculum`, `/api/coverage`);
outside-corpus discovery (`/api/discover`); URL ingest (`POST /api/ingest`,
`GET /api/ingest/{job_id}`); transcripts on `/api/videos/{id}/segments`.
Agent has **13 Strands tools**.

**Frontend** — knowledge map (concept graph, not the DB schema), What I Know panel,
transcript panel, Your Cut panel, quiz flow wired to the capture button, and parallel
chat threads with a `+` (threads survive reload; a note/graph click opens its own thread).

**Sponsor stack** — TwelveLabs Pegasus (analyze) + Marengo (embeds *both* sides of the
match); OpenAI gpt-5.6 (agent) + structured outputs (segmentation, adjudication, quiz,
grading); Strands (orchestration); Neo4j (graph, 2 vector indexes, GDS Louvain + PageRank).

## DEFECTS — the next sprint's fix list, ranked by what a judge would see

Sources: three adversarial verifiers + the parallel chat/UX session
(see `HANDOFF-chat-ux.md`). **No blockers; everything below is real and reproducible.**

### Tier 1 — these contradict the product's own claim

1. **`YourCutPanel` says "You already know the rest." when `known: 0`.** Shown whenever
   `skip_sec > 1`, but that 99s is the *gap between cuts*, not knowledge. The panel
   asserts prior knowledge the graph explicitly denies. Worst copy bug in the app.
2. **The novel concepts are below the fold.** Cuts render `concepts.slice(0, 6)` and the
   API returns 17 `goal` concepts before the 3 `novel` ones — so the three things actually
   new to you hide behind *"Show 14 more"* while six identical blue pills take the fold.
   That is the entire product claim, buried. Sort novel first or split the rows.
3. **Discover invents gaps.** `_FREE_TOPIC` (discover.py:67) matches the *whole query
   string* against term names, so any multi-word question reports `coverage: 0`.
   Reproduced: `/api/discover/how do I use Postgres for vector search` → "no term in your
   library mentions…" + 3 outside recommendations — while the corpus has PG Vector,
   TS Vector, Vector Similarity Search, and the agent cited 5:08–5:52 of the Postgres talk
   introducing pgvector *in the same conversation*. Fix: tokenize and match any content
   token; soften the copy so a heuristic miss can't read as a definitive claim.
4. **Asking about "game theory" recommends MatPat.** #1 result is *"Game Theory: Oops,
   Lethal Company Accidently Ended The World"* (The Game Theorists, a gaming channel).
   `_score` gives +2.0 for an exact title substring, which that channel's naming exploits.
   Cached, so it reproduces deterministically. Cap the substring bonus or require overlap
   on a non-stopword.

### Tier 2 — dishonest numbers and overclaiming

5. **Curriculum `watch_sec` (4947s) exceeds `corpus_sec` (4889s)** — asks for more time
   than the corpus contains, because units share segments. `watch_sec_unique` (4327) is
   already computed and correct; show that.
6. **`order_confidence: "high"` on depth gaps of 0.002–0.004**, with the sentence "this is
   the speaker's own build-up order (10/10 on the prerequisite test)". Noise sold as
   pedagogy. Require a real margin before claiming high confidence.
7. **`find_video` is a literal substring match.** `'L8 agentic engineering'` → **404**;
   only `'L8'` works. Every underscore-titled video is unreachable by natural phrasing.
8. **Curriculum module docstring cites stale coverage numbers** (39/28/17 vs live 25/22/15).

### Tier 3 — visual and copy

9. Green used decoratively where **green means "known"** — the skip badge and progress
   track render green while `known: 0`. Transcript entity chips are solid orange
   (`novel`'s colour), so "Microsoft" reads as a new concept.
10. The same subtitle 17 times: every goal pill says `advances your goal 'game theory'`.
    Say it once as a row label.
11. Half-step spacing everywhere (`pb={4.5}`, `px` 28 vs 20 between header and body) —
    the single biggest contributor to "vibecoded". Snap to 4/8/12/16/24/32.
12. Titles carry a fullwidth colon `：` (U+FF1A, from yt-dlp filenames) rendering as a wide
    gap. `displayTitle()` already normalises underscores; add this.
13. "Show N more concepts" never flips to "Show less".
14. Raw `elementId` and internal props leak into the chat tool-call preview
    (`context_graph_client.py:226` sets `output_preview = str(records[:2])`).
15. `learning_path` tool returns the whole 49KB curriculum (~12k tokens) per call.
16. Ontology noise still surfaces: "Windows", "Bing", "Lavish Axie", "Grass Camp" appear as
    learnable concepts and even as a curriculum unit title.

## Verified good — don't re-litigate

- **All 31 curriculum lesson timecodes** checked against Segment nodes. Zero fabricated.
- Curriculum depth ordering independently recomputed from Neo4j; matches API to 3dp.
  Game theory order is defensible: Prisoner's Dilemma → Optimal Strategy → Shapley →
  Repeated Game → Tit-for-Tat.
- Every `/api/discover` URL resolved 200 via YouTube oembed. No model ever emits an
  identifier — fields are transcribed from yt-dlp and the URL is *constructed* from the id.
- PageRank was **rejected** as a curriculum ordering signal after testing: on 11 pairs where
  one term contains another, first-teaching-time scores 10/10 within a video, PageRank 7/11
  and puts Shapley Value above Game Theory.

## Known environment risks

- **YouTube bot-blocks this machine** for `yt-dlp` *downloads* (search still works, so
  `/api/discover` is fine). A live "paste a YouTube URL" demo will likely fail with "Sign in
  to confirm you're not a bot". Export `cookies.txt` and start the backend with
  `YTDLP_COOKIES=/path/to/cookies.txt`, or demo that beat with a non-YouTube URL.
- `TL_INDEX_ID` is not in `.env`; every ingest resolves the index by name (one extra call).
- **Never** run bare `make seed` (would ingest the vendored Big Buck Bunny sample) or
  `make reset`.

## Process lessons — these cost us today

- **Never `git add -A` while another session is live.** It swept the parallel session's
  ChatInterface edits into `e09d15c` and a scratch script into `10a6c83`. Stage explicit
  paths. `.gitignore` now covers `frontend/_*.mjs` and `frontend/app/_*/`.
- Two sessions on one checkout of `main` is last-writer-wins. Use branches, or hard-split
  file ownership and say so up front.
- Backend modules were written **self-contained** and wired serially by one owner. That
  worked — four agents adding routes to `routes.py` concurrently would have corrupted it.
- `npm run lint` is broken repo-wide (no eslint config). Use `tsc --noEmit` as the gate.

## Proposed IA for the last sprint (decide in plan mode)

Two destinations, not eleven panels:
- **PLAN** — curriculum units in order, coverage, uncoverable gaps, and right there
  discover + paste-a-URL, because that is where a gap gets closed.
- **STUDY** — video + cut list + transcript + quiz, with the knowledge state as a
  *persistent rail* so it visibly moves when a quiz passes. It must not be a separate tab:
  the causal link is the product.
- **Chat** — a rail, never a tab.

Open tension: "what to watch next" is answered twice (curriculum vs `/api/watchlist`).
Make the watchlist a view of the curriculum, or drop it.

## Reference

- `HANDOFF-chat-ux.md` — the parallel session's chat-thread work and its full findings list.
- `cypher/gds_projections.cypher` — Louvain + PageRank projections, verified runnable.
- Demo script and per-question expected behaviour: see git history for the previous
  handoff revision (commit `f03bcec`).
