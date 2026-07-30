# Delta Learning — demo running order

**Sameer** drives the screen: beats 1, 2, 5, 6. **Luke** narrates beats 3 and 4 (his panel).

| # | Show | Say |
|---|------|-----|
| 1 | App, 4 videos | Everyone answers "what's in this video." We answer "what's in it that I don't already know." |
| 2 | Graph view | One **Neo4j** graph holds the video *and* me — 117 concepts from my Obsidian vault. Everyone else's graph has no "me" in it. |
| 3 | Click Game Theory B → Your Cut | 17:47 talk, watch 16:08. Timecoded ranges, orange = new to me, blue = my goals. Set difference, not a summary. |
| 4 | "Capture learnings" → quiz. Answer one, bluff one | It doesn't take my word that I learned it — it quizzes me. Bluff gets refused. What I fail keeps its timecodes. |
| 5 | Reload the cut: 968 → 616 | Same video, same graph. **The corpus didn't change. I changed.** |
| 6 | Chat: ask for something the corpus can't teach | Dead end becomes real outside material. 13 tools, all reachable by asking. |

## Tech — one line each, said while it's on screen

- **TwelveLabs Pegasus** (beat 2) — watches the footage, so segments carry concepts, not a transcript blob.
- **TwelveLabs Marengo** (beat 2) — embeds *both* sides, video segments and my vault notes, into one space. That's what makes the match possible.
- **OpenAI** (beat 2 + 4) — structured outputs adjudicate every match, then generate and grade the quiz. `gpt-5.6` is the agent brain.
- **Neo4j** (beat 2) — both halves in one graph, so the delta is a traversal. 2 vector indexes + GDS.
- **Strands** (beat 6) — AWS's agent SDK, orchestrates the 13 tools.

Never say a name without the "so that" clause. yt-dlp fetched the mp4s — plumbing, only mention if asked. **Don't claim Bedrock or AWS hosting** — Strands is the AWS piece.

## Don't demo

Paste-a-YouTube-URL (downloads are bot-blocked here, it will fail live — search still works so beat 6 is safe). Curriculum/watchlist — different product, put it in the writeup.

## Before every take

```zsh
curl -s "localhost:8000/api/delta/A%20Simple%20Strategy" | python3 -m json.tool | head -20
```
Must read `watch_sec: 968`, `known: 0`. If not, a rehearsal spent it:
```zsh
docker exec delta-learning-neo4j-1 cypher-shell -u neo4j -p password \
  "MATCH (c:Concept) WHERE c.key STARTS WITH 'video:' DETACH DELETE c"
```
Hard-refresh. **Rehearsing beat 4 consumes the beat — re-run the delete.**

If asked about "Grass Camp": ontology comes from real transcripts, noise included, we didn't curate a demo list.
