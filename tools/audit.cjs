// Accessibility + layout audit of the agent's pages (runs on pg-browser).
// Usage: node audit.cjs <base-url> <path>...   Checks WCAG 2.2 AA with axe-core, in light and dark mode,
// on desktop and phone, plus horizontal overflow and tap targets smaller than 24x24 CSS px.
const { chromium, devices } = require("playwright");
const axeSource = require("fs").readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const [base, ...paths] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  for (const [label, opts] of [["desktop", { viewport: { width: 1280, height: 900 } }], ["phone", { ...devices["iPhone 13"] }]]) {
    for (const scheme of ["light", "dark"]) {
      for (const p of paths) {
        const ctx = await browser.newContext({ ...opts, colorScheme: scheme });
        const page = await ctx.newPage();
        await page.goto(base + p, { waitUntil: "networkidle", timeout: 30000 });
        await page.addScriptTag({ content: axeSource });
        const r = await page.evaluate(async () => {
          const res = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
          const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
          const small = [...document.querySelectorAll("a,button,input,select,textarea")].filter((el) => {
            const b = el.getBoundingClientRect();
            return b.width > 0 && b.height > 0 && (b.width < 24 || b.height < 24) && !(el.tagName === "A" && getComputedStyle(el).display === "inline");
          }).map((el) => el.tagName.toLowerCase() + ":" + (el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 30));
          return { violations: res.violations.map((v) => `${v.impact} ${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`), overflow, small: small.slice(0, 6) };
        });
        console.log(`[${label}/${scheme}] ${p} -> ${r.violations.length} violations${r.overflow ? ", HORIZONTAL OVERFLOW" : ""}${r.small.length ? ", small targets: " + r.small.join(", ") : ""}`);
        for (const v of r.violations) console.log("   " + v);
        await ctx.close();
      }
    }
  }
  await browser.close();
})();
