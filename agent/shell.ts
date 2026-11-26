// A browser shell on a kept machine, for the repo owner (behind the PIN).
// The browser talks to Polygraph; Polygraph opens a TTY on the machine through the Sprites exec API
// with the token only it holds. Nothing is installed on the broken machine and the app keeps running.
import type http from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";

const API_WS = "wss://api.sprites.dev/v1/sprites";
const token = () => readFileSync(`${process.env.HOME}/.config/hg/sprites-token`, "utf8").trim();
const size = (v: string | null, def: number, max: number) => Math.min(max, Math.max(10, Number(v) || def));

export function attachShell(server: http.Server, opts: { authorized: (req: http.IncomingMessage) => boolean; machineFor: (runId: string) => string | null }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on("upgrade", (req, socket, head) => {
    const m = /^\/runs\/(\w+)\/shell\/ws(?:\?.*)?$/.exec(req.url ?? "");
    const sprite = m ? opts.machineFor(m[1]) : null;
    if (!sprite || !opts.authorized(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const q = new URL(req.url ?? "/", "http://x").searchParams;
      const cols = size(q.get("cols"), 100, 400), rows = size(q.get("rows"), 30, 200);
      // TTY mode: raw bytes both ways; resize is a JSON text frame. The shell ends 30 s after you leave.
      const up = new WebSocket(`${API_WS}/${sprite}/exec?cmd=bash&tty=true&cols=${cols}&rows=${rows}&max_run_after_disconnect=30s`, { headers: { Authorization: `Bearer ${token()}` } });
      const queue: { data: WebSocket.RawData; binary: boolean }[] = [];
      up.on("open", () => {
        up.send(Buffer.from("export TERM=xterm-256color; cd ~/app 2>/dev/null; clear; echo 'Polygraph: this is the machine where it failed. The app is still running here.'\n"));
        for (const q of queue.splice(0)) up.send(q.data, { binary: q.binary });
      });
      up.on("message", (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
      up.on("close", () => client.close());
      up.on("error", (e) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "error", message: e.message }));
        client.close();
      });
      client.on("message", (data, binary) => {
        if (up.readyState === WebSocket.OPEN) up.send(data, { binary });
        else if (queue.length < 100) queue.push({ data, binary });
      });
      client.on("close", () => up.close());
    });
  });
}

export function shellPage(title: string, back: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>html,body{margin:0;height:100%;background:#0b0d10;color:#e6e6e6;font:15px system-ui,sans-serif}
header{display:flex;gap:1rem;align-items:center;justify-content:space-between;padding:.5rem 1rem;border-bottom:1px solid #222}
header a{color:#8ab4f8}main{position:absolute;inset:2.75rem 0 0 0;padding:.5rem}#term{height:100%}</style></head>
<body><header><strong>${title}</strong><a href="${back}">← Back to the report</a></header><main><div id="term" role="application" aria-label="Terminal"></div></main>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script>
const term = new Terminal({ fontSize: 14, cursorBlink: true, scrollback: 5000 });
const fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open(document.getElementById("term")); fit.fit(); term.focus();
const url = location.href.replace(/^http/, "ws").replace(/\\/shell.*$/, "/shell/ws") + "?cols=" + term.cols + "&rows=" + term.rows;
const ws = new WebSocket(url); ws.binaryType = "arraybuffer";
const enc = new TextEncoder();
ws.onmessage = (e) => {
  if (typeof e.data !== "string") return term.write(new Uint8Array(e.data));
  try { const m = JSON.parse(e.data); if (m.type === "exit") term.write("\\r\\n[shell closed]\\r\\n"); if (m.type === "error") term.write("\\r\\n[error: " + m.message + "]\\r\\n"); } catch {}
};
ws.onclose = () => term.write("\\r\\n[disconnected]\\r\\n");
term.onData((d) => ws.readyState === 1 && ws.send(enc.encode(d)));
term.onResize(({ cols, rows }) => ws.readyState === 1 && ws.send(JSON.stringify({ type: "resize", cols, rows })));
addEventListener("resize", () => fit.fit());
</script></body></html>`;
}
