// GitHub through the Sprites connector gateway. No GitHub token ever lives on a Sprite.
import { gw } from "../core/gateway.ts";

const MARK = "<!-- polygraph -->";

export async function gh<T = any>(method: string, path: string, body?: unknown, accept = "application/vnd.github+json"): Promise<T> {
  const res = await gw("github", path, {
    method,
    headers: { accept, "content-type": "application/json", "x-github-api-version": "2022-11-28" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (res.status === 204) return undefined as T;
  return (accept.includes("json") ? res.json() : res.text()) as Promise<T>;
}

export interface PR { number: number; title: string; body: string | null; html_url: string; head: { sha: string; ref: string }; base: { sha: string; ref: string }; user: { login: string } }
export interface Issue { number: number; title: string; body: string | null; html_url: string; labels: { name: string }[]; pull_request?: unknown; user: { login: string } }

export const openPRs = (repo: string) => gh<PR[]>("GET", `/repos/${repo}/pulls?state=open&per_page=20`);
export const openBugs = async (repo: string) =>
  (await gh<Issue[]>("GET", `/repos/${repo}/issues?state=open&labels=bug&per_page=20`)).filter((i) => !i.pull_request);
export const branchSha = async (repo: string, branch: string) => (await gh("GET", `/repos/${repo}/commits/${branch}`)).sha as string;
export const defaultBranch = async (repo: string) => (await gh("GET", `/repos/${repo}`)).default_branch as string;

/** The PR's diff, trimmed so it fits in a prompt. */
export async function prDiff(repo: string, n: number, max = 12_000): Promise<string> {
  const d = await gh<string>("GET", `/repos/${repo}/pulls/${n}`, undefined, "application/vnd.github.diff");
  return d.length > max ? d.slice(0, max) + "\n… (diff truncated)" : d;
}

/** A gzipped tarball of the repo at a commit. */
export async function tarball(repo: string, sha: string): Promise<Buffer> {
  const res = await gw("github", `/repos/${repo}/tarball/${sha}`, { redirect: "follow" });
  if (!res.ok) throw new Error(`tarball ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** The check mark on the PR. "failure" blocks the merge when the check is required. */
export async function setStatus(repo: string, sha: string, state: "pending" | "success" | "failure" | "error", description: string, target_url?: string) {
  await gh("POST", `/repos/${repo}/statuses/${sha}`, { state, description: description.slice(0, 140), context: "Polygraph", target_url });
}

/** One Polygraph comment per PR or issue, updated in place instead of piling up. */
export async function upsertComment(repo: string, n: number, body: string) {
  const comments = await gh<{ id: number; body: string }[]>("GET", `/repos/${repo}/issues/${n}/comments?per_page=100`);
  const mine = comments.find((c) => c.body.includes(MARK));
  const text = `${MARK}\n${body}`;
  if (mine) await gh("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body: text });
  else await gh("POST", `/repos/${repo}/issues/${n}/comments`, { body: text });
}

export async function addLabel(repo: string, n: number, label: string) {
  await gh("POST", `/repos/${repo}/issues/${n}/labels`, { labels: [label] });
}
