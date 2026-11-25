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
  appLog: string; // the app's last output lines, when it would not start
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
  const m: Machine = { sprite, url: "", installed: false, tests: { ran: false, passed: false, summary: "", tail: "" }, started: false, appLog: "", log: [] };
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
    // Install scripts (native modules like sqlite3) are allowed: this machine holds no keys and is thrown away.
    const npm = "--dangerously-allow-all-scripts --no-audit --no-fund";
    const inst = await sprites.run(sprite, `set -o pipefail; cd ~/app && (npm ci ${npm} || npm install ${npm}) 2>&1 | tail -20`, 300_000);
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
  const svc = (port: number) => sprites.putServiceFull(sprite, "app", { cmd: "bash", args: ["-lc", `cd ~/app && ${start}`], env: { PORT: "8080" }, dir: "/home/sprite/app", http_port: port });
  await svc(8080);
  m.started = await answers(m.url, 10);
  if (!m.started) {
    // Many apps hard-code their port instead of reading PORT. Find the one it actually opened.
    const port = await detectPort(sprite);
    if (port) {
      say(`app ignores PORT and listens on ${port}; pointing the machine's URL there`);
      await sprites.deleteService(sprite, "app");
      await svc(port);
      m.started = await answers(m.url, 15);
    }
  }
  if (!m.started) m.appLog = tail((await sprites.run(sprite, "tail -n 25 /.sprite/logs/services/app.log 2>/dev/null | cut -c26-", 30_000)).out, 25);
  say(m.started ? "app is up" : "app did not start");
  return m;
}

async function answers(url: string, tries: number): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (r.status < 500) return true;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/** The lowest TCP port the app is listening on that answers HTTP, read from /proc/net (no tools needed). */
async function detectPort(sprite: string): Promise<number | null> {
  // Python reads the kernel's socket table, so no extra tools are needed on the machine.
  const py = [
    "import glob",
    "ports = set()",
    "for f in glob.glob('/proc/net/tcp*'):",
    "    for l in open(f).readlines()[1:]:",
    "        p = l.split()",
    "        if p[3] == '0A': ports.add(int(p[1].rsplit(':', 1)[1], 16))",
    "for x in sorted(ports):",
    "    if x >= 1024 and x != 8080: print(x)",
  ].join("\n");
  await sprites.writeFile(sprite, "/var/tmp/pg-ports.py", py);
  const r = await sprites.run(sprite, `for p in $(python3 /var/tmp/pg-ports.py); do c=$(curl -s -o /dev/null -m 3 -w '%{http_code}' localhost:$p/); if [ "$c" != 000 ] && [ "$c" -lt 500 ]; then echo $p; break; fi; done`, 60_000);
  const port = Number(r.out.trim().split("\n")[0]);
  return Number.isInteger(port) && port > 0 ? port : null;
}
