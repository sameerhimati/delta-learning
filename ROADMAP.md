# Roadmap

Written 2026-07-30, the evening the hackathon build ended.

The build works and the thesis holds: put the viewer in the same graph as the corpus, and
"what should I watch?" becomes a traversal. What follows is what stands between that and
something a stranger could use.

Three sprints, ordered by dependency rather than by calendar. Sprint 1 gates the other two:
until the knowledge state reflects a real person, recommending and decaying it are both
building on sand.

---

## The one thing that matters most

**The vault is evidence of what someone wrote down, not of what they know.**

Everything weak about this system traces back to that. Before any capture, every video in
the demo corpus reads *watch 91–100%* — not a bug, just the truth about a vault with no
game theory in it. The contrast in the demo comes from the capture loop, not from vault
overlap, and the app says so rather than pretending.

`quiz_me` is the right instinct but it is reactive and per-video. The fix is an **onboarding
pass**: adaptive quizzing over the graph's frontier until the knowledge state reflects the
person, not their note-taking habits. Sprints 2 and 3 both assume this exists.

---

## Sprint 1 — make it true for someone who isn't us

*Done when a stranger can point this at their own notes and get a first video that reads
something other than "watch 100%".*

The corpus is four videos and the vault is one person's. Neither generalizes yet.

- **Quiz-driven onboarding (the big one).** At first run, walk the frontier — highest-degree
  unknown concepts first, using the GDS PageRank projection that already exists in
  `cypher/gds_projections.cypher` — and ask ~15 adaptive questions. Write results as
  `(:Concept {status:'known', source:'quiz'})`. Success test: a stranger's first video reads
  something other than *watch 100%*.
- **Bring your own vault.** `make vault` still defaults to the author's folders. Needs a
  real onboarding path: point at a directory, show what got extracted, let the person delete
  what's wrong before it becomes their knowledge state.
- **Merge the duplicate ontology nodes.** 33 Topic/Entity name collisions today
  (`TS Vector` exists as both), which double-counts concepts and splits their edges.
  Resolve at ingest, keyed on normalized name across both labels.
- **Make ingest survive YouTube.** Downloads are bot-blocked without cookies, so the
  paste-a-URL path fails on a fresh machine. Either ship the cookies flow properly
  (`YTDLP_COOKIES`) or accept direct file upload as the first-class path.

## Sprint 2 — from re-ranker to recommender

*Done when "what should I watch?" can return something that was never ingested.*

`/api/watchlist` can only rank the four videos already ingested. That is a demo, not a
product.

- **Delta against an unwatched index.** Run the same traversal over a whole TwelveLabs index
  rather than the local graph. "What should I watch?" stops meaning "of these four."
- **Fold `/api/discover` into the loop.** It already finds real outside videos for goals the
  corpus can't teach. Close the circle: discover → ingest → delta, so a gap becomes a cut
  list without leaving the app.
- **Resolve the two answers to one question.** Curriculum and watchlist both answer "what
  next" and can disagree. Make the watchlist a view of the curriculum, or drop it.
- **Trim the agent's payloads.** `learning_path` returns the entire ~49KB curriculum per
  call (~12k tokens), which a judge feels as latency. Summarize per unit and let the agent
  drill in.

## Sprint 3 — knowledge that decays

*Done when the system can resurface something you learned months ago, and when you can
correct it about what you know.*

Right now `known` is permanent, which is false about people.

- **Spaced repetition over captured concepts.** Every captured concept carries a timestamp
  and a source segment. Decay `status` on a curve and the graph can resurface a 12-second
  range from a talk watched two months ago — a use case no video tool has, and one only a
  graph with timecodes can serve.
- **Make the knowledge state legible.** The concept map exists but is a panel. Someone should
  be able to see what the system believes they know, disagree with it, and correct it. A
  wrong `known` silently hides video from them, which is the worst failure this design has.
- **Ship the IA.** Two destinations, not eleven panels: **PLAN** (curriculum, coverage, gaps,
  discover, add-a-video) and **STUDY** (video, cut list, transcript, quiz, with the knowledge
  state as a persistent rail so it visibly moves when a quiz passes). Chat is a rail, never a
  tab. The causal link between passing a quiz and the number moving *is* the product, and
  today it spans two screens.

---

## Known defects

Carried from the hackathon defect list; the demo-critical ones were fixed on day 0.

**Worth doing early**
- Raw `str(records[:2])` leaks elementIds and internal props into the chat tool-call preview
  (`backend/app/context_graph_client.py:226`).
- The same subtitle repeats on every goal pill (*"advances your goal 'game theory'"*) — say
  it once as a row label.
- Spacing uses half-steps (`pb={4.5}`, 28 vs 20px between header and body). Snap to
  4/8/12/16/24/32. Deliberately skipped under deadline because it can't be verified blind.

**Judgement calls to revisit**
- `classify_terms.py` is non-deterministic at the margin — two runs disagreed on `RabbitMQ`,
  `Redis`, `Chess`. It also rejected `AI Tutor` and `Annotation Mode` from the L8 talk, which
  may be real. `x.learnable` is a node property, so overriding one is a single Cypher write.
- `MIN_NOVELTY_DENSITY = 0.5` and `DISCOUNT_REPEATED_TERMS = False` are both tuned for
  honesty over drama. Both are measured; both are worth revisiting with real users.

---

## What not to build

- **A better summarizer.** Every video tool is already good at "what's in this video." The
  whole wedge is refusing to answer that question.
- **A recommendation feed.** The value is subtraction — telling someone what to skip. A feed
  is the opposite product.
- **More endpoints.** Curriculum, discover, ingest, quiz, and the knowledge map all exist and
  none are fully surfaced in the UI. Another endpoint doesn't help; making the existing ones
  visible does.
