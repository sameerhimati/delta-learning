"""Mark which extracted terms are actually learnable, and which are transcript noise.

Pegasus describes what it sees, so the ontology contains things that are real in the
footage but are not concepts anyone learns: "Grass Camp" and "Joss" from a game-show
clip, "Bing" and "Windows" mentioned in passing, "FRIENDS10" — a promo code. They then
surface as novel concepts, which is the worst possible place for them: novel is the
panel's headline claim, so the noise lands on the fold.

Neither label nor type separates them. `x.type` is the natural knob and it does not
work — noise and signal share every type:

    concept: Grass Camp, Joss, Axie   ...but also TS Vector
    product: Bing, Windows, FRIENDS10 ...but also RabbitMQ, Tmux, Neovim, OpenCode

Dropping a type would take the L8 talk's entire toolchain with it. So the judgement is
semantic, and it goes where the other semantic judgement in this pipeline already lives:
one OpenAI structured-outputs pass, same shape as resolve_concepts.py.

Each term is judged WITH the segment summary it came from, because the context is what
makes it decidable — "Joss" is a name in a clip, "Stemming" is a thing you learn.

Writes `x.learnable` (boolean) on Topic/Entity nodes. Queries read it via
`coalesce(x.learnable, true)`, so an unclassified graph behaves exactly as before and
this script is safe to skip, re-run, or run after adding videos.

Run after ingest.py:  uv run python scripts/classify_terms.py [--dry-run]
Idempotent.
"""

from __future__ import annotations

import asyncio
import logging
import sys

from pydantic import BaseModel

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("classify")

sys.path.insert(0, ".")

from app.config import settings  # noqa: E402
from app.context_graph_client import connect_neo4j, close_neo4j, execute_cypher  # noqa: E402

TERMS_PER_CHUNK = 40  # keeps one call's output well inside a reliable length
CLASSIFY_CONCURRENCY = 4  # in-flight OpenAI reasoning calls


class TermVerdict(BaseModel):
    term: str
    learnable: bool


class TermVerdicts(BaseModel):
    terms: list[TermVerdict]


CLASSIFY_SYSTEM = (
    "You are cleaning an ontology extracted automatically from video transcripts. For "
    "each term, decide whether it names something a person could LEARN — a concept, "
    "technique, technology, method, or tool someone could study and be quizzed on.\n\n"
    "learnable=true: 'Nash Equilibrium', 'KV-cache eviction', 'Stemming', 'TS Vector', "
    "'RabbitMQ', 'Tmux', 'Neovim', 'GIN Index', 'Pull Request'. Specific tools and "
    "technologies COUNT — someone can learn to use them.\n\n"
    "learnable=false: proper nouns that are merely referenced (people, companies, "
    "channels, brands: 'John Nash', 'Microsoft', 'SciShow', 'Patreon'), things that "
    "belong to a video's incidental content rather than its subject ('Grass Camp', "
    "'Joss', 'Golden Balls', 'Axie'), promo codes and UI chrome ('FRIENDS10', "
    "'Terminal'), and operating systems or products named only in passing ('Windows', "
    "'Bing') where the video teaches nothing about them.\n\n"
    "The test is not 'is this a real thing' — all of them are. The test is 'would a "
    "person put this on a study list?'. Use the segment context: the same word can be "
    "a topic in one video and a passing mention in another. When genuinely unsure, "
    "answer true — wrongly hiding something the viewer needed is worse than leaving a "
    "little noise. Return a verdict for EVERY term."
)

# Only terms reachable from a segment matter; anything else never reaches a cut list.
_TERMS = """
MATCH (v:Video)-[:HAS_SEGMENT]->(s:Segment)-[:ABOUT|MENTIONS]->(x)
WHERE (x:Topic OR x:Entity)
WITH x, labels(x)[0] AS label, collect(DISTINCT s.summary)[0] AS context,
     collect(DISTINCT v.title)[0] AS video
RETURN x.name AS name, label, x.type AS type, context, video
ORDER BY name
"""

_WRITE = """
UNWIND $rows AS row
MATCH (x) WHERE (x:Topic OR x:Entity) AND x.name = row.name
SET x.learnable = row.learnable
"""


def classify(terms: list[dict]) -> list[TermVerdict]:
    from openai import OpenAI

    client = OpenAI(api_key=settings.openai_api_key or None)
    listing = "\n".join(
        f'- "{t["name"]}" ({t["label"]}/{t.get("type") or "n/a"}) '
        f'— from "{(t.get("video") or "")[:40]}": {(t.get("context") or "")[:220]}'
        for t in terms
    )
    response = client.responses.parse(
        model=settings.openai_extraction_model,
        reasoning={"effort": settings.openai_reasoning_effort},
        input=[
            {"role": "system", "content": CLASSIFY_SYSTEM},
            {"role": "user", "content": f"Terms:\n\n{listing}"},
        ],
        text_format=TermVerdicts,
    )
    if response.output_parsed is None:
        raise RuntimeError("OpenAI returned no classification.")
    return response.output_parsed.terms


async def main() -> None:
    dry_run = "--dry-run" in sys.argv
    await connect_neo4j()
    try:
        terms = await execute_cypher(_TERMS, {}, collect=False) or []
        log.info("classifying %d terms", len(terms))

        chunks = [terms[i:i + TERMS_PER_CHUNK] for i in range(0, len(terms), TERMS_PER_CHUNK)]
        sem = asyncio.Semaphore(CLASSIFY_CONCURRENCY)

        async def one(chunk: list[dict]) -> list[TermVerdict]:
            async with sem:
                try:
                    return await asyncio.to_thread(classify, chunk)
                except Exception as exc:  # a failed chunk must not unmark the rest
                    log.warning("chunk failed, leaving %d terms unclassified: %s",
                                len(chunk), exc)
                    return []

        results = await asyncio.gather(*(one(c) for c in chunks))
        verdicts = [v for r in results for v in r]

        # The model echoes names back; only write ones we actually asked about, so a
        # hallucinated term name can never create or alter a node.
        known = {t["name"] for t in terms}
        rows = [{"name": v.term, "learnable": v.learnable}
                for v in verdicts if v.term in known]
        rejected = sorted(r["name"] for r in rows if not r["learnable"])

        log.info("%d verdicts, %d matched a real term, %d rejected as noise",
                 len(verdicts), len(rows), len(rejected))
        log.info("rejected: %s", ", ".join(rejected) or "(none)")

        missing = known - {r["name"] for r in rows}
        if missing:
            log.info("%d terms got no verdict, left unclassified (treated as learnable)",
                     len(missing))

        if dry_run:
            log.info("dry run — nothing written")
            return
        await execute_cypher(_WRITE, {"rows": rows}, collect=False)
        log.info("wrote learnable on %d terms", len(rows))
    finally:
        await close_neo4j()


if __name__ == "__main__":
    asyncio.run(main())
