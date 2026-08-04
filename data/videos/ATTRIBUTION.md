# Sample video attribution

This directory is where video files go. It ships empty — `.mp4` files are gitignored
because they are far too large for a repo, and because most of them are other people's
talks.

## The fallback clip

With no `VIDEOS=` argument and nothing in this directory, `make seed` downloads
`SAMPLE_VIDEO_URLS` from your `.env`, which defaults to a short clip of
**_Big Buck Bunny_** (2008), the "Peach" open-movie project by the Blender Institute.

- **© copyright 2008, Blender Foundation / [www.bigbuckbunny.org](https://peach.blender.org/)**
- **License: [Creative Commons Attribution 3.0 (CC-BY 3.0)](https://creativecommons.org/licenses/by/3.0/)**

_Big Buck Bunny_ is a Creative Commons–licensed open movie: you may reuse, redistribute,
and adapt it — including commercially — provided you give proper attribution to the
Blender Foundation. It is used here **solely as a sample input for research, testing, and
demonstration** of this project's video-understanding pipeline. No endorsement by the
Blender Foundation is implied.

It exercises the pipeline, not the product: an animated short has nothing to teach, so
its cut list is meaningless. Use real talks to see the delta do anything interesting.

## Your own videos

Drop `.mp4` files here and `make seed` picks them up, or pass paths explicitly (see the
README, "Run it on your own videos and your own notes"). **Ensure you have the rights to
any media you add** — and note that ingestion uploads it to TwelveLabs for analysis.
