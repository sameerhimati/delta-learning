# Agent brief

Read `CLAUDE.md` in this directory — it is the single source of truth for this project:
what we're building, the division of labor, the frozen API contract, and the deadline.

If you are Luke's agent: your lane is `frontend/` ONLY. Never modify `backend/`, `cypher/`,
`data/`, or the `Makefile` — the other half of the team owns those and pushes frequently.
Start from "Luke + his Claude: frontend + garnish" in `CLAUDE.md`. Build against
`frontend/fixtures/delta.json` first; live API comes later via a tunnel URL.
