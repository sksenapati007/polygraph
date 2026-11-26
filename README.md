# Polygraph

**Catches "works on my machine".** Polygraph is an AI tester that checks every pull request and reproduces every bug report in a throwaway [Fly.io Sprite](https://sprites.dev), then tells you in plain English what it found, and hands you the machine where it failed.

Live agent: **https://shubu-polygraph-b6vfx.sprites.app**
Try it on the demo repo: [sksenapati007/polygraph-demo-shop](https://github.com/sksenapati007/polygraph-demo-shop) ([issue #1](https://github.com/sksenapati007/polygraph-demo-shop/issues/1), [PR #2](https://github.com/sksenapati007/polygraph-demo-shop/pull/2), [PR #3](https://github.com/sksenapati007/polygraph-demo-shop/pull/3))

## What it does

**Open a pull request.** About a minute later, one comment and one check mark:

> ❌ **Polygraph: not ready to merge**
> **Checkout button covered**
> - Everything on the home page can be tapped (phone): something is on top of "Checkout" (covered by `<aside.promo>`), so a tap never reaches it.
> - Add item and checkout (phone): the button is covered by another element, so the tap never reaches it.
>
> ▶ Open the machine where it failed: the PR is still running there, frozen at the failure.

All 4 unit tests passed on that PR. Plain CI would have said green.

**File a bug** (label it `bug`). Polygraph follows the reporter's steps on a fresh machine, twice, and replies:

> 🔁 **Polygraph reproduced this bug**
> **Adding two Karak chai shows quantity 1 and charges for only one**
> Expected: adding the same item twice should show a quantity of 2. On screen: 1 × Karak chai.
> ▶ Open the machine where it happens: the bug is live there right now.

If it can't reproduce the bug, it says so and asks for the missing detail.

## How it decides

The model plans; rules decide.

1. **Two fresh machines per PR.** `main` and the PR boot side by side in two new Sprites. Polygraph runs your unit tests on both and starts the app on both.
2. **Every check runs on both.** A check only counts against the PR if it passes on `main` and fails on the PR, twice in a row. A badly written check fails on both branches, so it can never turn a PR red.
3. **Three kinds of checks:**
   - **Tap test (no AI).** On a phone and on desktop, every button, link and field must be reachable, with nothing on top of it. This catches banners, cookie bars and modals that cover buttons, for any app.
   - **Core journeys.** The model plans the app's most important paths (for a shop: add an item, check out, see the confirmation) from `main` alone, without seeing the PR. Each journey is proven on `main` first. If one fails there, the model gets one chance to correct its own check from what the screen showed. Journeys are planned once per `main` commit, so every PR is held to the same bar.
   - **Checks for the change.** The model reads the diff and checks what the PR adds or changes.
4. **The model can only use a tiny step vocabulary:** go to a page, tap, type, press, expect text. It never writes code that runs. Unknown steps are dropped.
5. **Failures are kept.** A failing PR machine (or a machine with a reproduced bug) is checkpointed and left running (24 hours by default, `PG_KEEP_HOURS` to change it). From the report you can open the broken app, or open a shell on the machine in your browser (PIN needed). The shell goes through the Sprites exec API from the control Sprite, so nothing is installed on the broken machine and the app keeps running.

## Safe by design

- **Untrusted code runs on keyless machines.** PR code runs on throwaway Sprites that hold no tokens. Their names (`pg-…`) sit outside the GitHub connector's access policy (`shubu-…` only), so they can't touch your repos. Give your AI connector the same name-prefix policy so they can't spend your credits either.
- **No tokens on any Sprite.** GitHub and the AI are reached through Sprites connectors; the gateway injects the credentials.
- **The browser is its own keyless Sprite.** Playwright runs on `pg-browser`, separate from both the app machines and the control Sprite.

```
GitHub ──(connector)──► shubu-polygraph (control: watches repos, plans, decides, reports)
                              │  Sprites API (token stays on this Sprite only)
          ┌───────────────────┼─────────────────────┐
          ▼                   ▼                     ▼
   pg-…-main (main)    pg-…-<sha> (the PR)    pg-browser (Playwright)
   no keys, deleted    no keys, kept         no keys
                       if it fails
```

## Sprites features used

- **Fresh Sprites per run**: two per PR, one per bug report, created in seconds and deleted afterwards.
- **Checkpoints**: the failure state is saved, so the broken machine can be brought back to that exact moment.
- **Public URLs**: each machine serves its app, so the browser Sprite can test it and you can open it.
- **Services**: the app, the agent and the browser runs are all Sprite services.
- **Connectors**: GitHub (read code, comment, set the commit status, label issues) and Ollama (`gpt-oss:120b` for planning and headlines).

## Use it on your repo

1. Open the [agent page](https://shubu-polygraph-b6vfx.sprites.app), enter `owner/name` and the PIN, and press Connect.
2. Optional: in GitHub branch protection, make the **Polygraph** status check required, so a red verdict blocks the merge.
3. Open a PR, or label an issue `bug`.

Today it supports Node.js web apps that start with `npm start` (or `node server.js`). If the app ignores `PORT` and hard-codes its own port, Polygraph finds the port it opened. Native modules (like `sqlite3`) build, because install scripts are allowed on the throwaway machines. If the app won't start even on `main`, Polygraph says "couldn't test" instead of guessing.

Tested on real open-source apps as well as the demo shop:

| App | PR | Unit tests | Polygraph |
|---|---|---|---|
| [heroku/node-js-getting-started](https://github.com/sksenapati007/node-js-getting-started/pull/1) (Express, EJS) | Adds a Times page whose route calls a missing helper | ✅ 2 passed | ❌ "Times link leads to 500 error on both desktop and mobile" |
| [socketio/chat-example](https://github.com/sksenapati007/chat-example/pull/1) (Socket.IO, SQLite, hard-coded ports) | Stores message times, but the SQL has 3 columns and 2 values | none | ❌ "Messages never appear when sent via button or Enter key on any device" |
| [socketio/chat-example](https://github.com/sksenapati007/chat-example/pull/2) | Adds a placeholder and label to the message box | none | ✅ Safe to merge |
| [polygraph-demo-shop](https://github.com/sksenapati007/polygraph-demo-shop/pull/2) | Adds a promo banner that covers Checkout on phones | ✅ 4 passed | ❌ "Checkout button covered" |
| [polygraph-demo-shop](https://github.com/sksenapati007/polygraph-demo-shop/pull/3) | Fixes the double-add bug | ✅ 5 passed | ✅ Safe to merge |

**Stable:** all six cases (the five PRs above plus [bug report #1](https://github.com/sksenapati007/polygraph-demo-shop/issues/1)) were run three times each, with the core journeys re-planned from scratch every round: 18 of 18 verdicts correct. A bug report takes about 35 seconds, a PR 1 to 3.5 minutes. `tools/stability.ts` repeats the test.

## Run your own

You need two Sprites connectors (GitHub and Ollama) whose policy admits only your control Sprite, plus a Sprites API token.

1. Create a control Sprite (e.g. `shubu-polygraph`), store the token at `~/.config/hg/sprites-token` (mode 0600), and copy this repo to `~/polygraph` and run `npm install` there.
2. Create a keyless browser Sprite named `pg-browser` and install Playwright there: `npm i playwright && npx playwright install --with-deps chromium` in `~/pw`.
3. Start the agent as a Sprite service on port 8080 with these environment variables: `PG_PUBLIC_URL` (the control Sprite's URL), `PG_REPOS` (comma-separated `owner/name`), `PG_PIN`, `HG_LLM=cloud`, and optionally `HG_NTFY_TOPIC` for phone notifications through [ntfy](https://ntfy.sh). `tools/start.ts` does this for you, reading the settings from `~/.config/hg/polygraph.env.json` so they never land in the repo.

## Layout

```
agent/server.ts    watches repos, runs jobs one at a time, serves the agent page and run reports
agent/jobs.ts      the PR check and the bug reproduction: verdict rules and GitHub comments
agent/plan.ts      prompts: core journeys, checks for a PR, bug steps, self-repair, headlines
agent/browser.ts   the step vocabulary and the Playwright runner (incl. the tap test)
agent/machine.ts   boots a commit on a fresh, keyless Sprite: install, unit tests, start
agent/github.ts    GitHub through the connector: PRs, issues, diffs, tarballs, statuses, comments
agent/shell.ts     browser shell on a kept machine, through the Sprites exec API
core/              Sprites API client, connector gateway, LLM, ntfy, page shell
tools/             start the service, open demo PRs, the stability test, commit through the connector
```

## Open source stack

Node.js 24 (TypeScript, no build step) · [ws](https://github.com/websockets/ws) (MIT) · [xterm.js](https://xtermjs.org) (MIT) for the browser shell · [Playwright](https://playwright.dev) (Apache-2.0) · [Ollama](https://ollama.com) with open-weight models · [ntfy](https://ntfy.sh) for phone notifications.

## License

MIT
