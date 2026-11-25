// (Re)start the Polygraph service on this Sprite.
// Settings live outside the repo, in ~/.config/hg/polygraph.env.json, e.g.
//   { "PG_PUBLIC_URL": "https://<your-sprite>.sprites.app", "PG_REPOS": "owner/repo", "PG_PIN": "123456",
//     "HG_LLM": "cloud", "HG_NTFY_TOPIC": "<long random topic>" }
// Usage: node tools/start.ts [sprite-name]   (default: the name of this Sprite)
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { putServiceFull, deleteService } from "../core/sprites.ts";

const sprite = process.argv[2] ?? process.env.SPRITE_NAME ?? hostname();
const env = JSON.parse(readFileSync(`${process.env.HOME}/.config/hg/polygraph.env.json`, "utf8")) as Record<string, string>;
await deleteService(sprite, "polygraph"); // services create does not replace an existing one
await new Promise((r) => setTimeout(r, 1500));
await putServiceFull(sprite, "polygraph", { cmd: "node", args: [`${process.env.HOME}/polygraph/agent/server.ts`], env, dir: `${process.env.HOME}/polygraph`, http_port: 8080 });
console.log(`polygraph service started on ${sprite}`);
