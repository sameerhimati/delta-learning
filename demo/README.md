# Demo assets

`cut-list.gif` is the README's hero image: a real cut list in the real UI, shortened by a
graded quiz. It is generated, not hand-captured, so it can be regenerated when the UI
changes instead of quietly going stale.

## Regenerating it

Needs Docker, and an `OPENAI_API_KEY` in `.env` — capture is gated on a graded quiz, which
is the part of the loop worth recording.

```bash
make demo                                  # Neo4j + the shipped snapshot + the app
cd frontend && node e2e/record-cut-list.mjs   # writes demo/raw/<hash>.webm
```

The recorder ([`frontend/e2e/record-cut-list.mjs`](../frontend/e2e/record-cut-list.mjs))
lives under `frontend/` because that's where `@playwright/test` resolves from. It picks the
game-theory talk, sits on the cut list, answers two quiz questions properly and the third
badly on purpose, and applies the result.

Then convert the webm — 1.5× speed keeps the typing from dragging, and 64 colours holds a
1280-wide screen recording under 2 MB:

```bash
cd demo
F="[0:v]setpts=PTS/1.5,fps=8,scale=800:-1:flags=lanczos"
ffmpeg -y -i raw/*.webm -filter_complex "$F[x];[x]palettegen=stats_mode=diff:max_colors=64[p]" -map "[p]" /tmp/pal.png
ffmpeg -y -i raw/*.webm -i /tmp/pal.png \
  -filter_complex "$F[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle" cut-list.gif
```

`raw/` is gitignored — only the finished GIF is committed.

## Why the recording is what it is

- **The real UI, not the API.** An earlier version recorded `curl` output with
  [vhs](https://github.com/charmbracelet/vhs). It was honest but it showed the mechanism
  rather than the product: the thing worth seeing is a timecoded cut list with concept
  badges, and JSON undersells it.
- **1120px wide.** Above Chakra's `xl` breakpoint the study-notes panel sits to the right
  and gets cropped; below it, the layout reflows and nothing is clipped.
- **The last answer is deliberately bad.** The refusal isn't a flaw in the take — a fluent
  non-answer staying in the cut list, with the app explaining what it wanted instead, is
  the argument. Watch the first recommended clip afterwards: it's the concept that failed.
