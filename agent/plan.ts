// The model plans checks and words the report. It never decides the verdict: rules in jobs.ts do.
import { askJson, ask } from "../core/llm.ts";
import { sanitize, type Check } from "./browser.ts";

const VOCAB = `Each check is {"name": string, "viewport": "mobile"|"desktop", "steps": Step[]}.
Steps (nothing else is allowed):
  {"do":"goto","path":"/"}                       open a page (path must start with /)
  {"do":"click","target":"<visible button/link text or aria-label>"}
  {"do":"fill","target":"<field label or placeholder>","value":"..."}
  {"do":"press","key":"Enter"}
  {"do":"expectText","text":"<text that must become visible>"}
  {"do":"expectNoText","text":"<text that must NOT be visible>"}
  {"do":"wait","ms":500}
Use the exact accessible names from CONTROLS and exact text from VISIBLE TEXT; a control without a name is targeted by its id, e.g. "#input". Never invent products, buttons or fields that are not listed. Keep each check under 10 steps.
expectText must match text that will literally appear on the page (copy the formatting you see in the HTML and scripts, e.g. "2 × Karak chai", "AED 8").
Check one fact per expectText. If you assert a total, work it out step by step from the prices on the page (price × quantity) and double-check it.`;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n…" : s);

export async function planForPR(pr: { title: string; body: string | null }, diff: string, html: string): Promise<Check[]> {
  const system = `You are a careful QA tester. You test a web app pull request like a real user would, in a browser.
Write 1 to 3 checks for what this PR adds or changes, as a user would see it. The app's core journeys (like checking out) are tested separately, so focus on the change itself.
Use "mobile" for at least one check if the PR touches layout or CSS. Each check should end with an expectText (or expectNoText) that describes the correct outcome after the PR.
${VOCAB}
Return {"checks": [...]}.`;
  const user = `PR title: ${pr.title}\nPR description: ${clip(pr.body ?? "", 1500)}\n\nDIFF:\n${diff}\n\nCURRENT HOME PAGE (main branch):\n${clip(html, 12000)}`;
  const out = await askJson<{ checks: unknown }>(system, user, 1800);
  return sanitize(out.checks);
}

/**
 * The app's core user journeys, planned from main alone (the model never sees the PR here).
 * Each journey runs on a phone and on desktop; any journey that works on main must still work on the PR.
 */
export async function planJourneys(html: string): Promise<Check[]> {
  const system = `You are a careful QA tester. Look at this web app's home page and write the 2 most important user journeys, the ones that must never break.
Journey 1 must go all the way through the app's main goal and finish it (for a shop: add an item, press the checkout/pay/submit button, then expectText on the confirmation message).
Journey 2 covers the next most important path. Each journey must end with an expectText that proves it succeeded. Do not test cosmetics.
${VOCAB}
Return {"journeys": [{"name": string, "steps": Step[]}]}. Leave out viewport: every journey runs on phone and desktop.`;
  const out = await askJson<{ journeys: unknown }>(system, `HOME PAGE:\n${clip(html, 12000)}`, 1500);
  const base = sanitize(out.journeys, 2);
  return base.flatMap((j, i) => (["mobile", "desktop"] as const).map((viewport) => ({ ...j, id: `j${i + 1}${viewport[0]}`, viewport })));
}

/** A journey failed on main (which we assume works): let the model correct its own check once. */
export async function repairJourney(check: Check, failedAt: string, error: string, screen: string, page: string): Promise<Check | null> {
  const system = `You wrote a browser check for the main branch of a web app, which is assumed to work. The check failed, so the check itself is probably wrong.
Fix the steps or the expected text so the check matches what the app really does, keeping the same goal. Do not weaken it into checking nothing.
${VOCAB}
Return {"steps": Step[]}.`;
  const user = `CHECK "${check.name}":\n${JSON.stringify(check.steps)}\n\nIt failed at: ${failedAt}\nError: ${error.split("\n")[0]}\n\nWHAT THE SCREEN SHOWED WHEN IT FAILED:\n${clip(screen, 1500)}\n\nTHE PAGE:\n${clip(page, 12000)}`;
  try {
    const out = await askJson<{ steps: unknown }>(system, user, 1200);
    const [fixed] = sanitize([{ name: check.name, viewport: check.viewport, steps: out.steps }], 1);
    return fixed ? { ...fixed, id: check.id, viewport: check.viewport } : null;
  } catch {
    return null;
  }
}

export async function planForIssue(issue: { title: string; body: string | null }, html: string): Promise<{ checks: Check[]; expected: string }> {
  const system = `You are a careful QA tester reproducing a bug report in a browser.
Turn the report into 1 or 2 checks that follow the reporter's steps and then assert what SHOULD happen if the app were correct.
If the bug is real, the final expectText will fail. Pick the viewport the reporter mentions (default "desktop").
${VOCAB}
Return {"checks": [...], "expected": "<one plain sentence: what should happen>"}.`;
  const user = `ISSUE: ${issue.title}\n${clip(issue.body ?? "", 2000)}\n\nHOME PAGE:\n${clip(html, 12000)}`;
  const out = await askJson<{ checks: unknown; expected?: string }>(system, user, 1500);
  return { checks: sanitize(out.checks, 2), expected: String(out.expected ?? "").slice(0, 300) };
}

/** One plain-English headline for the report. Falls back to the rule-based one if the model fails. */
export async function headline(facts: string, fallback: string): Promise<string> {
  try {
    const t = await ask(
      `You write the one-line headline of a QA report for a busy developer. Plain text, no Markdown, no emoji, max 14 words.
Say what is broken from the user's point of view (e.g. "Checkout button can't be tapped on phones"). Only use the facts given.`,
      facts,
      800, // reasoning models spend part of the budget thinking; 200 sometimes left nothing for the answer
    );
    const line = t.replace(/[*_#`]/g, "").split("\n").map((s) => s.trim()).find(Boolean) ?? "";
    return line.length > 8 && line.length < 140 ? line : fallback;
  } catch {
    return fallback;
  }
}
