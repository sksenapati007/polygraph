// Usage: node tools/openpr.ts <dir> <branch> <commit message> <PR title> <PR body>
import { execFileSync } from "node:child_process";
import { gh } from "../agent/github.ts";
const [dir, branch, msg, title, body] = process.argv.slice(2);
const repo = process.env.PG_REPO ?? "sksenapati007/polygraph-demo-shop";
const main = (await gh("GET", `/repos/${repo}/git/ref/heads/main`)).object.sha;
await gh("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: main });
console.log(execFileSync("python3", ["tools/ghpush.py", repo, dir, msg, branch]).toString().trim());
const pr = await gh("POST", `/repos/${repo}/pulls`, { title, body, head: branch, base: "main" });
console.log(pr.number, pr.html_url);
