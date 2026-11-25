// Throwaway machines. Each one is a fresh Sprite holding one commit of the repo and nothing else:
// no Sprites token, and its name ("pg-…") is outside the GitHub connector's "shubu-" policy.
// Whatever the PR's code does, it can only damage a box we are about to delete.
import * as sprites from "../core/sprites.ts";
import { tarball } from "./github.ts";

export interface Machine {
  sprite: string;
  url: string;
  installed: boolean;
  tests: { ran: boolean; passed: boolean; summary: string; tail: string };
  started: boolean;
  log: string[];
}

const tail = (s: string, n = 40) => s.trim().split("\n").slice(-n).join("\n");

/** Node's test runner, Jest, Mocha and Vitest all print a pass/fail count somewhere near the end. */
function testSummary(out: string): string {
  const pass = out.match(/(?:ℹ|#)\s*pass (\d+)/)?.[1] ?? out.match(/(\d+) passing/)?.[1] ?? out.match(/Tests:.*?(\d+) passed/)?.[1];
  const fail = out.match(/(?:ℹ|#)\s*fail (\d+)/)?.[1] ?? out.match(/(\d+) failing/)?.[1] ?? out.match(/Tests:.*?(\d+) failed/)?.[1] ?? "0";
  return pass !== undefined ? `${pass} passed, ${fail} failed` : "";
}

export async function destroy(sprite: string) {
  try { await sprites.deleteSprite(sprite); } catch { /* already gone */ }
}

export async function boot(repo: string, sha: string, sprite: string): Promise<Machine> {
  const m: Machine = { sprite, url: "", installed: false, tests: { ran: false, passed: false, summary: "", tail: "" }, started: false, log: [] };
  const say = (s: string) => { m.log.push(s); console.log(`[${sprite}] ${s}`); };

  await destroy(sprite);
  m.url = (await sprites.createSprite(sprite, true)).url;
  say(`fresh machine ${m.url}`);

  await sprites.writeBytes(sprite, "/home/sprite/src.tgz", await tarball(repo, sha));
  const unpack = await sprites.run(sprite, "mkdir -p ~/app && tar xzf ~/src.tgz -C ~/app --strip-components=1 && rm ~/src.tgz && ls ~/app", 60_000);
  if (unpack.code !== 0) { say(`could not unpack: ${tail(unpack.out, 5)}`); return m; }

  const pkg = JSON.parse((await sprites.readFile(sprite, "/home/sprite/app/package.json")) ?? "{}");
  const hasDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length > 0;
  if (hasDeps) {
    const inst = await sprites.run(sprite, "cd ~/app && (npm ci || npm install) 2>&1 | tail -20", 300_000);
    if (inst.code !== 0) { say(`install failed: ${tail(inst.out, 8)}`); return m; }
  }
  m.installed = true;
  say(hasDeps ? "dependencies installed" : "no dependencies to install");

  if (pkg.scripts?.test) {
    const t = await sprites.run(sprite, "cd ~/app && CI=1 npm test 2>&1", 300_000);
    m.tests = { ran: true, passed: t.code === 0, summary: testSummary(t.out), tail: tail(t.out) };
    say(`tests ${m.tests.passed ? "passed" : "FAILED"} ${m.tests.summary}`);
  }

  const start = pkg.scripts?.start ? "npm start" : `node ${pkg.main ?? "server.js"}`;
  await sprites.putServiceFull(sprite, "app", { cmd: "bash", args: ["-lc", `cd ~/app && ${start}`], env: { PORT: "8080" }, dir: "/home/sprite/app", http_port: 8080 });
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(m.url, { signal: AbortSignal.timeout(5000) });
      if (r.status < 500) { m.started = true; break; }
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  say(m.started ? "app is up" : "app did not start");
  return m;
}
