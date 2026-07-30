# Delta Learning — 3-minute demo script

**Roles:** Sameer drives the screen and owns the graph + payoff. Luke narrates the panel
he built. Swap freely, but whoever says a number must have it on screen.

**One rule:** never say a sponsor name without saying what it does in the same breath.
"We used TwelveLabs" is worth nothing. "TwelveLabs Pegasus watched the video so we have
concepts per segment, not a transcript blob" is worth the whole mention.

---

## 0:00–0:20 · The problem — SAMEER
*On screen: the app, four videos listed.*

> "Every video AI answers the same question: what's in this video? But if you already know
> two thirds of it, that answer wastes your afternoon. We answer the question retrieval
> structurally can't — **what's in this video that I don't already know?**"

## 0:20–0:45 · The graph — SAMEER
*On screen: graph view. Point at video nodes, then at concept nodes.*

> "Here's why nobody else can answer it. This one **Neo4j** graph holds both halves —
> the video's segments *and* my knowledge state, 117 concepts pulled from my Obsidian
> vault. Everyone else's graph has no 'me' in it.
>
> Getting the video half took **TwelveLabs Pegasus**, which actually watches the footage,
> so each segment carries real concepts instead of a transcript blob. Then **Marengo**
> embeds both sides — the video segments *and* my vault note titles — into the same space,
> which is what lets 'Nash equilibrium' in my notes match the moment it's taught on video.
> **OpenAI structured outputs** adjudicate every candidate match, so a fuzzy embedding hit
> never becomes a claim about what I know."

## 0:45–1:25 · Your Cut — LUKE
*On screen: click Game Theory B. Your Cut panel loads.*

> "So this is a 17:47 talk, and this is what it looks like against my knowledge state.
> **Watch 16:08 — here are the two ranges, timecoded**, and these are the concepts new to
> me. Novel in orange, my goals in blue. Every skip is a claim the graph can defend: if
> nothing here matched what I know, it says so, instead of pretending I already knew it.
>
> This is set difference over a traversal, not a summary — it's a cut list I can click."

## 1:25–2:15 · The climax: capture is earned — LUKE
*On screen: hit "Capture learnings." Quiz opens. Answer one well, bluff one.*

> "Now the part that makes it real. When I say I learned something, it doesn't take my
> word for it — it quizzes me. **OpenAI structured outputs** generate the questions from
> the segment and grade the answers.
>
> That one I actually knew. This one I'm going to bluff…
> *(read the rejection aloud)*
> It refuses fluent-but-wrong. And what I failed **keeps its timecodes** — it stays on my
> cut list, because I still need to watch it."

**If the grader is slow, keep talking over it — do not sit in silence.**

## 2:15–2:45 · The payoff — SAMEER
*On screen: reload the same video's cut. 968 → 616.*

> "Same video. Same graph. I captured what I proved — and the cut just went from 16 minutes
> to 10. **The corpus didn't change. I changed.**
>
> That loop is the product: every video you finish makes the next one shorter."

## 2:45–3:00 · The honest failure, and the close — SAMEER
*On screen: chat — ask for something the corpus can't teach.*

> "And when the answer is 'nothing here teaches that,' we don't dead-end — it goes and
> finds real material outside the corpus.
>
> Thirteen tools orchestrated with **Strands**, AWS's agent SDK, so every one of these is
> reachable by just asking. Delta Learning — it doesn't tell you what's in the video, it
> tells you what's *left*."

---

## Tech mention checklist — tick each before you submit

| Tech | Where it's said | The "how it helps" clause |
|---|---|---|
| **TwelveLabs Pegasus** | 0:20 | watches the footage → concepts per segment, not a transcript blob |
| **TwelveLabs Marengo** | 0:20 | embeds *both* sides → vault notes match video moments |
| **OpenAI** | 0:20 + 1:25 | structured outputs adjudicate matches; generate + grade the quiz; `gpt-5.6` is the agent brain |
| **Neo4j** | 0:20 | one graph holds video + viewer; the delta is a traversal, plus 2 vector indexes and GDS |
| **Strands (AWS)** | 2:45 | orchestrates 13 tools → every capability reachable from chat |

Do **not** claim Bedrock or AWS hosting. Strands is the AWS piece. That's the honest line.

## Don't record

- Paste-a-YouTube-URL ingest — yt-dlp downloads are bot-blocked on this machine, it will
  fail live. (Search works, so the 2:45 beat is safe.)
- Curriculum / coverage / watchlist — real and honest, but a different product than these
  3 minutes are selling. Put them in the writeup.

## Pre-flight, every take

```zsh
curl -s "localhost:8000/api/delta/A%20Simple%20Strategy" | python3 -m json.tool | head -20
```
Must read `watch_sec: 968`, `known: 0`. If it doesn't, a rehearsal spent the beat:
```zsh
docker exec delta-learning-neo4j-1 cypher-shell -u neo4j -p password \
  "MATCH (c:Concept) WHERE c.key STARTS WITH 'video:' DETACH DELETE c"
```
Hard-refresh the browser. **Rehearsing the capture beat consumes it — re-run the delete.**

## Known rough edge, if a judge asks

Two of the three novel concepts on Game Theory B are ontology noise ("Grass Camp",
"Joss"). Don't hide it: the ontology is extracted from real transcripts, noise included,
and we didn't curate a demo list. Narrate that beat on the **number and the timecodes**,
not the pill names.
