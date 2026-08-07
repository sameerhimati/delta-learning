/**
 * Records the demo GIF — the beat this project exists for, in the real UI.
 *
 * Committed rather than screen-captured by hand so the asset can be regenerated when the
 * UI changes, which is why the terminal recording it replaced had a .tape file beside it.
 *
 * Run:
 *   make demo                          # Neo4j + the shipped snapshot + the app
 *   cd frontend && node e2e/record-cut-list.mjs
 *   # then convert the webm to a gif — see demo/README.md
 *
 * Needs an OPENAI_API_KEY. Capture is gated on a graded quiz, and that gate is the point
 * of the recording: the app refuses to take your word that you learned something.
 *
 * APP_URL overrides the host, OUT_DIR the destination.
 */
import { chromium } from "@playwright/test";

const APP = process.env.APP_URL || "http://localhost:3000";
const OUT = process.env.OUT_DIR || "../demo/raw";

// Two game-theory talks were ingested independently, sharing no metadata — only concepts
// that MERGE'd onto the same graph nodes. Proving those concepts here shortens this talk.
const STUDY = "Game Theory";

// Real answers, because a vague one is refused and the recording would show that instead.
// Matched to whichever concept the quiz picks; the graph decides, not this script.
const ANSWERS = [
  [/prisoner/i,
    "Each player does better defecting whatever the other does, so mutual defection is " +
    "the dominant-strategy equilibrium — even though both would be better off cooperating."],
  [/rational choice/i,
    "It models agents as picking the option that maximises their own preferences given " +
    "their constraints and beliefs, so behaviour is predicted from incentives."],
  [/nash/i,
    "A profile where no player can improve their payoff by unilaterally changing strategy, " +
    "so nobody has a reason to deviate."],
  [/dominant/i,
    "A strategy that gives a better payoff than any alternative no matter what the other " +
    "players do, so a rational player always plays it."],
  [/tit.for.tat|axelrod|repeated/i,
    "Cooperate first, then copy whatever the opponent did last — it is nice, retaliatory, " +
    "forgiving and clear, which is why it won Axelrod's repeated tournaments."],
  [/game theory/i,
    "The mathematical study of strategic interaction, where each player's payoff depends " +
    "on the choices of the others, not just their own."],
];

// Deliberately weak, used on the last question. The refusal is not a blemish on the demo,
// it IS the demo: a fluent non-answer stays in the cut list, and the app says why.
const HANDWAVE = "It's an important idea in game theory that comes up a lot.";

const answerFor = (concept) =>
  (ANSWERS.find(([pattern]) => pattern.test(concept)) ?? [])[1] ?? HANDWAVE;

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1120, height: 820 },
  deviceScaleFactor: 2,
  recordVideo: { dir: OUT, size: { width: 1120, height: 820 } },
});
const page = await context.newPage();
const settle = (ms) => page.waitForTimeout(ms);

await page.goto(APP, { waitUntil: "domcontentloaded" });
await page.getByText("Study queue").waitFor({ timeout: 30_000 });
await settle(1200);

// 1. Pick the talk. Its cut list is the "before".
await page.getByRole("button", { name: new RegExp(STUDY, "i") }).first().click();
const headline = page.getByText(/Watch \d+:\d+/).first();
await headline.waitFor({ timeout: 30_000 });
await headline.scrollIntoViewIfNeeded();
await settle(3800); // let the timecoded ranges and concept badges register

// 2. Capture is gated on a quiz — nothing is recorded on a button press alone.
await page.getByRole("button", { name: /Capture learnings/i }).click();

const answerBox = page.getByPlaceholder(/Answer in your own words/i);
await answerBox.waitFor({ timeout: 60_000 }); // live model call, ~5s on this corpus
await settle(900);

// The step chips name the concepts in the order they'll be asked ("1. Prisoner's Dilemma"),
// which is steadier than scraping the question text out of the rendered card.
const chips = (await page.getByText(/^\d+\.\s+\S/).allTextContents())
  .map((t) => t.replace(/^\d+\.\s*/, "").trim())
  .filter(Boolean);
console.log("quiz asks about:", chips.join(" · ") || "(chips not found)");

// 3. Answer in order. The last one is answered badly on purpose — see HANDWAVE.
for (let i = 0; i < Math.max(chips.length, 1); i++) {
  const isLastQuestion = i === chips.length - 1;
  const answer = isLastQuestion ? HANDWAVE : answerFor(chips[i] ?? "");

  await answerBox.click();
  if (i === 0) await answerBox.type(answer, { delay: 9 }); // reads as a person answering
  else await answerBox.fill(answer);
  await settle(i === 0 ? 700 : 500);

  const grade = page.getByRole("button", { name: /Grade my answers/i });
  if (await grade.count()) {
    await grade.click();
    break;
  }
  await page.getByRole("button", { name: /^Next/i }).first().click();
  await settle(450);
}

// 4. Grading is a live reasoning call; the UI shows an elapsed counter meanwhile.
const applyButton = page.getByRole("button", { name: /See my updated cut/i });
await applyButton.waitFor({ timeout: 90_000 });
await settle(2600); // the per-concept verdicts are worth reading
await applyButton.click();

// 5. The payoff: same talk, same corpus, a shorter cut list.
await settle(5200);

await context.close();
await browser.close();
console.log(`Recorded to ${OUT}/ — convert with ffmpeg, see demo/README.md`);
