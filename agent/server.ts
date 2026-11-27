// Polygraph: watches your repos, checks every pull request and reproduces every bug report
// in throwaway Sprites, then tells you in plain English what it found.
import http from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream } from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { attachShell, shellPage } from "./shell.ts";
import { page, esc } from "../core/html.ts";
import * as gh from "./github.ts";
import { destroy } from "./machine.ts";
import { checkPR, reproduceIssue, PUBLIC, SHOTS, type Run } from "./jobs.ts";

const DATA = process.env.PG_DATA ?? "/home/sprite/polygraph/data";
const PIN = process.env.PG_PIN ?? "";
const POLL_MS = Number(process.env.PG_POLL_MS ?? 20_000);
const PORT = Number(process.env.PORT ?? 8080);
const SECRET = process.env.PG_COOKIE_SECRET ?? randomBytes(32).toString("hex");
const authCookie = createHmac("sha256", SECRET).update("shell").digest("hex");
function authorized(req: http.IncomingMessage) {
  const got = /(?:^|;\s*)pg_auth=([a-f0-9]{64})/.exec(req.headers.cookie ?? "")?.[1];
  return !!got && timingSafeEqual(Buffer.from(got), Buffer.from(authCookie));
}
/** The kept machine for a run, if it still exists. */
const machineFor = (id: string) => { const r = state.runs.find((x) => x.id === id); return r?.machine && r.machine.expiresAt > Date.now() ? r.machine.sprite : null; };
mkdirSync(SHOTS, { recursive: true });

interface State { repos: string[]; seen: Record<string, string>; runs: Run[] }
const FILE = `${DATA}/state.json`;
const state: State = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : { repos: (process.env.PG_REPOS ?? "").split(",").filter(Boolean), seen: {}, runs: [] };
const persist = () => writeFileSync(FILE, JSON.stringify(state, null, 1));
function save(run: Run) {
  const i = state.runs.findIndex((r) => r.id === run.id);
  if (i >= 0) state.runs[i] = run; else state.runs.unshift(run);
  state.runs = state.runs.slice(0, 100);
  persist();
}

// ─────────────────────────────────────────── the loop

let busy = false;
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);

async function tick() {
  if (busy) return;
  busy = true;
  try {
    for (const repo of state.repos) {
      for (const pr of await gh.openPRs(repo)) {
        const key = `pr:${repo}#${pr.number}@${pr.head.sha}`;
        if (state.seen[key]) continue;
        state.seen[key] = "running"; persist();
        state.seen[key] = (await checkPR(repo, pr, save)).id; persist();
      }
      for (const issue of await gh.openBugs(repo)) {
        // Re-run when the report itself changes (not when someone comments).
        const key = `bug:${repo}#${issue.number}@${hash(issue.title + (issue.body ?? ""))}`;
        if (state.seen[key] || issue.labels.some((l) => l.name === "reproduced")) continue;
        state.seen[key] = "running"; persist();
        state.seen[key] = (await reproduceIssue(repo, issue, save)).id; persist();
      }
    }
    // Machines kept for debugging are deleted once they expire (PG_KEEP_HOURS, default 24).
    for (const r of state.runs) if (r.machine && r.machine.expiresAt < Date.now()) { await destroy(r.machine.sprite); r.machine = undefined; persist(); }
  } catch (e) {
    console.error("poll:", (e as Error).message);
  } finally {
    busy = false;
  }
}
setInterval(tick, POLL_MS);
setTimeout(tick, 2000);

// ─────────────────────────────────────────── pages

const LABEL: Record<Run["verdict"], [string, string, string]> = {
  running: ["Testing…", "warn", "…"], pass: ["Safe to merge", "ok", "✓"], fail: ["Not ready", "bad", "✕"],
  reproduced: ["Bug reproduced", "bad", "↻"], "not-reproduced": ["Couldn't reproduce", "warn", "?"], inconclusive: ["Couldn't test", "warn", "!"], error: ["Error", "warn", "!"],
};
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const badge = (v: Run["verdict"]) => { const [t, c, i] = LABEL[v]; return `<span class="badge ${c}"><span aria-hidden="true">${i}</span> ${t}</span>`; };
const view = (c: { viewport: string }) => (c.viewport === "mobile" ? "phone" : "desktop");

const CSS = `<style>
main{max-width:64rem}
.hero{padding:calc(var(--s)*1.5) 0 calc(var(--s)*2)}
.eyebrow{margin:0 0 .5rem;font-size:.875rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent)}
.hero h1{font-size:clamp(1.875rem,4vw,2.75rem);line-height:1.15;margin:0 0 .75rem;max-width:22ch}
.hero .lead{font-size:1.125rem;max-width:60ch}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;margin:calc(var(--s)*1.25) 0}
a.button,button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:.5rem 1.125rem;border-radius:8px;font-weight:600;text-decoration:none;background:var(--accent);color:var(--accent-fg);border:1px solid var(--accent)}
a.button.secondary{background:transparent;color:var(--fg);border-color:var(--line)}
ul.stats{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:var(--s)}
ul.stats li{color:var(--muted)}ul.stats strong{display:block;font-size:1.5rem;color:var(--fg)}
h2{font-size:1.25rem;margin:0 0 .75rem}
ol.steps{list-style:none;counter-reset:s;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:var(--s)}
ol.steps li{counter-increment:s;border:1px solid var(--line);border-radius:var(--r);padding:var(--s);background:var(--bg)}
ol.steps li::before{content:counter(s);display:inline-grid;place-items:center;width:1.75rem;height:1.75rem;border-radius:50%;background:var(--accent);color:var(--accent-fg);font-weight:700;margin-bottom:.5rem}
ol.steps strong{display:block;margin-bottom:.25rem}
.badge{display:inline-flex;gap:.25rem;align-items:center;white-space:nowrap;font-weight:700;font-size:.875rem;padding:.125rem .625rem;border-radius:999px}
.badge.ok{background:var(--ok-bg);color:var(--ok-ink)}.badge.bad{background:var(--bad-bg);color:var(--bad-ink)}.badge.warn{background:var(--warn-bg);color:var(--warn-ink)}
ul.runs{list-style:none;padding:0;margin:0}
ul.runs li{display:grid;grid-template-columns:auto 1fr;gap:.25rem .75rem;align-items:baseline;padding:.75rem 0;border-top:1px solid var(--line)}
ul.runs li:first-child{border-top:0}ul.runs .meta{grid-column:2;color:var(--muted);font-size:.875rem}
@media (max-width:30rem){ul.runs li{grid-template-columns:1fr}ul.runs .meta{grid-column:1}}
ul.safe{margin:0;padding-left:1.25rem;display:grid;gap:.5rem}
.row{display:flex;gap:.75rem;flex-wrap:wrap;align-items:end}.row>div{flex:1 1 14rem}.row button{margin-top:0}
.verdict{color:var(--fg);border-radius:var(--r);padding:calc(var(--s)*1.25);margin-bottom:var(--s);border:1px solid var(--line);border-left-width:6px}
.verdict.ok{border-left-color:var(--ok)}.verdict.bad{border-left-color:var(--bad)}.verdict.warn{border-left-color:var(--warn)}
.verdict h1{font-size:clamp(1.375rem,3vw,1.875rem);line-height:1.25;margin:.5rem 0}
.verdict p{margin:0;color:var(--muted)}
.evidence{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:var(--s);margin-top:.75rem}
figure{margin:0}figure img{width:100%;height:auto;border:1px solid var(--line);border-radius:8px;background:#fff}
figcaption{font-size:.875rem;color:var(--muted);margin-top:.25rem}
.why{margin:.25rem 0 0}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.5rem;border-top:1px solid var(--line);vertical-align:top}
thead th{border-top:0;font-size:.875rem;color:var(--muted)}
.table-wrap{overflow-x:auto}
details summary{cursor:pointer;font-weight:600;min-height:44px;display:flex;align-items:center}
footer{color:var(--muted);font-size:.875rem;padding:var(--s) 0}
</style>`;

function home(): string {
  const latestFail = state.runs.find((r) => r.kind === "pr" && r.verdict === "fail");
  const runs = state.runs.slice(0, 15).map((r) => `<li>${badge(r.verdict)}<a href="/runs/${r.id}">${r.kind === "pr" ? "PR" : "Bug"} #${r.number}: ${esc(r.title)}</a><span class="meta">${esc(r.repo)} · ${ago(r.startedAt)}</span></li>`).join("")
    || `<li class="muted">Nothing yet. Open a pull request or file an issue labelled <code>bug</code> in a connected repo.</li>`;
  return page("Polygraph: catches works-on-my-machine", `${CSS}
<header class="hero">
<p class="eyebrow">AI tester on Fly.io Sprites</p>
<h1>Polygraph catches “works on my machine”.</h1>
<p class="lead">Every pull request and every bug report is tested in a fresh, throwaway computer. You get one plain-English answer, and the machine where it failed.</p>
<div class="actions">${latestFail ? `<a class="button" href="/runs/${latestFail.id}">See it catch a bug</a>` : ""}<a class="button secondary" href="#connect">Connect a repo</a></div>
<ul class="stats" aria-label="Measured results">
<li><strong>18 of 18</strong> verdicts the same across 3 re-runs</li>
<li><strong>1–3 min</strong> per pull request, ~35 s per bug report</li>
<li><strong>0 keys</strong> on the machines that run your code</li>
</ul>
</header>
<section aria-labelledby="how"><h2 id="how">How it works</h2><ol class="steps">
<li><strong>Open a pull request</strong>Polygraph boots <code>main</code> and your PR side by side in two fresh Sprites, runs your tests, then uses the app in a real browser on a phone and on desktop.</li>
<li><strong>File a bug</strong>Label an issue <code>bug</code>. Polygraph follows the reporter's steps on a fresh machine, twice, to prove it's real, or asks for what's missing.</li>
<li><strong>Get one answer</strong>“Safe to merge” or “not ready”, with screenshots, on the PR and on your phone. Failed machines stay up so you can open the app or a shell.</li>
</ol></section>
<section aria-labelledby="recent"><h2 id="recent">Recent verdicts</h2><ul class="runs">${runs}</ul></section>
<section aria-labelledby="safe"><h2 id="safe">Why it's safe to point at your repo</h2><ul class="safe">
<li><strong>The model plans, rules decide.</strong> A check only counts against a PR if it passes on <code>main</code> and fails on the PR, twice. A badly written check can't turn a PR red.</li>
<li><strong>Untrusted code runs on keyless machines.</strong> PR code runs on throwaway Sprites that hold no tokens and can't reach your GitHub.</li>
<li><strong>No token on any Sprite.</strong> GitHub and the AI are reached through Fly.io Sprites connectors, which add the credentials on the way out.</li>
</ul></section>
<section aria-labelledby="connect"><h2 id="connect">Connect a repository</h2>
<form method="post" action="/connect" class="row"><div><label for="repo">GitHub repository</label><input id="repo" name="repo" placeholder="owner/name" required pattern="[\\w.-]+/[\\w.-]+" autocomplete="off"></div>
<div><label for="pin">PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required></div><div><button type="submit">Connect</button></div></form>
<p class="muted">Watching: ${state.repos.map((r) => `<a href="https://github.com/${esc(r)}">${esc(r)}</a>`).join(", ") || "nothing yet"}</p></section>
<footer>Powered by <a href="https://sprites.dev">Sprites.dev</a> (<a href="https://fly.io">Fly.io</a>) · <a href="https://github.com/sksenapati007/polygraph">Source on GitHub</a></footer>`);
}

function runPage(r: Run): string {
  const [label, tone] = LABEL[r.verdict];
  const took = r.finishedAt ? ` · took ${Math.round((r.finishedAt - r.startedAt) / 1000)} s` : "";
  const key = r.findings.filter((f) => f.kind === "regression" || f.kind === "broken" || f.kind === "reproduced").slice(0, 2);
  const shot = (s: string | undefined, cap: string) => (s ? `<figure><img src="/shots/${esc(s)}" alt="${esc(cap)}" loading="lazy"><figcaption>${esc(cap)}</figcaption></figure>` : "");
  const evidence = key.map((f) => `<h3>${esc(f.check.name)} <span class="muted">(${view(f.check)})</span></h3>
<p class="why">${f.pr && !f.pr.ok ? esc(f.pr.error.split("\n")[0].replace(/^covered: /, "Covered: ")) : f.main && !f.main.ok ? esc(f.main.error.split("\n")[0]) : ""}</p>
<div class="evidence">${r.kind === "pr" ? shot(f.main?.shot, "main: works") + shot(f.pr?.shot, "this PR: fails") : shot(f.main?.shot, "What the page showed")}</div>`).join("");
  const testRow = (k: "main" | "pr") => { const t = r.tests[k]; return t?.ran ? `<tr><th scope="row">Unit tests on ${k === "pr" ? "this PR" : r.kind === "pr" ? "main" : "the default branch"}</th><td colspan="${r.kind === "pr" ? 3 : 2}"><span class="${t.passed ? "ok" : "bad"}">${t.passed ? "✓ Passed" : "✕ Failed"}</span> ${esc(t.summary)}</td></tr>` : ""; };
  const cell = (x?: { ok: boolean }) => (!x ? "–" : x.ok ? `<span class="ok">✓ Pass</span>` : `<span class="bad">✕ Fail</span>`);
  const meaning: Record<string, string> = { ok: "Same as main", regression: "Broken by this PR", broken: "PR's code crashes", new: "New, works", fixed: "Fixed by this PR", preexisting: "Couldn't verify", reproduced: "Bug confirmed", "not-reproduced": "Works", unclear: "Unclear" };
  const rows = r.findings.map((f) => `<tr><th scope="row">${esc(f.check.name)} <span class="muted">(${view(f.check)})</span></th><td>${cell(f.main)}</td>${r.kind === "pr" ? `<td>${cell(f.pr)}</td>` : ""}<td>${meaning[f.kind] ?? f.kind}</td></tr>`).join("");
  const machine = r.machine
    ? `<section aria-labelledby="m"><h2 id="m">The machine where it ${r.kind === "pr" ? "failed" : "happens"}</h2>
<p>Still running, exactly as Polygraph left it. Snapshot <code>${esc(r.machine.checkpoint || "saved")}</code> can bring it back to this moment. It is deleted in about ${((h) => (h >= 48 ? `${Math.round(h / 24)} days` : `${h} hours`))(Math.max(1, Math.round((r.machine.expiresAt - Date.now()) / 3600_000)))}.</p>
<div class="actions"><a class="button" href="${esc(r.machine.url)}" target="_blank" rel="noopener">Open the broken app<span class="sr-only"> (opens in a new tab)</span></a><a class="button secondary" href="/runs/${r.id}/shell">Open a shell (PIN)</a></div></section>` : "";
  return page(`${label}: ${r.title}`, `${CSS}<style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}</style>
<p><a href="/">← Polygraph</a></p>
<header class="verdict ${tone}">${badge(r.verdict)}
<h1>${esc(r.headline || (r.verdict === "running" ? "Testing in fresh machines…" : r.title))}</h1>
<p>${r.kind === "pr" ? "PR" : "Bug"} #${r.number}: <a href="${esc(r.url)}">${esc(r.title)}</a> · ${esc(r.repo)} · <code>${esc(r.sha.slice(0, 7))}</code> · ${ago(r.startedAt)}${took}</p>
${r.expected ? `<p><strong>Expected:</strong> ${esc(r.expected)}</p>` : ""}</header>
${machine}
${evidence ? `<section aria-labelledby="ev"><h2 id="ev">Evidence</h2>${evidence}</section>` : ""}
<section aria-labelledby="checks"><h2 id="checks">Everything Polygraph checked</h2><div class="table-wrap"><table>
<thead><tr><th scope="col">Check</th><th scope="col">${r.kind === "pr" ? "main" : "Result"}</th>${r.kind === "pr" ? `<th scope="col">This PR</th>` : ""}<th scope="col">Meaning</th></tr></thead>
<tbody>${testRow("main")}${testRow("pr")}${rows}</tbody></table></div></section>
<section><details><summary>Log</summary><pre>${esc(r.log.join("\n"))}</pre></details></section>
${r.verdict === "running" ? `<script>setTimeout(()=>location.reload(),5000)</script>` : ""}`);
}

function form(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(new URLSearchParams(b))); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: string, type = "text/html; charset=utf-8") => { res.writeHead(code, { "content-type": type }); res.end(body); };
  try {
    if (req.method === "GET" && url.pathname === "/") return send(200, home());
    const sh = /^\/runs\/(\w+)\/shell$/.exec(url.pathname);
    if (sh) {
      const r = state.runs.find((x) => x.id === sh[1]);
      if (!r || !machineFor(r.id)) return send(404, page("Gone", `<h1>That machine is gone</h1><p>Kept machines are deleted after a while. <a href="/">Back</a></p>`));
      if (req.method === "POST") {
        const f = await form(req);
        if (!PIN || f.get("pin") !== PIN) return send(403, page("Wrong PIN", `<h1>Wrong PIN</h1><p><a href="/runs/${r.id}/shell">Try again</a></p>`));
        res.writeHead(303, { location: `/runs/${r.id}/shell`, "set-cookie": `pg_auth=${authCookie}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400` });
        return res.end();
      }
      if (!authorized(req)) return send(200, page("Open a shell", `${CSS}<p><a href="/runs/${r.id}">← Back to the report</a></p><h1>Open a shell on the machine</h1>
<p>This is the machine where ${r.kind === "pr" ? `PR #${r.number} failed` : `bug #${r.number} happens`}. The app is still running on it. Shells are for the repo owner.</p>
<form method="post" class="row"><div><label for="pin">PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" required autofocus></div><div><button type="submit">Open shell</button></div></form>`));
      return send(200, shellPage(`Shell: ${esc(r.machine!.sprite)}`, `/runs/${r.id}`));
    }
    if (req.method === "GET" && url.pathname.startsWith("/runs/")) {
      const r = state.runs.find((x) => x.id === url.pathname.slice(6));
      return r ? send(200, runPage(r)) : send(404, page("Not found", "<h1>Not found</h1>"));
    }
    if (req.method === "GET" && /^\/shots\/[\w.-]+\.png$/.test(url.pathname)) {
      const f = `${SHOTS}/${url.pathname.slice(7)}`;
      if (!existsSync(f)) return send(404, "not found", "text/plain");
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return createReadStream(f).pipe(res);
    }
    if (req.method === "GET" && url.pathname === "/api/runs") return send(200, JSON.stringify(state.runs), "application/json");
    if (req.method === "POST" && url.pathname === "/connect") {
      const f = await form(req);
      const repo = (f.get("repo") ?? "").trim();
      if (!PIN || f.get("pin") !== PIN) return send(403, page("Wrong PIN", `<h1>Wrong PIN</h1><p><a href="/">Back</a></p>`));
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return send(400, page("Bad repo", `<h1>Use owner/name</h1><p><a href="/">Back</a></p>`));
      await gh.gh("GET", `/repos/${repo}`); // fails if the GitHub connector can't see it
      if (!state.repos.includes(repo)) state.repos.push(repo);
      persist();
      res.writeHead(303, { location: "/" });
      return res.end();
    }
    send(404, page("Not found", "<h1>Not found</h1>"));
  } catch (e) {
    send(500, page("Error", `<h1>Something went wrong</h1><pre>${esc((e as Error).message)}</pre><p><a href="/">Back</a></p>`));
  }
});
attachShell(server, { authorized, machineFor });
server.listen(PORT, () => console.log(`polygraph on :${PORT}, public URL ${PUBLIC}, watching ${state.repos.join(", ") || "nothing"}`));
