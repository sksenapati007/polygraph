// README screenshots (runs on pg-browser). Usage: node readme-shots.cjs <out-dir> <agent-url> <pin> <fail-run> <repro-run>
const { chromium, devices } = require("playwright");
const fs = require("fs");
const [out, agent, pin, failRun, reproRun] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const GH = "https://github.com/sksenapati007/polygraph-demo-shop";

(async () => {
  const browser = await chromium.launch();
  const desktop = () => browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" });
  const shot = async (name, fn) => { try { await fn(); console.log("ok", name); } catch (e) { console.log("FAILED", name, String(e.message).split("\n")[0]); } };

  await shot("agent", async () => {
    const c = await desktop(); const p = await c.newPage();
    await p.goto(agent + "/", { waitUntil: "networkidle" });
    await p.screenshot({ path: `${out}/agent.png`, fullPage: true }); await c.close();
  });
  await shot("report", async () => {
    const c = await desktop(); const p = await c.newPage();
    await p.goto(`${agent}/runs/${failRun}`, { waitUntil: "networkidle" });
    await p.screenshot({ path: `${out}/report.png`, fullPage: true }); await c.close();
  });
  await shot("report-phone", async () => {
    const c = await browser.newContext({ ...devices["iPhone 13"], deviceScaleFactor: 2, colorScheme: "light" }); const p = await c.newPage();
    await p.goto(`${agent}/runs/${failRun}`, { waitUntil: "networkidle" });
    await p.screenshot({ path: `${out}/report-phone.png` }); await c.close();
  });
  await shot("shell", async () => {
    const c = await browser.newContext({ viewport: { width: 1100, height: 460 }, deviceScaleFactor: 1 }); const p = await c.newPage();
    await p.goto(`${agent}/runs/${failRun}/shell`, { waitUntil: "networkidle" });
    await p.fill("#pin", pin); await p.click("button[type=submit]");
    await p.waitForSelector(".xterm-rows", { timeout: 15000 }); await p.waitForTimeout(2500);
    await p.keyboard.type("grep -n promo public/index.html | head -3; curl -s -o /dev/null -w 'app: HTTP %{http_code}\\n' localhost:8080/\n");
    await p.waitForTimeout(9000);
    await p.screenshot({ path: `${out}/shell.png` }); await c.close();
  });
  // GitHub comments: screenshot just the Polygraph comment.
  for (const [name, url] of [["pr-fail", `${GH}/pull/2`], ["pr-pass", `${GH}/pull/3`], ["issue", `${GH}/issues/1`]]) {
    await shot(name, async () => {
      const c = await desktop(); const p = await c.newPage();
      await p.goto(url, { waitUntil: "domcontentloaded" }); await p.waitForTimeout(4000);
      const body = p.locator(".comment-body, .markdown-body").filter({ hasText: "Polygraph" }).last();
      // GitHub's sticky headers would cover the top of the comment.
      await p.evaluate(() => { for (const el of document.querySelectorAll("*")) { const pos = getComputedStyle(el).position; if (pos === "sticky" || pos === "fixed") el.style.setProperty("display", "none", "important"); } });
      await body.scrollIntoViewIfNeeded(); await p.waitForTimeout(1500);
      await body.screenshot({ path: `${out}/${name}.png` }); await c.close();
    });
  }
  await browser.close();
})();
