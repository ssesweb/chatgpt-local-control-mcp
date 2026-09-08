import { spawn, execFile } from "node:child_process";
import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = path.join(ROOT_DIR, ".mcp-artifacts");
const LOG_DIR = path.join(ROOT_DIR, ".mcp-logs");
const URL_FILE = path.join(ARTIFACT_DIR, "tunnel-url.txt");
const ORIGIN_FILE = path.join(ARTIFACT_DIR, "tunnel-origin.txt");
const LOG_FILE = path.join(LOG_DIR, "cloudflared-tunnel.log");
const PORT = process.env.PORT ?? "8787";
const IS_WINDOWS = process.platform === "win32";

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function firstOnPath(command) {
  const locator = IS_WINDOWS ? "where.exe" : "which";
  try {
    const result = await execFileAsync(locator, [command], { timeout: 5_000 });
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return "";
  }
}

async function findCloudflared() {
  if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN;

  const home = os.homedir();
  const candidates = [
    path.join(ROOT_DIR, ".bin", IS_WINDOWS ? "cloudflared.exe" : "cloudflared"),
    // The npm package exposes a .cmd shim in node_modules/.bin on Windows.
    // Node's spawn() does not resolve that shim unless shell mode is enabled,
    // so prefer the bundled native executable instead.
    ...(IS_WINDOWS
      ? [path.join(ROOT_DIR, "node_modules", "cloudflared", "bin", "cloudflared.exe")]
      : []),
    path.join(home, ".local", "bin", IS_WINDOWS ? "cloudflared.exe" : "cloudflared"),
    ...(IS_WINDOWS
      ? [
          path.join(process.env.ProgramFiles ?? "C:\\Program Files", "cloudflared", "cloudflared.exe"),
          path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "cloudflared", "cloudflared.exe"),
        ]
      : ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"]),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  return await firstOnPath("cloudflared");
}

async function logLine(line) {
  await appendFile(LOG_FILE, `${new Date().toISOString()} ${line}\n`, "utf8");
}

await mkdir(ARTIFACT_DIR, { recursive: true });
await mkdir(LOG_DIR, { recursive: true });
await writeFile(URL_FILE, "Waiting for tunnel URL...\n", "utf8");

const cloudflared = await findCloudflared();
if (!cloudflared) {
  console.error("cloudflared not found. Install cloudflared, then run npm run tunnel again.");
  process.exit(127);
}

await logLine(`Starting cloudflared tunnel with ${cloudflared}`);
console.log(`Starting cloudflared tunnel with ${cloudflared}`);

const child = spawn(cloudflared, ["tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"], {
  cwd: ROOT_DIR,
  stdio: ["ignore", "pipe", "pipe"],
});

function handleOutput(chunk) {
  const text = chunk.toString("utf8");
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    console.log(line);
    void logLine(line);
    const match = line.match(/https:\/\/[-a-zA-Z0-9.]+\.trycloudflare\.com/);
    if (match) {
      const origin = match[0];
      void writeFile(ORIGIN_FILE, `${origin}\n`, "utf8");
      void writeFile(URL_FILE, `${origin}/mcp\n`, "utf8");
      console.log(`MCP URL: ${origin}/mcp`);
    }
  }
}

child.stdout.on("data", handleOutput);
child.stderr.on("data", handleOutput);
child.on("error", (error) => {
  console.error(`Failed to start cloudflared: ${error.message}`);
  void logLine(`Failed to start cloudflared: ${error.stack ?? error.message}`);
  process.exit(127);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) process.exit(0);
  process.exit(code ?? 0);
});
