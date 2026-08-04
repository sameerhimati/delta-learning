# Agent brief

Orientation for coding agents (and humans who like a map before a codebase).

## What this project is

Video tools answer *"what's in this video?"* This one answers *"what's in this video
that the viewer doesn't already know?"* — which is not a property of the video, so no
retrieval system can compute it. The viewer's knowledge state and the video segments
live as nodes in **the same Neo4j graph**, and the answer is a set difference you
traverse, returned as a timecoded cut list.

Read the README for the argument. Read `ROADMAP.md` before proposing large changes —
it lists what's already known to be broken and, more usefully, **what not to build**.

## Where things are

```
backend/app/delta.py          the core. cut lists, capture, quiz, ranking.
backend/app/agent.py          13 Strands tools; the 8 delta ones are this project's
backend/app/routes.py         FastAPI surface
backend/app/curriculum.py     ordered path through the corpus (GDS PageRank)
backend/scripts/ingest.py     video -> TwelveLabs -> OpenAI -> Neo4j
backend/scripts/ingest_vault.py     notes + goals -> (:Concept)
backend/scripts/resolve_concepts.py Marengo candidates -> OpenAI adjudication -> edges
frontend/components/YourCutPanel.tsx   the cut list UI
frontend/components/ContextGraphView.tsx  NVL graph, concepts colored by status
```

## The graph shape — memorize this one thing

```
(:Video)-[:HAS_SEGMENT]->(:Segment)-[:ABOUT|MENTIONS]->(:Topic|:Entity)
(:Topic|:Entity)-[:SAME_AS]->(:Concept {status: 'known'})   // skip it
(:Topic|:Entity)-[:ADVANCES]->(:Concept {status: 'goal'})   // watch it
```

Per learnable term: `known` > `goal` > `novel`. **Evidence beats aspiration** — a term
the viewer demonstrably knows is skippable even when it also serves a stated goal.
Without that precedence, capture could never shrink a cut list, since Topics are
shared across videos and the goal branch would always win.

A segment enters the cut list on **novelty density**, not novelty:
`MIN_NOVELTY_DENSITY = 0.5` in `delta.py`. The constants there carry long comments
explaining what was measured and why the value is what it is — read them before
changing a number, and if you do change one, re-measure rather than re-reason.

## Conventions

- The delta read path is **pure Cypher** and must stay that way. It runs with no API
  keys, which is what makes `make demo` possible. If you add an OpenAI or TwelveLabs
  call to `delta.py`, put it behind a function the delta traversal doesn't call.
- Ingestion is idempotent. Re-seeding replaces a video's segments, never duplicates.
- Topics and Entities are keyed on normalized name so a term taught in two videos is
  one node with two teachers. That MERGE is what makes cross-video transfer work — do
  not add a per-video namespace to it.
- Captured concepts are namespaced `video:…` so capturing a term named "Game Theory"
  cannot MERGE onto, and silently destroy, the *learning goal* of the same name.
- Honesty over drama in anything user-facing. When the system can't teach something,
  it says so. Several tuning knobs are deliberately set to the less impressive value
  for this reason; `delta.py` says which and why.

## Before you change licensing-sensitive files

Read `NOTICE`. Some files in this tree come from an upstream that publishes no
license, and are marked there. Don't move code between those files and the MIT ones
without checking which direction you're moving it.

## Checks

```bash
make test    # backend pytest + frontend tsc --noEmit + e2e discovery
make lint
```
