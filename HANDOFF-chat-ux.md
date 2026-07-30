# Handoff — chat threads + UX audit (parallel session)

> Written 2026-07-30 by the session that owned `components/ChatInterface.tsx`.
> Read this before touching the chat panel. Everything else below the fold is a
> findings list for whoever is doing the visual pass on the other panels.

## Ground rule that caused trouble today

Two agents worked the same checkout on `main` with no branches, so writes were
last-writer-wins. My ChatInterface + StudyNotes edits got swept into commit
`e09d15c` (someone else's) because they staged the whole tree. Nothing was lost,
but **stage explicit paths, never `git add -A`**, while a second session is live.

## What I own / what I changed

**`components/ChatInterface.tsx` only** (commit `dcf4c37`, plus earlier work
swept into `e09d15c`). I deliberately did not touch `app/page.tsx`,
`ContextGraphView.tsx`, `WhatIKnowPanel.tsx`, `TranscriptPanel.tsx`,
`VideoBrowser.tsx`, `YourCutPanel.tsx`, `globals.css` or `theme/index.ts` —
those were dirty in the other session all afternoon.

### Parallel chats (done)

- `Thread { id, title, sessionId, messages, createdAt, unread }`. One
  sessionStorage key, `ccg-chat-v2-${DOMAIN.id}`, holding `{v:2, activeId, threads}`.
  The v1 keys are read once to migrate an open tab, then never again.
- Tab strip at the top of the chat panel with a `+` pinned outside the scroller.
  `+` **always** creates a tab — a first press that does nothing reads as broken.
- **Threads are ref-first.** `threadsRef`/`activeIdRef` are the source of truth;
  `setThreads`/`setActiveId` only paint. A thread created this tick has to be
  visible to `sendMessage` before React re-renders. Mutate only through
  `commitThreads` / `patchThread`. **Do not** switch these to `setState(prev => …)`.
- `sendMessage(text?, targetThreadId?)` — every write goes to `targetId`, so an
  answer lands in the thread that asked for it no matter what is on screen.
- **Switching threads never aborts.** One request streams at a time
  (`abortControllerRef`, `loading` both stay singular). Closing the streaming
  thread is the only path that cancels.
- Session id is read from the *target thread* at call time. Reading it from the
  rendered thread would send thread A's agent memory key with thread B's message.

### New-chat-on-note-click (done, and why it needed no other file)

`WhatIKnowPanel.onConceptClick` → `page.handleAskAbout` → `setAskAboutInput`
→ `ChatInterface.externalInput`. Both the graph and What I know funnel through
that one prop, so making *an arriving `externalInput` open its own thread* gets
the behaviour for both surfaces **with zero edits to page.tsx**. The tab is
titled from the concept (`Tell me about KV-cache eviction` → `KV-cache eviction`).

`loading` stays in that effect's deps on purpose: a click mid-answer opens its
tab immediately and sends when the stream finishes. `pendingExternalRef` keeps
the thread identity stable across the two effect runs, and requires the pending
thread to still exist — otherwise closing that tab would silently swallow the
question.

### Visual work in the chat panel (done)

- Killed the wall of identical bordered cards: user turn is a right-aligned
  pill, assistant turn is plain prose at 15px/1.7 with `tabular-nums` so the
  timecodes stop wobbling. Avatars gone — that also fixed the tool timeline's
  28px misalignment for free.
- **Markdown bullets were invisible app-wide.** Chakra's preflight sets
  `list-style: none` in `@layer reset`; `.markdown-content ul/ol` in globals.css
  only sets padding. Fixed with `MD_COMPONENTS` (unlayered emotion props beat
  layered CSS, no `!important`). Passed to all three `<ReactMarkdown>` sites.
- Raw identifiers removed: tool names (`knowledge_delta` → "Compared this talk
  with what you know"), `JSON.stringify(tc.inputs)` (leaked video UUIDs),
  `{e.type}/{e.subtype}: {e.name}` entity chips, `{p.category}: {p.preference}`.
- `"Running tool 3 of 2…"` — the old counter produced that once every call
  finished. Now names the actual step.
- Finished tool calls collapse to "N steps". Prompt cards get `disabled={loading}`
  and Enter no-ops while another thread streams (they looked live and did nothing).
- Green removed from the tool timeline indicator — green is `known` in this product.

### Verified

`npm exec -- tsc --noEmit --incremental false` clean; no console/page errors;
`+` → 3 tabs → reload → 3 tabs; mid-stream switch does not abort and the answer
lands in the origin tab with an unread dot.

> `npm run lint` is `eslint` with **no eslint config in the repo** — it fails
> before my changes and is not a usable gate. Use tsc.

---

## Findings I could not fix (other session's files)

Ordered by how loudly they contradict the product. All observed in the running
app, not read off the source.

1. **`YourCutPanel` says "You already know the rest." when you know nothing.**
   Live: `/api/delta/A Simple Strategy` returns `known: 0`, `skip_sec: 99`,
   `segments_skipped: 0`. The 99s is the *gap between cuts*, not knowledge. The
   string is shown whenever `skip_sec > 1`, so the panel claims prior knowledge
   the graph explicitly does not have. This is the single worst copy bug left.

2. **The novel concepts — the whole product — are hidden.** Cuts render
   `concepts.slice(0, 6)`, and the API returns 17 `goal` concepts before the 3
   `novel` ones. So "Grass Camp", "Joss", "Reproducibility" sit behind
   *"Show 14 more concepts"* while six identical blue goal pills take the fold.
   Sort `novel` first, or show novel and goal in separate rows.

3. **The same sentence 17 times.** Every goal pill's `why` is
   `advances your goal 'game theory'`. Identical subtitle on every chip is noise
   — say it once as a row label.

4. **Green is used decoratively where green means "known".** The skip badge is
   green (`colorPalette={skipPercent === 0 ? "orange" : "green"}`), and the
   progress track is `bg="green.400"` with purple filled over it — so the skipped
   portion literally renders in the "you know this" colour while known is 0.

5. **Transcript entity chips are solid orange** (`NODE_COLORS.Entity`) with white
   text. Orange means `novel`, so "Microsoft", "Windows", "Kun Chen" read as
   new-to-you concepts. Also fails contrast at that size.

6. **"Show N more concepts" never flips to "Show less"** — after expanding, the
   label still promises to show what is already on screen.

7. **Ragged gutters.** `VideoBrowser` header is `px={{base:4, lg:7}}` (28px) but
   the body below it is `px={{base:4, lg:5}}` (20px), so the video title and the
   cut panel start on different verticals. Same file uses `pb={4.5}`, `pb={3.5}`.
   Half-steps (`0.5/1.5/2.5/3.5/4.5`) are everywhere and are the biggest single
   contributor to "vibecoded". Pick 4/8/12/16/24/32 and snap everything.

8. **Video titles carry a fullwidth colon** — `Game Theory：` (U+FF1A, from the
   yt-dlp filename) renders as a wide gap. `displayTitle()` in VideoBrowser
   already normalises underscores; add `：` → `:`.

9. `/api/quiz` and `POST /api/quiz/grade` exist and are wired to nothing in the
   frontend.

## Where to look

- Screenshots (before/after, all surfaces):
  `/private/tmp/claude-501/-Users-sameer-Code-delta-learning/9a90adce-.../scratchpad/`
  (`before/`, `after/`, `threads/`) — ephemeral, copy out if you want them.
- The full design spec + three adversarial critiques that produced the thread
  model: `~/.claude/projects/-Users-sameer-Code-delta-learning/9a90adce-.../subagents/workflows/wf_ef903d8d-8ba/journal.jsonl`
