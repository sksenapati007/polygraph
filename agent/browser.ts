// Browser checks run on a separate, keyless Sprite with Playwright installed.
// The model never writes code that runs: it writes steps in a tiny vocabulary, and this runner
// turns them into Playwright calls. An unknown step fails the check instead of executing anything.
import * as sprites from "../core/sprites.ts";
import { mkdirSync, writeFileSync } from "node:fs";

export const BROWSER = process.env.PG_BROWSER_SPRITE ?? "pg-browser";

export type Step =
  | { do: "goto"; path: string }
  | { do: "click"; target: string }
  | { do: "fill"; target: string; value: string }
  | { do: "press"; key: string }
  | { do: "expectText"; text: string }
  | { do: "expectNoText"; text: string }
  | { do: "wait"; ms: number }
  | { do: "tapTargets" }; // built-in only: the model can't emit it (sanitize drops it)

export interface Check { id: string; name: string; viewport: "mobile" | "desktop"; steps: Step[] }
export interface CheckResult {
  target: string; id: string; ok: boolean; failedStep: number | null; error: string;
  observed: string; controls?: string[]; consoleErrors: string[]; shot: string; ms: number;
}

const RUNNER = String.raw`
const { chromium, devices } = require("playwright");
const fs = require("fs");
const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = job.outDir; fs.mkdirSync(out, { recursive: true });
const VIEW = { mobile: { ...devices["iPhone 13"] }, desktop: { viewport: { width: 1280, height: 800 } } };
function find(page, t) {
  if (/^#[\w-]+$/.test(t)) return Promise.resolve(page.locator(t).first()); // unnamed controls, by id
  const tries = [page.getByRole("button", { name: t }), page.getByRole("link", { name: t }), page.getByLabel(t), page.getByText(t, { exact: false })];
  return (async () => { for (const l of tries) if (await l.count()) return l.first(); return tries[0].first(); })();
}
async function step(page, s, base) {
  switch (s.do) {
    case "goto": return page.goto(new URL(s.path || "/", base).href, { waitUntil: "networkidle", timeout: 20000 });
    case "click": return (await find(page, s.target)).click({ timeout: 5000 });
    case "fill": return (await find(page, s.target)).fill(String(s.value), { timeout: 5000 });
    case "press": return page.keyboard.press(s.key);
    case "expectText": return page.getByText(s.text, { exact: false }).first().waitFor({ state: "visible", timeout: 5000 });
    case "expectNoText": { await page.waitForTimeout(500); if (await page.getByText(s.text, { exact: false }).first().isVisible()) throw new Error("found text that should not be there: " + s.text); return; }
    case "wait": return page.waitForTimeout(Math.min(Number(s.ms) || 500, 5000));
    case "tapTargets": {
      // Every visible control must be reachable: after scrolling it to the middle of the screen,
      // the element under its centre must be the control itself (not a banner, modal or overlay).
      const covered = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll("button,a[href],input,select,textarea,[role=button]")) {
          const r0 = el.getBoundingClientRect();
          if (!r0.width || !r0.height || getComputedStyle(el).visibility === "hidden") continue;
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
          if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
          const top = document.elementFromPoint(x, y);
          if (top && top !== el && !el.contains(top) && !top.contains(el)) {
            const owner = top.closest("[class],[id]") || top;
            const by = owner.tagName.toLowerCase() + (owner.id ? "#" + owner.id : owner.classList[0] ? "." + owner.classList[0] : "");
            const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.tagName).trim().replace(/\s+/g, " ").slice(0, 40);
            bad.push('"' + name + '" (covered by <' + by + '>)');
          }
        }
        window.scrollTo(0, 0);
        return bad;
      });
      if (covered.length) throw new Error("covered: " + covered.join("; "));
      return;
    }
    default: throw new Error("unknown step: " + s.do);
  }
}
(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const [target, base] of Object.entries(job.targets)) {
    for (const c of job.checks) {
      const t0 = Date.now();
      const ctx = await browser.newContext(VIEW[c.viewport] || VIEW.desktop);
      const page = await ctx.newPage();
      const consoleErrors = [];
      page.on("pageerror", (e) => consoleErrors.push("page error: " + e.message));
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
      page.on("response", (r) => { if (r.status() >= 500) consoleErrors.push(r.status() + " from " + new URL(r.url()).pathname); });
      let ok = true, failedStep = null, error = "";
      const steps = c.steps[0] && c.steps[0].do === "goto" ? c.steps : [{ do: "goto", path: "/" }, ...c.steps];
      for (let i = 0; i < steps.length; i++) {
        try { await step(page, steps[i], base); }
        catch (e) {
          // Keep the first line plus the lines that explain WHY (e.g. "<aside class=promo> intercepts pointer events").
          const lines = String(e.message || e).split("\n");
          const why = lines.filter((l) => /intercepts pointer events|not enabled|not visible|not stable|outside of the viewport/.test(l)).slice(-2);
          ok = false; failedStep = i; error = [lines[0], ...why].join("\n"); break;
        }
      }
      if (ok && consoleErrors.some((m) => m.startsWith("page error"))) { ok = false; error = "the page threw an error"; }
      await page.waitForTimeout(300);
      const shot = target + "-" + c.id + ".png";
      await page.screenshot({ path: out + "/" + shot }).catch(() => {});
      const observed = (await page.locator("body").innerText().catch(() => "")).replace(/\s+\n/g, "\n").slice(0, 1500);
      // What a user can operate, by accessible name: this is what the planner targets.
      const controls = await page.evaluate(() => [...document.querySelectorAll("button,a[href],input,select,textarea,[role=button]")].slice(0, 60).map((el) => {
        const name = el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("placeholder") || el.innerText || el.getAttribute("name") || "";
        const label = name.trim().replace(/\s+/g, " ").slice(0, 60);
        return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + ": " + (label || "(no name: target it as #" + (el.id || "?") + ")") + (el.disabled ? " (disabled)" : "");
      })).catch(() => []);
      results.push({ target, id: c.id, ok, failedStep, error, observed, controls, consoleErrors: consoleErrors.slice(0, 5), shot, ms: Date.now() - t0 });
      await ctx.close();
    }
  }
  await browser.close();
  for (const r of results) { try { fs.writeFileSync(out + "/" + r.shot + ".b64", fs.readFileSync(out + "/" + r.shot).toString("base64")); } catch {} }
  fs.writeFileSync(out + "/results.json", JSON.stringify(results));
})().catch((e) => { fs.writeFileSync(out + "/results.json", JSON.stringify({ crash: String(e) })); });
`;

/** Normalise whatever the model produced into well-formed checks; drop anything malformed. */
export function sanitize(raw: unknown, max = 4): Check[] {
  const list = Array.isArray(raw) ? raw : [];
  const okStep = (s: any): s is Step =>
    s && typeof s === "object" &&
    ((s.do === "goto" && typeof s.path === "string" && s.path.startsWith("/")) ||
      (s.do === "click" && typeof s.target === "string") ||
      (s.do === "fill" && typeof s.target === "string" && s.value !== undefined) ||
      (s.do === "press" && typeof s.key === "string") ||
      ((s.do === "expectText" || s.do === "expectNoText") && typeof s.text === "string" && s.text.trim()) ||
      (s.do === "wait" && typeof s.ms === "number"));
  return list
    .filter((c: any) => c && Array.isArray(c.steps))
    .slice(0, max)
    .map((c: any, i: number) => ({
      id: `c${i + 1}`,
      name: String(c.name ?? `Check ${i + 1}`).slice(0, 120),
      viewport: (c.viewport === "mobile" ? "mobile" : "desktop") as Check["viewport"],
      steps: c.steps.filter(okStep).slice(0, 12),
    }))
    .filter((c) => c.steps.length > 0);
}

/** Run every check against every target (e.g. { main: url, pr: url }). Screenshots land in shotDir. */
export async function runChecks(runId: string, targets: Record<string, string>, checks: Check[], shotDir: string): Promise<CheckResult[]> {
  const outDir = `/var/tmp/pg-${runId}`;
  await sprites.writeFile(BROWSER, "/home/sprite/pw/runner.js", RUNNER);
  await sprites.writeFile(BROWSER, `${outDir}.json`, JSON.stringify({ targets, checks, outDir }));
  const r = await sprites.run(BROWSER, `cd ~/pw && timeout 240 node runner.js ${outDir}.json`, 260_000);
  const raw = await sprites.readFile(BROWSER, `${outDir}/results.json`);
  const parsed = raw ? JSON.parse(raw) : { crash: r.out.slice(-500) };
  if (!Array.isArray(parsed)) throw new Error(`browser run failed: ${parsed.crash}`);
  mkdirSync(shotDir, { recursive: true });
  for (const res of parsed as CheckResult[]) {
    const b64 = await sprites.readFile(BROWSER, `${outDir}/${res.shot}.b64`);
    if (b64) writeFileSync(`${shotDir}/${runId}-${res.shot}`, Buffer.from(b64, "base64"));
    res.shot = `${runId}-${res.shot}`;
  }
  await sprites.run(BROWSER, `rm -rf ${outDir} ${outDir}.json`, 30_000);
  return parsed;
}

/** Open the page in the real browser and describe what is actually on screen, for the planner. */
export async function snapshot(runId: string, url: string, shotDir: string): Promise<string> {
  const [r] = await runChecks(`${runId}s`, { main: url }, [{ id: "snap", name: "snapshot", viewport: "desktop", steps: [{ do: "goto", path: "/" }] }], shotDir);
  return `VISIBLE TEXT (rendered in a real browser):\n${r?.observed ?? ""}\n\nCONTROLS (tag: accessible name):\n${(r?.controls ?? []).join("\n")}`;
}
