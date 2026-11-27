// Screenshots of the agent's own pages (runs on pg-browser, which has Playwright).
// Usage: node shots.cjs <out-dir> <base-url> <page-path>... ; each path is shot on desktop and phone.
const { chromium, devices } = require("playwright");
const fs = require("fs");
const [out, base, ...paths] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await chromium.launch();
  for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 900 } }], ["phone", { ...devices["iPhone 13"] }]]) {
    for (const p of paths) {
      const ctx = await browser.newContext({ ...opts, colorScheme: "light" });
      const page = await ctx.newPage();
      await page.goto(base + p, { waitUntil: "networkidle", timeout: 30000 });
      const name = `${label}-${p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home"}`;
      await page.screenshot({ path: `${out}/${name}.jpg`, type: "jpeg", quality: 40, fullPage: true, scale: "css" });
      await ctx.close();
      console.log("shot", name);
    }
  }
  await browser.close();
})();
