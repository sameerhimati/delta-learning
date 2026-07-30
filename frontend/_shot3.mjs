import { chromium } from "@playwright/test";
import { mkdirSync } from "fs";
const DIR = `/private/tmp/claude-501/-Users-sameer-Code-delta-learning/9a90adce-ff36-4508-9f53-e32529539781/scratchpad/${process.argv[2] || "now"}`;
mkdirSync(DIR, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1512, height: 950 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
const shot = (n) => page.screenshot({ path: `${DIR}/${n}.png` }).then(() => console.log("shot", n));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
await wait(3500);
await shot("a-study");

await page.getByRole("button", { name: /What I know/i }).first().click();
await wait(4000);
await shot("b-whatiknow");
await page.mouse.move(1100, 600);
await page.mouse.wheel(0, 900);
await wait(700);
await shot("c-whatiknow-2");
await page.mouse.wheel(0, 1200);
await wait(700);
await shot("d-whatiknow-3");

console.log("CONSOLE ERRORS:", JSON.stringify(errors, null, 1));
await browser.close();
