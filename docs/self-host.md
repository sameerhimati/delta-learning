# Run it on your own videos and your own notes

This is the full pipeline, and it costs money: TwelveLabs indexes and analyses every
video, OpenAI structures the output and adjudicates every concept match. The
[keyless demo](../README.md#see-it) needs none of it.

This is the full pipeline, and it costs money: TwelveLabs indexes and analyzes every
video, OpenAI structures the output and adjudicates every concept match.

**Also needs:** OpenAI API key · TwelveLabs API key · your own notes.

```bash
cp .env.example .env      # NEO4J_*, OPENAI_API_KEY, TWELVE_LABS_API_KEY, VAULT_DIRS
make docker-up            # local Neo4j 5.26 — docker-compose ships APOC + GDS 2.13.2
make install              # uv sync + npm install

# build the graph
make seed VIDEOS="data/videos/talk-a.mp4 data/videos/talk-b.mp4"   # video side
make vault                                                          # viewer side
make resolve                                                        # link the two
#   make demo-seed  runs all three in order (seed → vault → resolve)

# optional: mark transcript noise as not-learnable (one OpenAI pass, idempotent)
cd backend && uv run python scripts/classify_terms.py --dry-run   # inspect first
cd backend && uv run python scripts/classify_terms.py

make start                # backend :8000 + frontend :3000
```

Open **http://localhost:3000** and ask *"I don't have 20 minutes — what in this talk is
actually new to me?"*

Notes:

- **The knowledge state is the part that's yours.** `make vault` reads folders of
  claim-per-file markdown — **filenames only, never note bodies** — from `VAULT_DIRS` in
  `.env` or `--vault-dir=`. There is no default, deliberately: the only default possible
  would be someone else's folders. Edit `data/learning_goals.yaml` for things you want to
  learn but don't know yet.
- Expect a thin first result. A fresh vault overlaps a talk far less than you'd guess —
  see *Honest limitations*. The capture loop is what produces contrast.
- `make seed` with **no** `VIDEOS=` ingests every `.mp4` you've put in `data/videos/`, and
  if that's empty it downloads `SAMPLE_VIDEO_URLS` from `.env` — a short, license-clean
  Big Buck Bunny clip, so the pipeline has something to chew on. Pass explicit paths for a
  real corpus.
- Already indexed in TwelveLabs? Skip the upload:
  `make seed VIDEOS="--index-id=<TL_INDEX_ID> --video-id=<TL_VIDEO_ID>"`.
- Ingestion is idempotent — re-seeding replaces a video's segments, never duplicates them.
- `make export-demo` snapshots your graph the way the shipped one was made.
- `make test` — backend pytest + frontend `tsc --noEmit` + e2e discovery.

### Undo a capture

Capture is one-way by design, so re-running the before/after comparison needs a reset.
This drops captured concepts without touching the vault or goal ones (different key
namespace):

```cypher
MATCH (c:Concept) WHERE c.key STARTS WITH 'video:' DETACH DELETE c
```

> `make reset` exists and **wipes the entire Neo4j database** — videos, segments, vault,
> goals, everything. It is not this. Use the Cypher above.

---
