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

const LABEL: Record<Run["verdict"], [string, string]> = {
  running: ["Testing…", "warn"], pass: ["Safe to merge", "ok"], fail: ["Not ready", "bad"],
  reproduced: ["Bug reproduced", "bad"], "not-reproduced": ["Couldn't reproduce", "warn"], inconclusive: ["Couldn't test", "warn"], error: ["Error", "warn"],
};
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

const CSS = `<style>
.hero h1{font-size:2rem}.badge{display:inline-block;font-weight:700;font-size:.875rem;padding:.125rem .5rem;border-radius:999px;border:1px solid currentColor}
ol.how{display:grid;gap:.75rem;padding-left:1.25rem}ul.runs{list-style:none;padding:0;margin:0;display:grid;gap:.5rem}
ul.runs li{display:flex;gap:.75rem;align-items:baseline;flex-wrap:wrap;border-top:1px solid var(--line);padding-top:.5rem}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:var(--s)}.shots figure{margin:0}
.shots img{width:100%;border:1px solid var(--line);border-radius:8px}figcaption{font-size:.875rem;color:var(--muted)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.375rem .5rem;border-top:1px solid var(--line);vertical-align:top}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:end}.row>div{flex:1 1 14rem}
a.button{display:inline-block;font-weight:600;padding:.625rem 1rem;border-radius:8px;background:var(--accent);color:#fff;text-decoration:none}
</style>`;

function home(): string {
  const runs = state.runs.slice(0, 15).map((r) => {
    const [t, c] = LABEL[r.verdict];
    return `<li><span class="badge ${c}">${t}</span><a href="/runs/${r.id}">${r.kind === "pr" ? "PR" : "Bug"} #${r.number}: ${esc(r.title)}</a><span class="muted">${esc(r.repo)} · ${ago(r.startedAt)}</span></li>`;
  }).join("") || `<li class="muted">Nothing yet. Open a pull request or file an issue labelled <code>bug</code> in a connected repo.</li>`;
  return page("Polygraph", `${CSS}
<header class="hero"><h1>Polygraph</h1><p class="lead">Catches "works on my machine". Every pull request and every bug report gets tested in a fresh, throwaway computer, and you get a plain-English answer.</p></header>
<section aria-labelledby="how"><h2 id="how">How it works</h2><ol class="how">
<li><strong>Open a pull request.</strong> Polygraph boots your <code>main</code> branch and the PR side by side in two fresh Sprites, runs your tests, then uses the app in a real browser on a phone and on desktop.</li>
<li><strong>File a bug.</strong> Label an issue <code>bug</code> and Polygraph follows the reporter's steps on a fresh machine to prove it's real, or asks for what's missing.</li>
<li><strong>Get one answer.</strong> "Safe to merge" or "not ready" on the PR, with screenshots, and a link to the machine where it failed, still running and frozen at the failure.</li>
</ol><p class="muted">Untrusted code only ever runs on machines that hold no keys. GitHub and the AI are reached through Fly.io Sprites connectors, so no token is ever on a Sprite.</p></section>
<section aria-labelledby="recent"><h2 id="recent">Recent verdicts</h2><ul class="runs">${runs}</ul></section>
<section aria-labelledby="connect"><h2 id="connect">Connect a repository</h2>
<form method="post" action="/connect" class="row"><div><label for="repo">GitHub repository</label><input id="repo" name="repo" placeholder="owner/name" required pattern="[\\w.-]+/[\\w.-]+"></div>
<div><label for="pin">PIN</label><input id="pin" name="pin" type="password" inputmode="numeric" required></div><div><button type="submit">Connect</button></div></form>
<p class="muted">Watching: ${state.repos.map((r) => `<a href="https://github.com/${esc(r)}">${esc(r)}</a>`).join(", ") || "nothing yet"}</p></section>
<p class="muted">Powered by <a href="https://sprites.dev">Sprites.dev</a> (<a href="https://fly.io">Fly.io</a>).</p>`);
}

function runPage(r: Run): string {
  const [t, c] = LABEL[r.verdict];
  const tests = (["main", "pr"] as const).filter((k) => r.tests[k]?.ran).map((k) => `<tr><th scope="row">Unit tests on ${k === "pr" ? "this PR" : r.kind === "pr" ? "main" : "the default branch"}</th><td class="${r.tests[k]!.passed ? "ok" : "bad"}">${r.tests[k]!.passed ? "Passed" : "Failed"} ${esc(r.tests[k]!.summary)}</td></tr>`).join("");
  const findings = r.findings.map((f) => {
    const cell = (x?: { ok: boolean; error: string }) => (!x ? "–" : x.ok ? `<span class="ok">Pass</span>` : `<span class="bad">Fail</span>`);
    return `<tr><th scope="row">${esc(f.check.name)} <span class="muted">(${f.check.viewport === "mobile" ? "phone" : "desktop"})</span></th><td>${cell(f.main)}</td>${r.kind === "pr" ? `<td>${cell(f.pr)}</td>` : ""}<td>${f.kind.replace("-", " ")}</td></tr>`;
  }).join("");
  const shots = r.findings.flatMap((f) => [f.main && { s: f.main.shot, cap: `${f.check.name}: ${r.kind === "pr" ? "main" : "what the page showed"}` }, f.pr && { s: f.pr.shot, cap: `${f.check.name}: this PR` }])
    .filter((x): x is { s: string; cap: string } => !!x && (r.findings.some((f) => f.kind !== "ok") ? true : false))
    .map((x) => `<figure><img src="/shots/${esc(x.s)}" alt="${esc(x.cap)}" loading="lazy"><figcaption>${esc(x.cap)}</figcaption></figure>`).join("");
  const machine = r.machine
    ? `<section aria-labelledby="m"><h2 id="m">The machine where it ${r.kind === "pr" ? "failed" : "happens"}</h2>
<p>Still running, exactly as it was when the problem showed up. Snapshot <code>${esc(r.machine.checkpoint || "saved")}</code> can bring it back to this moment. It is deleted in about ${((h) => (h >= 48 ? `${Math.round(h / 24)} days` : `${h} hours`))(Math.max(1, Math.round((r.machine.expiresAt - Date.now()) / 3600_000)))}.</p>
<p><a class="button" href="${esc(r.machine.url)}" target="_blank" rel="noopener">Open the broken app</a></p>
<p><a class="button" href="/runs/${r.id}/shell">Open a shell on this machine</a> <span class="muted">(repo owner, PIN needed)</span></p></section>` : "";
  return page(`${t}: ${r.title}`, `${CSS}
<p><a href="/">← Polygraph</a></p>
<h1><span class="badge ${c}">${t}</span> ${r.kind === "pr" ? "PR" : "Bug"} #${r.number}</h1>
<p class="lead"><a href="${esc(r.url)}">${esc(r.title)}</a> · ${esc(r.repo)} · <code>${esc(r.sha.slice(0, 7))}</code></p>
${r.headline ? `<section><h2>${esc(r.headline)}</h2>${r.expected ? `<p><strong>Expected:</strong> ${esc(r.expected)}</p>` : ""}</section>` : ""}
${machine}
<section aria-labelledby="checks"><h2 id="checks">What Polygraph checked</h2><table><tbody>${tests}</tbody></table>
${findings ? `<table><thead><tr><th scope="col">Browser check</th><th scope="col">${r.kind === "pr" ? "main" : "Result"}</th>${r.kind === "pr" ? `<th scope="col">this PR</th>` : ""}<th scope="col">Meaning</th></tr></thead><tbody>${findings}</tbody></table>` : ""}</section>
${shots ? `<section aria-labelledby="shots"><h2 id="shots">Screenshots</h2><div class="shots">${shots}</div></section>` : ""}
<section aria-labelledby="log"><h2 id="log">Log</h2><pre>${esc(r.log.join("\n"))}</pre></section>
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
