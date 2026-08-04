# Contributing

Contributions are welcome. This was built in a weekend for a hackathon, so there is a lot
of obvious work left — most of it already written down.

## Start here

- **[`ROADMAP.md`](ROADMAP.md)** — what's known to be broken, what would make this a
  product rather than a demo, and a **what not to build** section. Read that last part
  before proposing a feature; the wedge is narrow on purpose, and "a better summarizer" or
  "a recommendation feed" are explicitly not it.
- **[`AGENTS.md`](AGENTS.md)** — orientation: the graph shape, why `known` beats `goal`,
  and which invariants not to break. Worth reading whether or not you code with an agent.

The single highest-value contribution is the first item in Sprint 1: **quiz-driven
onboarding**, so a stranger's knowledge state reflects them rather than one person's notes.
Everything else in the roadmap assumes it exists.

## Getting a working copy

```bash
make install
make demo        # real graph, real cut list, no API keys — Docker only
```

Working on ingestion or resolution means real OpenAI and TwelveLabs keys and real spend;
see the README. Most changes don't need that — the delta traversal, the API, and the whole
frontend run against the shipped snapshot.

## Before you open a PR

```bash
make test        # backend pytest + frontend tsc --noEmit + e2e discovery
make lint
```

- Keep the delta read path pure Cypher. It running without API keys is what makes
  `make demo` possible, and it's easy to break by accident.
- The tuning constants in `backend/app/delta.py` carry long comments explaining what was
  measured and why the value is what it is. If you change a number, re-measure — don't
  re-reason.
- If a change alters the demo graph, re-export it with `make export-demo` and say so in the
  PR. Note that the exporter deliberately strips private vault folders and reduces note
  paths to bare filenames; don't route around that.
- Prefer honesty over drama in anything user-facing. When the system can't teach something,
  it should say so.

## One thing to know about licensing

Contributions land under **MIT**, matching [`LICENSE`](LICENSE).

Four files in this tree come from an upstream that publishes no license, and are listed in
section 3 of [`NOTICE`](NOTICE). Please don't move code between those files and the
MIT-licensed ones without checking which direction it's going — untangling that later is
much harder than getting it right in the PR. Rewriting any of them from scratch, so the
project stops depending on unlicensed code, is a genuinely useful contribution.
