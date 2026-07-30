# Delta Learning frontend handoff for Claude Code

Last updated: 2026-07-30, hackathon day

Owner: Luke (`frontend/` only)

Teammate: Sameer (backend, Neo4j, data, Cypher, Makefile)

## Read this first

1. Read `/Users/luke/Documents/Delta/delta-learning/CLAUDE.md` in full.
2. Read `/Users/luke/Documents/Delta/delta-learning/session-handoff.md`.
3. Stay inside `frontend/`. Never edit `backend/`, `cypher/`, `data/`, or `Makefile`.
4. Pull/fetch Sameer's `origin/main` before every new slice and immediately before
   every commit. Sameer pushes frequently.
5. Keep commits small, working, and frontend-only. Push each one to Luke's fork.

## Git topology and exact current state

Repository:

```text
/Users/luke/Documents/Delta/delta-learning
```

Remotes:

```text
origin  https://github.com/sameerhimati/delta-learning.git
luke    https://github.com/huluk98/delta-learning.git
```

Working branch:

```text
codex/luke-your-cut
```

At the time this handoff was written:

```text
origin/main                         2491dbe
local branch base                   2491dbe
latest backend/frontend integration 2491dbe Say where knowledge came from in words a person can read
```

Sameer has already merged the earlier frontend series and the professional-polish
commit into `origin/main`. Sameer then independently implemented the conceptual map,
knowledge-state component, and transcript component on `main`.

Luke's duplicate map commit `60446b6` was intentionally dropped during rebase because it
conflicted with Sameer's richer implementation in `2491dbe`. Do not resurrect or
cherry-pick `60446b6`.

Before doing anything:

```zsh
cd /Users/luke/Documents/Delta/delta-learning
git fetch origin main
git status -sb
git rebase origin/main
```

If Sameer merged Luke's latest commit while this handoff was being read, Git may say a
commit was already applied or skip it during rebase. That is expected. Never resolve
this by editing backend files.

Push frontend work with:

```zsh
git push luke codex/luke-your-cut
```

Sameer currently syncs Luke's branch with:

```zsh
git fetch luke
git merge luke/codex/luke-your-cut
```

## Running the app

The public backend is:

```text
https://mold-oliver-prisoner-payroll.trycloudflare.com/api
```

The URL is a Cloudflare quick tunnel and can expire. Verify it before debugging the
frontend:

```zsh
curl -fsS https://mold-oliver-prisoner-payroll.trycloudflare.com/api/videos
```

It should return four videos.

Next.js inlines `NEXT_PUBLIC_*` at build/dev-server start time. Restart the server after
changing the URL:

```zsh
cd /Users/luke/Documents/Delta/delta-learning/frontend
NEXT_PUBLIC_API_URL=https://mold-oliver-prisoner-payroll.trycloudflare.com/api npm run dev -- --hostname 127.0.0.1 --port 3000
```

Open:

```text
http://localhost:3000
```

Do not open `http://[::1]:3000`. Sameer's backend CORS allows
`http://localhost:3000`; the IPv6 literal was rejected and caused the UI to fall back
to `frontend/fixtures/delta.json`.

All frontend requests must go through `API_BASE` from `frontend/lib/config.ts`. The env
value already ends in `/api`, so request paths look like:

```ts
fetch(`${API_BASE}/videos`)
fetch(`${API_BASE}/delta/${videoId}`)
```

Never add another `/api`.

### Port 3000 machine note

An unrelated FirstStepBasketball Python server previously occupied
`127.0.0.1:3000`. It was managed by this launch agent:

```text
com.luke.firststepbasketball
/Users/luke/Library/LaunchAgents/com.luke.firststepbasketball.plist
```

It was intentionally unloaded because Luke explicitly asked Delta to replace it:

```zsh
launchctl bootout gui/501/com.luke.firststepbasketball
```

Leave it unloaded while working on Delta. If Luke later explicitly asks to restore the
basketball app:

```zsh
launchctl bootstrap gui/501 /Users/luke/Library/LaunchAgents/com.luke.firststepbasketball.plist
```

Check the current listener before assuming port behavior:

```zsh
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

## What is already implemented

### Study workspace and Your Cut

Files:

```text
frontend/app/page.tsx
frontend/components/VideoBrowser.tsx
frontend/components/YourCutPanel.tsx
frontend/components/StudyNotes.tsx
```

Implemented:

- Four-video live study queue, with fixture fallback.
- L8 selected first.
- Frozen `GET /api/delta/{video}` contract.
- Dramatic watch/skip math.
- Timecoded recommended cuts.
- Orange novel concepts and blue goal-aligned concepts.
- Collapsed known-concepts section with note provenance and optional `goal_note`.
- Empty-cuts state: “Nothing new for you in this video — skip it entirely 🎉”.
- Loading and API-error states.
- “Capture learnings” calls `POST /api/capture` with `{ "video": "<id>" }`.
- Capture refetches the delta, so the cross-video reduction is visible without reload.
- Per-video notes saved in local storage.
- Full transcript remains reachable.
- Ask Delta and the default study flow still work.

The fixture remains intentional and must continue to work:

```text
frontend/fixtures/delta.json
```

Do not remove fallback behavior when integrating the live API.

### Conceptual knowledge map

Files:

```text
frontend/components/ContextGraphView.tsx
frontend/lib/config.ts
```

Implemented on `origin/main` by `2491dbe`:

- The graph defaults to `GET ${API_BASE}/knowledge-map`.
- Neo4j schema is still reachable through a secondary `Schema` button.
- Chat graph results can still replace the current graph as a query view.
- Knowledge-map nodes are converted into the NVL graph format.
- Concept node color is derived from the existing status colors plus local
  knowledge-map colors:
  - known: green
  - goal-aligned: blue
  - novel: orange
- Goal nodes are blue hubs and are larger according to `covered_by`.
- Concept nodes scale modestly by `segment_count`.
- Co-occurrence edges scale visually by `weight`.
- Goal edges are visually distinct.
- `stats.known_pct` is shown in the map legend.
- Schema is no longer the product's default.
- Node inspection remains available.
- Knowledge-node tooltips explain status, source, goals, and videos in plain language.

The live graph was visually verified at `http://localhost:3000`:

```text
98 nodes
225 edges
```

Current live state at handoff time:

```json
{
  "known": 45,
  "goal": 39,
  "novel": 6,
  "terms_total": 90,
  "goals": 8,
  "known_pct": 50
}
```

Do not hardcode these numbers. The backend state changes after capture/quiz actions. An
earlier clean state was 26% known; 50% is correct for the current captured state.

One technical caveat: NVL supports relationship `width`, which is now derived from API
edge weight. Its built-in `d3Force` layout does not expose a public per-link strength or
distance callback. The map clusters because the co-occurrence topology is present, and
edge weight is visible, but a strict “higher weight physically pulls closer” guarantee
would require either:

- a custom D3 renderer/layout, or
- carefully duplicated parallel links (not recommended without visual testing).

Do not replace the current working map just to solve that nuance unless the graph is
visibly failing.

## Design direction from Luke

Luke explicitly rejected the “vibe-coded dashboard” look. The visual references are:

- https://stripe.com
- https://www.apple.com

The lesson is structural, not brand copying:

- one dominant piece of information per surface;
- strict alignment and a readable content width;
- large type contrast instead of decorative containers;
- generous whitespace;
- near-monochrome foundations;
- one restrained purple interaction accent;
- hairline dividers instead of shadows everywhere;
- rounded corners only when the component needs containment;
- avoid gradients, glow, excessive pills, and ornamental badges.

The current UI is improved but still not at this target. In particular:

- the desktop dark sidebar still reads like a generic SaaS dashboard;
- the dark gradient “Your Cut” hero is the strongest remaining vibe-coded element;
- Study uses too many bordered/rounded cards;
- the notes rail feels like a separate widget rather than part of the reading flow;
- the mobile graph header is functional but dense;
- the graph legend still uses several saturated pill badges;
- the graph property card is fixed to the viewport and should be visually contained
  within the knowledge surface;
- Ask Delta is cleaner, but should be checked again after the shell changes.

Recommended visual approach:

1. Convert the desktop shell to a light editorial navigation rail or a compact top bar.
2. Use off-white page background, white content, black/gray type, and purple only for
   selection/action.
3. Redesign Your Cut as an airy white typographic summary:
   - “Watch 9:32” is the dominant line;
   - total duration and skip claim are secondary;
   - a thin study/skip bar carries the comparison;
   - metrics use text and dividers, not three translucent mini-cards;
   - remove the dark gradient entirely.
4. Flatten recommended clips into a clear ordered reading list with subtle separators.
5. Keep concept status colors because they encode meaning, but make badges smaller and
   quieter.
6. Treat the graph as the one expressive/visual surface. Keep surrounding chrome quiet.

Do this in small commits. Do not combine the shell redesign, panel wiring, and quiz into
one large commit.

## Highest-priority unfinished work

### 1. Wire the existing knowledge/provenance panel into the app

Sameer already created:

```text
frontend/components/WhatIKnowPanel.tsx
```

It is substantial and already includes:

- `GET ${API_BASE}/knowledge`;
- loading, error, retry, and refresh states;
- the “N of M vault concepts meet this corpus” headline;
- matched-in-corpus concepts;
- covered/uncovered goals;
- vault/video provenance tabs;
- search;
- readable note names and captured-video sources.

It is **not imported or mounted anywhere yet**. Do not rebuild it from scratch.

Endpoint:

```text
GET ${API_BASE}/knowledge
```

Contract:

```ts
interface KnowledgeResponse {
  goals: Array<{
    name: string;
    covered_by: number;
    covered: boolean;
  }>;
  known: {
    from_vault: Array<{
      name: string;
      note: string | null;
      corpus_hits: number;
    }>;
    from_video: Array<{
      name: string;
      learned_from: string;
      corpus_hits: number;
    }>;
    matched_in_corpus: Array<{
      name: string;
      note: string | null;
      corpus_hits: number;
    }>;
  };
  stats: {
    goals_total: number;
    goals_covered: number;
    known_from_vault: number;
    known_from_video: number;
    vault_relevant_to_corpus: number;
  };
}
```

Current live counts:

```text
8 goals
6 covered goals
109 concepts from vault notes
57 concepts captured from videos
3 vault concepts relevant to this corpus
```

The three matched vault concepts currently are:

```text
02 the agent loop  → 02-the-agent-loop.md, 2 corpus hits
05 memory          → 05-memory.md, 2 corpus hits
agent harnesses    → agent-harnesses.md, 1 corpus hit
```

Integration recommendation:

- Keep the knowledge map as the main visual.
- Mount `WhatIKnowPanel` as a quiet right-hand panel on desktop (about 300–340 px), or a
  compact “What I know” sibling view/toggle on mobile.
- Lead with the honest line:
  “3 of 109 vault concepts overlap this video corpus.”
- Show goals next:
  - checkmark if `covered`;
  - open/empty mark if not covered;
  - `covered_by` as “39 related concepts”, not a technical counter.
- Show `matched_in_corpus` before the full vault list.
- Split provenance clearly:
  - “From your notes”
  - “Learned from videos”
- Use collapsible “All vault concepts (109)” rather than rendering a wall of 109 rows
  by default.
- Show an informative empty state for `from_video` before any capture.
- Never display absolute note paths.
- Pass a refresh token after Capture so the knowledge list updates with the delta.
- If concept click is useful, connect `onConceptClick` to graph selection or Ask Delta.

This is the most important unfinished integration because the component exists but the
viewer still cannot reach it.

### 2. Wire the existing transcript component

Sameer also created:

```text
frontend/components/TranscriptPanel.tsx
```

It already fetches the enriched segments route and supports:

- real transcript text with summary fallback;
- timecode seeking;
- highlighted ranges;
- on-screen text;
- known-concept markers.

It is **not imported or mounted anywhere yet**. `VideoBrowser.tsx` still renders its older
inline “Full transcript” details list. Replace that inline block with
`TranscriptPanel` in a small, isolated commit. Feed it the selected video id, the current
cut ranges as highlights, and the existing `seekTo` callback. Preserve a graceful empty
state because some indexed segments may lack spoken text.

### 3. Finish the Apple/Stripe-inspired visual simplification

Implement the design direction above after the knowledge panel is functional.

Likely files:

```text
frontend/app/page.tsx
frontend/app/globals.css
frontend/theme/index.ts
frontend/components/VideoBrowser.tsx
frontend/components/YourCutPanel.tsx
frontend/components/StudyNotes.tsx
frontend/components/ChatInterface.tsx
frontend/components/ContextGraphView.tsx
```

Preserve all current behaviors. This is a visual and information-hierarchy change, not a
contract rewrite.

### 4. Responsive and interaction QA

Verify at least:

- desktop around 1280 × 720;
- mobile around 390 × 844;
- all four videos;
- live backend and fixture fallback;
- loading/error/empty cuts;
- Capture refetch;
- known-concepts expansion;
- notes persistence;
- Study, Ask Delta, Knowledge map;
- Knowledge/Schema switch;
- node selection and property panel;
- knowledge panel with 0 and many captured concepts.

### 5. Optional quiz UI — only after the above

Endpoint:

```text
GET ${API_BASE}/quiz/{video}?count=5
```

Shape:

```ts
{
  video: unknown;
  questions: Array<{
    concept: string;
    question: string;
    answer_key: string;
    segment_id: string;
    start_sec: number;
  }>;
}
```

The chat agent already supports “quiz me on X” and handles grading/capture. There is no
grading endpoint. A dedicated quiz UI is optional and must not delay the knowledge panel
or visual cleanup.

## API notes that must not regress

`GET /api/delta/{video}` is frozen. No existing field was renamed or removed.

It also has additive fields that can be used later:

- `skipped`
- `minor_concepts`
- `stats.segments_kept`
- `stats.segments_skipped`
- `stats.min_novelty_density`

Do not make additive fields required.

The demo's capture sequence is stateful. Do not casually press Capture during QA if the
clean before/after demo state matters. Read `session-handoff.md` before rehearsing.

The live map and knowledge counts are also stateful and will change after capture or quiz.

## Definition of done for every frontend slice

Run:

```zsh
cd /Users/luke/Documents/Delta/delta-learning/frontend
npm exec -- tsc --noEmit
```

For larger slices, stop the dev server before the build, then run:

```zsh
NEXT_PUBLIC_API_URL=https://mold-oliver-prisoner-payroll.trycloudflare.com/api npm run build
```

Restart the dev server afterward with the env command near the top of this handoff.

Also verify in a browser, not only by reading code.

Before committing:

```zsh
cd /Users/luke/Documents/Delta/delta-learning
git fetch origin main
git rebase origin/main --autostash   # only if the working tree is intentionally dirty
git diff --check
git status -sb
```

Stage explicit frontend paths. Do not use `git add -A` in a mixed worktree.

## macOS/iCloud filesystem hazard

This workspace is under `/Users/luke/Documents`, and macOS repeatedly marks files as
`compressed,dataless` while the repository is open. Symptoms:

- `npm exec -- tsc --noEmit` sits at 0% CPU for minutes;
- Next compilation takes multiple minutes;
- `git status` or `git diff` appears hung;
- Git reports a packfile is “far too short”.

Inspect flags with:

```zsh
ls -lO frontend/tsconfig.json
ls -lhO .git/objects/pack
ls -lO frontend/node_modules/@types/node
```

Repairs used successfully:

```zsh
cd /Users/luke/Documents/Delta/delta-learning/frontend
npm ci
```

For an offloaded Git pack, reading the exact file hydrates it:

```zsh
dd if=/Users/luke/Documents/Delta/delta-learning/.git/objects/pack/<exact-pack>.pack of=/dev/null bs=1048576
dd if=/Users/luke/Documents/Delta/delta-learning/.git/objects/pack/<exact-pack>.rev of=/dev/null bs=1048576
```

Resolve the exact filename with `ls -lhO`; never use a broad destructive command.

TypeScript may modify the tracked generated cache:

```text
frontend/tsconfig.tsbuildinfo
```

Do not commit that incidental change. Restore only that generated file before staging:

```zsh
git restore -- frontend/tsconfig.tsbuildinfo
```

## Suggested next three commits

1. `feat(frontend): wire knowledge and transcript panels`
2. `style(frontend): simplify study workspace shell`
3. `style(frontend): make Your Cut editorial and restrained`

Run type checking and push after each one. Sameer is actively merging Luke's branch, so
fetch/rebase before every commit.

## Product story to preserve

Delta is not a generic video summarizer. It compares a video corpus with a changing
personal knowledge state.

The UI must make these truths obvious:

- what the viewer already knows;
- where that knowledge came from;
- what aligns with stated learning goals;
- what is genuinely new;
- exactly which video ranges are worth watching;
- after Capture, the next recommendation changes because the viewer changed, not because
  the corpus changed.

If a design choice makes those relationships harder to see, it is not polish.
