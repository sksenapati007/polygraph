// The two jobs: check a pull request, and reproduce a bug report.
// Rules decide every verdict. The model only plans checks and writes the headline.
import { randomBytes } from "node:crypto";
import * as sprites from "../core/sprites.ts";
import { notify } from "../core/notify.ts";
import * as gh from "./github.ts";
import { boot, destroy, type Machine } from "./machine.ts";
import { runChecks, snapshot, type Check, type CheckResult } from "./browser.ts";
import { planForPR, planJourneys, repairJourney, planForIssue, headline } from "./plan.ts";

export const PUBLIC = process.env.PG_PUBLIC_URL ?? "http://localhost:8080";
export const SHOTS = process.env.PG_SHOTS ?? "/home/sprite/polygraph/data/shots";
const KEEP_HOURS = Number(process.env.PG_KEEP_HOURS ?? 24); // how long a failed machine is kept for debugging
const KEPT = KEEP_HOURS >= 48 ? `${Math.round(KEEP_HOURS / 24)} days` : `${KEEP_HOURS} hours`;
export const JOURNEYS = new Map<string, Check[]>(); // exported so tests can force a re-plan

export type Verdict = "running" | "pass" | "fail" | "reproduced" | "not-reproduced" | "inconclusive" | "error";
export interface Finding { check: Check; main?: CheckResult; pr?: CheckResult; kind: "ok" | "regression" | "fixed" | "new" | "broken" | "preexisting" | "reproduced" | "not-reproduced" | "unclear" }
export interface Run {
  id: string; kind: "pr" | "issue"; repo: string; number: number; title: string; url: string; sha: string;
  startedAt: number; finishedAt?: number; verdict: Verdict; headline: string; expected?: string;
  tests: { main?: Machine["tests"]; pr?: Machine["tests"] };
  findings: Finding[];
  machine?: { sprite: string; url: string; checkpoint: string; expiresAt: number };
  log: string[];
}

const short = (sha: string) => sha.slice(0, 7);
const sid = (repo: string) => repo.split("/")[1].replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 14);
const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").slice(0, 180);
const shotUrl = (f?: string) => (f ? `${PUBLIC}/shots/${f}` : "");
const view = (c: Check) => (c.viewport === "mobile" ? "phone" : "desktop");

function describeStep(s: Check["steps"][number]): string {
  switch (s.do) {
    case "goto": return `Open ${s.path}`;
    case "click": return `Tap "${s.target}"`;
    case "fill": return `Type "${s.value}" into "${s.target}"`;
    case "press": return `Press ${s.key}`;
    case "expectText": return `Expect to see "${s.text}"`;
    case "expectNoText": return `Expect not to see "${s.text}"`;
    case "wait": return `Wait ${s.ms} ms`;
    case "tapTargets": return `Check every button, link and field can be tapped`;
  }
}
const steps = (c: Check) => (c.steps[0]?.do === "goto" ? c.steps : [{ do: "goto", path: "/" } as const, ...c.steps]);

/** Why it failed, in words a person can read. Playwright's wording is kept where it is the evidence. */
function why(c: Check, r: CheckResult): string {
  const st = r.failedStep !== null ? steps(c)[r.failedStep] : undefined;
  const at = st ? `${describeStep(st)}: ` : "";
  if (r.error.startsWith("covered: ")) return `${at}something is on top of ${r.error.slice(9)}, so a tap never reaches it.`;
  if (/intercepts pointer events/.test(r.error)) {
    const by = r.error.match(/<([a-z]+)[^>]*?(?:class="([^"]+)")?[^>]*>.*?intercepts pointer events/)?.slice(1).filter(Boolean).join(".") ?? "another element";
    return `${at}the button is covered by another element (${by}), so the tap never reaches it.`;
  }
  if (/Timeout .* exceeded/.test(r.error) && st?.do === "expectText") return `${at}it never appeared.`;
  if (st?.do === "expectNoText") return `${at}it was still there.`;
  if (r.error === "the page threw an error") return `the page threw an error: ${firstLine(r.consoleErrors.join("\n"))}`;
  return `${at}${firstLine(r.error)}`;
}

/** Lines of what was on screen that relate to what we expected to see. */
function sawText(c: Check, r: CheckResult): string {
  const st = r.failedStep !== null ? steps(c)[r.failedStep] : undefined;
  const words = st && "text" in st ? st.text.toLowerCase().split(/\W+/).filter((w) => w.length > 2) : [];
  const lines = r.observed.split("\n").map((l) => l.trim()).filter(Boolean);
  const hits = lines.filter((l) => words.some((w) => l.toLowerCase().includes(w)));
  return (hits.length ? hits : lines.slice(0, 4)).slice(0, 4).join(" / ").slice(0, 240);
}

/** A server error (5xx) or an uncaught JavaScript error: the code itself failed, not the check. */
const isCrash = (m: string) => /^5\d\d from /.test(m) || m.startsWith("page error");
const crashes = (r?: CheckResult) => !!r && r.consoleErrors.some(isCrash);

/** A check's failure is solid evidence when it failed on an expectation or on a covered button. */
const solid = (c: Check, r: CheckResult) => {
  if (r.ok) return false;
  const st = r.failedStep !== null ? steps(c)[r.failedStep] : undefined;
  return /intercepts pointer events/.test(r.error) || r.error.startsWith("covered: ") || st?.do === "expectText" || st?.do === "expectNoText" || r.error === "the page threw an error";
};

/** What the planner gets: the page as a user sees it in a browser, plus the start of its HTML for wording. */
async function describePage(id: string, url: string) {
  let html = "";
  try { html = await (await fetch(url, { signal: AbortSignal.timeout(10_000) })).text(); } catch { /* fine */ }
  return `${await snapshot(id, url, SHOTS)}\n\nHTML SOURCE (may be incomplete if the page renders with JavaScript):\n${html.slice(0, 10000)}`;
}

async function keepMachine(run: Run, m: Machine, why: string) {
  const checkpoint = await sprites.checkpoint(m.sprite, `Polygraph: ${why}`).catch(() => "");
  run.machine = { sprite: m.sprite, url: m.url, checkpoint, expiresAt: Date.now() + KEEP_HOURS * 3600_000 };
}

/**
 * Plan the core journeys and prove them on main before they judge any PR.
 * A journey that fails on main gets one self-repair from what the screen showed; if it still fails it is dropped.
 * Repairs only ever happen against main, never after seeing the PR, so a regression can't be explained away.
 */
async function baselineJourneys(id: string, mainUrl: string, page: string, say: (s: string) => void): Promise<Check[]> {
  let journeys = await planJourneys(page);
  const first = await runChecks(`${id}b`, { main: mainUrl }, journeys, SHOTS);
  const failed = journeys.filter((c) => !first.find((r) => r.id === c.id)?.ok);
  if (!failed.length) return journeys;
  say(`Repairing ${failed.length} journey check(s) that failed on main`);
  const repaired = await Promise.all(failed.map((c) => {
    const r = first.find((x) => x.id === c.id)!;
    const st = r.failedStep !== null ? steps(c)[r.failedStep] : undefined;
    return repairJourney(c, st ? describeStep(st) : "unknown step", r.error, r.observed, page);
  }));
  const retry = repaired.filter((c): c is Check => !!c);
  const second = retry.length ? await runChecks(`${id}b2`, { main: mainUrl }, retry, SHOTS) : [];
  journeys = journeys.map((c) => (failed.includes(c) ? retry.find((x) => x.id === c.id && second.find((r) => r.id === c.id)?.ok) : c)).filter((c): c is Check => !!c);
  say(`Kept ${journeys.length} journey check(s), all proven on main`);
  return journeys;
}

// ─────────────────────────────────────────── pull requests

export async function checkPR(repo: string, pr: gh.PR, save: (r: Run) => void): Promise<Run> {
  const id = randomBytes(4).toString("hex");
  const run: Run = { id, kind: "pr", repo, number: pr.number, title: pr.title, url: pr.html_url, sha: pr.head.sha, startedAt: Date.now(), verdict: "running", headline: "", tests: {}, findings: [], log: [] };
  const say = (s: string) => { run.log.push(s); save(run); };
  const page = `${PUBLIC}/runs/${id}`;
  await gh.setStatus(repo, pr.head.sha, "pending", "Testing this PR in a fresh machine…", page);
  say(`Checking PR #${pr.number} (${short(pr.head.sha)}) against ${pr.base.ref} (${short(pr.base.sha)})`);

  const names = { main: `pg-${sid(repo)}-${pr.number}-main`, pr: `pg-${sid(repo)}-${pr.number}-${short(pr.head.sha)}` };
  let keep = false;
  try {
    const [main, head] = await Promise.all([boot(repo, pr.base.sha, names.main), boot(repo, pr.head.sha, names.pr)]);
    run.tests = { main: main.tests, pr: head.tests };
    const tw = (t: Machine["tests"]) => (!t.ran ? "none" : t.summary || (t.passed ? "passed" : "failed"));
    say(`Machines ready. Unit tests: main ${tw(main.tests)}, PR ${tw(head.tests)}. App starts: main ${main.started ? "yes" : "no"}, PR ${head.started ? "yes" : "no"}`);
    if (!main.started && !head.started) {
      // Nothing to compare. Say so plainly; never call an untested PR safe.
      run.verdict = "inconclusive";
      run.headline = main.installed ? "Couldn't start the app on a fresh machine, so this PR is untested" : "Dependencies don't install on a fresh machine, so this PR is untested";
      say(run.headline);
      await gh.upsertComment(repo, pr.number, untestedComment(run, main));
      await gh.setStatus(repo, pr.head.sha, "error", run.headline, page);
      await notify(`⚠️ PR #${pr.number}: couldn't test`, run.headline, { url: page });
      return run;
    }

    const problems: string[] = [];
    if (!head.installed) problems.push("the PR's dependencies don't install");
    if (head.tests.ran && !head.tests.passed && main.tests.passed) problems.push("unit tests that pass on main fail on this PR");
    if (!head.started && main.started) problems.push("the app doesn't start with this PR");

    if (head.started && main.started) {
      const diff = await gh.prDiff(repo, pr.number);
      const html = await describePage(id, main.url);
      // Core journeys are planned once per main commit and reused, so every PR is held to the same bar.
      const jkey = `${repo}@${pr.base.sha}`;
      const [journeys, checks] = await Promise.all([JOURNEYS.get(jkey) ?? baselineJourneys(id, main.url, html, say), planForPR(pr, diff, html)]);
      JOURNEYS.set(jkey, journeys);
      const smoke: Check[] = [
        { id: "s1", name: "Everything on the home page can be tapped", viewport: "mobile", steps: [{ do: "goto", path: "/" }, { do: "tapTargets" }] },
        { id: "s2", name: "Everything on the home page can be clicked", viewport: "desktop", steps: [{ do: "goto", path: "/" }, { do: "tapTargets" }] },
      ];
      const all = [...smoke, ...journeys, ...checks.map((c, i) => ({ ...c, id: `p${i + 1}` }))];
      say(`Core journeys (phone + desktop): ${[...new Set(journeys.map((c) => c.name))].join("; ") || "none"}`);
      say(`Checks for this PR: ${checks.map((c) => c.name).join("; ") || "none"}`);
      let results = await runChecks(id, { main: main.url, pr: head.url }, all, SHOTS);
      const get = (rs: CheckResult[], t: string, c: Check) => rs.find((r) => r.target === t && r.id === c.id);

      // A difference only counts if it happens twice: re-run anything that looks like a regression.
      const suspects = all.filter((c) => get(results, "main", c)?.ok && !get(results, "pr", c)?.ok);
      if (suspects.length) {
        say(`Re-running ${suspects.length} check(s) to rule out flakiness`);
        const again = await runChecks(`${id}r`, { main: main.url, pr: head.url }, suspects, SHOTS);
        results = results.map((r) => get(again, r.target, all.find((c) => c.id === r.id)!) ?? r);
      }
      for (const c of all) {
        const m = get(results, "main", c), p = get(results, "pr", c);
        const kind: Finding["kind"] =
          m?.ok && p?.ok ? "ok" : m?.ok && !p?.ok ? "regression" : !m?.ok && p?.ok ? (c.id.startsWith("p") ? "new" : "fixed")
          : crashes(p) && !crashes(m) ? "broken" : "preexisting";
        run.findings.push({ check: c, main: m, pr: p, kind });
      }
      for (const f of run.findings.filter((f) => f.kind === "regression")) problems.push(`${f.check.name} (${view(f.check)}): ${why(f.check, f.pr!)}`);
      // A crash is evidence no matter what the check expected: the PR's own code errors where main's doesn't.
      for (const f of run.findings.filter((f) => f.kind === "broken")) problems.push(`${f.check.name} (${view(f.check)}): the PR's code crashes: ${firstLine(f.pr!.consoleErrors.filter(isCrash).join("; "))}`);
    }

    run.verdict = problems.length ? "fail" : "pass";
    const fallback = problems.length ? `${problems[0].split(":")[0].replace(/ \((phone|desktop)\)$/, "")} no longer works with this PR` : "Safe to merge";
    run.headline = problems.length ? await headline(`PR: ${pr.title}\nProblems found (main branch is fine, this PR is not):\n- ${problems.join("\n- ")}`, fallback) : "Safe to merge";
    if (run.verdict === "fail" && head.started) { await keepMachine(run, head, `failure state of PR #${pr.number}`); keep = true; }
    say(run.verdict === "pass" ? "Verdict: safe to merge" : `Verdict: not ready (${problems.length} problem${problems.length > 1 ? "s" : ""})`);

    await gh.upsertComment(repo, pr.number, prComment(run, problems));
    await gh.setStatus(repo, pr.head.sha, run.verdict === "pass" ? "success" : "failure", run.verdict === "pass" ? "Safe to merge: tests and browser checks pass" : run.headline, page);
    await notify(run.verdict === "pass" ? `✅ PR #${pr.number} is safe to merge` : `❌ PR #${pr.number} is not ready`, run.verdict === "pass" ? pr.title : run.headline, { url: page, tags: [run.verdict === "pass" ? "white_check_mark" : "x"] });
  } catch (e) {
    run.verdict = "error";
    run.headline = `Polygraph hit a problem: ${firstLine(String((e as Error).message ?? e))}`;
    say(run.headline);
    await gh.setStatus(repo, pr.head.sha, "error", "Polygraph could not finish this check", page).catch(() => {});
  } finally {
    run.finishedAt = Date.now();
    save(run);
    await destroy(names.main);
    if (!keep) await destroy(names.pr);
  }
  return run;
}

function untestedComment(run: Run, m: Machine): string {
  return [
    `### ⚠️ Polygraph couldn't test this PR`,
    ``,
    `**${run.headline}.** It doesn't start on \`main\` either, so this isn't caused by the PR. Polygraph needs the app to start with \`npm start\` (or \`node server.js\`) on a fresh Linux machine.`,
    ``,
    `<details><summary>What the app printed</summary>`,
    ``,
    "```",
    (m.appLog || m.log.join("\n")).slice(-2500),
    "```",
    ``,
    `</details>`,
    ``,
    `<sub>Tested ${short(run.sha)} in throwaway [Fly.io Sprites](https://sprites.dev). [Full report](${PUBLIC}/runs/${run.id})</sub>`,
  ].join("\n");
}

function prComment(run: Run, problems: string[]): string {
  const icon = (r?: CheckResult, f?: Finding) => (!r ? "–" : f?.kind === "new" && r.target === "main" ? "➖" : r.ok ? "✅" : "❌");
  const t = run.tests;
  const testCell = (x?: Machine["tests"]) => (!x?.ran ? "–" : `${x.passed ? "✅" : "❌"} ${x.summary || (x.passed ? "passed" : "failed")}`);
  const rows = [`| | main | this PR |`, `|---|---|---|`, `| Unit tests | ${testCell(t.main)} | ${testCell(t.pr)} |`];
  for (const f of run.findings) rows.push(`| ${f.check.name} (${view(f.check)}) | ${icon(f.main, f)} | ${icon(f.pr, f)} |`);
  const out: string[] = [];
  if (run.verdict === "pass") {
    out.push(`### ✅ Polygraph: safe to merge`, ``, `Unit tests pass, and I clicked through the parts of the app this PR touches on a phone and on desktop. Everything behaves the same as \`main\`.`, ``, ...rows);
  } else {
    out.push(`### ❌ Polygraph: not ready to merge`, ``, `**${run.headline}**`, ``);
    for (const p of problems) out.push(`- ${p}`);
    const reg = run.findings.find((f) => f.kind === "regression") ?? run.findings.find((f) => f.kind === "broken");
    if (reg) {
      out.push(``, `| main | this PR |`, `|---|---|`, `| <img src="${shotUrl(reg.main?.shot)}" width="260" alt="main"> | <img src="${shotUrl(reg.pr?.shot)}" width="260" alt="this PR"> |`);
      out.push(``, `<details><summary>Steps I took (${view(reg.check)})</summary>`, ``, ...steps(reg.check).map((s, i) => `${i + 1}. ${describeStep(s)}`), ``, `</details>`);
    }
    out.push(``, ...rows);
    if (run.machine) out.push(``, `▶ **[Open the machine where it failed](${PUBLIC}/runs/${run.id})**: the PR is still running there, frozen at the failure (snapshot \`${run.machine.checkpoint || "saved"}\`). Kept for ${KEPT}.`);
  }
  const fresh = run.findings.filter((f) => f.kind === "new");
  if (fresh.length) out.push(``, `<sub>Works with this PR (it didn't on main): ${fresh.map((f) => `${f.check.name} (${view(f.check)})`).join("; ")}.</sub>`);
  const fixed = run.findings.filter((f) => f.kind === "fixed");
  if (fixed.length) out.push(``, `<sub>Fixed by this PR: ${fixed.map((f) => `${f.check.name} (${view(f.check)})`).join("; ")}.</sub>`);
  const unsure = run.findings.filter((f) => f.kind === "preexisting");
  if (unsure.length) out.push(``, `<sub>Couldn't verify (failed on main and on this PR, so it doesn't count against the PR; my check may be wrong): ${unsure.map((f) => `${f.check.name}: ${why(f.check, f.pr ?? f.main!)}`).join("; ")}.</sub>`);
  out.push(``, `<sub>Tested ${short(run.sha)} in throwaway [Fly.io Sprites](https://sprites.dev). The PR's code ran on a machine with no keys. [Full report](${PUBLIC}/runs/${run.id})</sub>`);
  return out.join("\n");
}

// ─────────────────────────────────────────── bug reports

export async function reproduceIssue(repo: string, issue: gh.Issue, save: (r: Run) => void): Promise<Run> {
  const id = randomBytes(4).toString("hex");
  const branch = await gh.defaultBranch(repo);
  const sha = await gh.branchSha(repo, branch);
  const run: Run = { id, kind: "issue", repo, number: issue.number, title: issue.title, url: issue.html_url, sha, startedAt: Date.now(), verdict: "running", headline: "", tests: {}, findings: [], log: [] };
  const say = (s: string) => { run.log.push(s); save(run); };
  say(`Reproducing issue #${issue.number} on ${branch} (${short(sha)})`);
  const name = `pg-${sid(repo)}-bug${issue.number}`;
  let keep = false;
  try {
    const m = await boot(repo, sha, name);
    run.tests = { main: m.tests };
    if (!m.started) throw new Error("the app did not start on a fresh machine");
    const plan = await planForIssue(issue, await describePage(id, m.url));
    run.expected = plan.expected;
    if (!plan.checks.length) throw new Error("couldn't turn the report into steps");
    say(`Following the reporter's steps: ${plan.checks.map((c) => c.name).join("; ")}`);

    const first = await runChecks(id, { main: m.url }, plan.checks, SHOTS);
    const second = await runChecks(`${id}r`, { main: m.url }, plan.checks, SHOTS);
    for (const c of plan.checks) {
      const a = first.find((r) => r.id === c.id)!, b = second.find((r) => r.id === c.id)!;
      const kind: Finding["kind"] = !a.ok && !b.ok && solid(c, a) && solid(c, b) ? "reproduced" : a.ok && b.ok ? "not-reproduced" : "unclear";
      run.findings.push({ check: c, main: a, kind });
    }
    const hit = run.findings.find((f) => f.kind === "reproduced");
    run.verdict = hit ? "reproduced" : run.findings.every((f) => f.kind === "not-reproduced") ? "not-reproduced" : "inconclusive";

    if (hit) {
      run.headline = await headline(`Bug report: ${issue.title}\nExpected: ${plan.expected}\nWhat happened: ${why(hit.check, hit.main!)}\nOn screen: ${sawText(hit.check, hit.main!)}`, issue.title);
      await keepMachine(run, m, `issue #${issue.number} reproduced`);
      keep = true;
      await gh.addLabel(repo, issue.number, "reproduced").catch(() => {});
    }
    say(`Verdict: ${run.verdict}`);
    await gh.upsertComment(repo, issue.number, issueComment(run));
    const title = run.verdict === "reproduced" ? `🔁 Bug #${issue.number} reproduced` : `🤔 Bug #${issue.number}: couldn't reproduce`;
    await notify(title, run.headline || issue.title, { url: `${PUBLIC}/runs/${id}` });
  } catch (e) {
    run.verdict = "error";
    run.headline = `Polygraph hit a problem: ${firstLine(String((e as Error).message ?? e))}`;
    say(run.headline);
  } finally {
    run.finishedAt = Date.now();
    save(run);
    if (!keep) await destroy(name);
  }
  return run;
}

function issueComment(run: Run): string {
  const out: string[] = [];
  const f = run.findings.find((x) => x.kind === "reproduced") ?? run.findings[0];
  const stepList = f ? steps(f.check).map((s, i) => `${i + 1}. ${describeStep(s)}`) : [];
  if (run.verdict === "reproduced" && f?.main) {
    out.push(`### 🔁 Polygraph reproduced this bug`, ``, `**${run.headline}**`, ``);
    out.push(`On a fresh machine running \`${short(run.sha)}\` (${view(f.check)}), I did this twice and got the same result both times:`, ``, ...stepList, ``);
    out.push(`- **Expected:** ${run.expected || describeStep(steps(f.check)[f.main.failedStep ?? 0])}`, `- **Actually:** ${why(f.check, f.main)}`, `- **On screen:** ${sawText(f.check, f.main)}`, ``);
    out.push(`<img src="${shotUrl(f.main.shot)}" width="320" alt="What the page showed">`, ``);
    if (run.machine) out.push(`▶ **[Open the machine where it happens](${PUBLIC}/runs/${run.id})**: the bug is live there right now (snapshot \`${run.machine.checkpoint || "saved"}\`). Kept for ${KEPT}.`);
  } else if (run.verdict === "not-reproduced") {
    out.push(`### 🤔 Polygraph couldn't reproduce this yet`, ``, `On a fresh machine running \`${short(run.sha)}\`, I tried:`, ``, ...stepList, ``, `Everything worked as expected. Could you add the exact steps, or the device and browser you used? I'll try again as soon as this issue is edited.`);
  } else {
    out.push(`### 🤔 Polygraph isn't sure yet`, ``, `I followed the steps below, but the result wasn't consistent or I couldn't find something on the page:`, ``, ...stepList, ``, `More detail in the report would help me reproduce it.`);
  }
  out.push(``, `<sub>Tested in a throwaway [Fly.io Sprite](https://sprites.dev) with no keys. [Full report](${PUBLIC}/runs/${run.id})</sub>`);
  return out.join("\n");
}
