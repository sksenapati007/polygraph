// Re-run the known cases several times and record whether each verdict is stable.
// Usage: node tools/stability.ts [rounds]   (stop the polygraph service first: this writes the same state file)
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { checkPR, reproduceIssue, JOURNEYS, type Run } from "../agent/jobs.ts";
import * as gh from "../agent/github.ts";

const DATA = `${process.env.HOME}/polygraph/data`;
const STATE = `${DATA}/state.json`;
const OUT = `${DATA}/stability.jsonl`;
const rounds = Number(process.argv[2] ?? 3);
const cases: [string, "pr" | "issue", number, string][] = [
  ["sksenapati007/polygraph-demo-shop", "pr", 2, "fail"],
  ["sksenapati007/polygraph-demo-shop", "pr", 3, "pass"],
  ["sksenapati007/polygraph-demo-shop", "issue", 1, "reproduced"],
  ["sksenapati007/node-js-getting-started", "pr", 1, "fail"],
  ["sksenapati007/chat-example", "pr", 1, "fail"],
  ["sksenapati007/chat-example", "pr", 2, "pass"],
];

/** Keep the agent's state file in step, so the agent page shows the latest run of each case. */
function save(run: Run) {
  const s = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { repos: [], seen: {}, runs: [] };
  s.runs = s.runs.filter((r: Run) => r.id === run.id || !(r.repo === run.repo && r.number === run.number && r.kind === run.kind));
  const i = s.runs.findIndex((r: Run) => r.id === run.id);
  if (i >= 0) s.runs[i] = run; else s.runs.unshift(run);
  writeFileSync(STATE, JSON.stringify(s, null, 1));
}

for (let round = 1; round <= rounds; round++) {
  JOURNEYS.clear(); // force a fresh plan every round: the harder test
  for (const [repo, kind, n, want] of cases) {
    const t0 = Date.now();
    let run: Run;
    try {
      run = kind === "pr" ? await checkPR(repo, await gh.gh("GET", `/repos/${repo}/pulls/${n}`), save) : await reproduceIssue(repo, await gh.gh("GET", `/repos/${repo}/issues/${n}`), save);
    } catch (e) {
      appendFileSync(OUT, JSON.stringify({ round, repo, kind, n, want, got: "crash", headline: String(e).slice(0, 200), secs: 0 }) + "\n");
      continue;
    }
    const kinds = run.findings.map((f) => `${f.kind}:${f.check.viewport[0]}:${f.check.name}`);
    appendFileSync(OUT, JSON.stringify({ round, repo, kind, n, want, got: run.verdict, ok: run.verdict === want, headline: run.headline, secs: Math.round((Date.now() - t0) / 1000), kinds }) + "\n");
  }
}
appendFileSync(OUT, JSON.stringify({ done: true }) + "\n");
