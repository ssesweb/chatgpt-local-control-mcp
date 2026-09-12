// Boot entry for npm start: run the setup wizard on first launch (no .env),
// then start the MCP server.
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT_DIR, ".env");

if (!existsSync(ENV_FILE)) {
  const result = spawnSync(process.execPath, [path.join(ROOT_DIR, "scripts", "setup-wizard.js")], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

process.chdir(ROOT_DIR);
const { httpServer, SECRET_KEY } = await import(pathToFileURL(path.join(ROOT_DIR, "src", "server.js")).href);
if (!httpServer.listening) await once(httpServer, "listening");
if (process.env.TUNNEL_MODE === "cloudflare") {
  process.env.SECRET_KEY = SECRET_KEY;
  await import("./start-cloudflare-tunnel.js");
}
