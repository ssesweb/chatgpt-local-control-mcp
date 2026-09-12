import { spawn, execFile } from "node:child_process";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { bin, install } from "cloudflared";
import "dotenv/config";

const execFileAsync = promisify(execFile);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = path.join(ROOT_DIR, ".mcp-artifacts");
const LOG_DIR = path.join(ROOT_DIR, ".mcp-logs");
const URL_FILE = path.join(ARTIFACT_DIR, "tunnel-url.txt");
const ORIGIN_FILE = path.join(ARTIFACT_DIR, "tunnel-origin.txt");
const LOG_FILE = path.join(LOG_DIR, "cloudflared-tunnel.log");
const PORT = process.env.PORT ?? "8787";
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";
const HOST = process.env.HOST ?? "127.0.0.1";
const localHost = HOST === "::" ? "[::1]" : HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
const localOrigin = `http://${localHost}:${PORT}`;
let child;
let stopping = false;

async function exists(candidate) {
  try { await access(candidate); return true; } catch { return false; }
}

async function findCloudflared() {
  if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN;
  for (const candidate of [path.join(ROOT_DIR, ".bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared"), bin]) {
    if (await exists(candidate)) return candidate;
  }
  try {
    const result = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", ["cloudflared"], { timeout: 5000 });
    const executable = result.stdout.trim().split(/\r?\n/)[0];
    if (executable && !/\.(cmd|bat)$/i.test(executable)) return executable;
  } catch {}
  console.log("Downloading cloudflared for this platform...");
  await install(bin);
  return bin;
}

async function verifyMcp(url, secret) {
  const client = new Client({ name: "tunnel-readiness", version: "1.0.0" });
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { "x-secret-key": secret } },
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(5000)]) }),
    });
    await client.connect(transport);
    const listing = await client.listTools();
    if (!listing.tools.some((tool) => tool.name === "computer_status")) throw new Error("Unexpected MCP server");
    const result = await client.callTool({ name: "computer_status", arguments: {} });
    if (result.isError) throw new Error("MCP status failed");
  } finally {
    await client.close();
  }
}

async function main() {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  await writeFile(URL_FILE, "Waiting for verified tunnel URL...\n", "utf8");
  await writeFile(ORIGIN_FILE, "", "utf8");
  const response = await fetch(`${localOrigin}/health`, { signal: AbortSignal.timeout(5000) });
  const health = await response.json();
  if (!health.quickTunnelProtected) throw new Error("Set TUNNEL_MODE=cloudflare and restart the MCP server before exposing it.");
  const secret = process.env.SECRET_KEY?.trim() || (await readFile(path.join(ARTIFACT_DIR, "secret-key.txt"), "utf8")).trim();
  await verifyMcp(`${localOrigin}${MCP_PATH}`, secret);
  const executable = await findCloudflared();
  console.log("Starting Cloudflare temporary HTTPS tunnel; waiting for public MCP verification...");
  child = spawn(executable, ["tunnel", "--url", localOrigin, "--no-autoupdate"], { cwd: ROOT_DIR, stdio: ["ignore", "pipe", "pipe"] });
  let origin;
  let checking = false;
  async function publish() {
    if (checking || !origin) return;
    checking = true;
    const endpoint = new URL(MCP_PATH, origin);
    const deadline = Date.now() + 60000;
    while (!stopping && Date.now() < deadline) {
      try {
        await verifyMcp(endpoint.href, secret);
        if (stopping) return;
        await writeFile(ORIGIN_FILE, `${origin}\n`, "utf8");
        await writeFile(URL_FILE, `${endpoint.href}\n`, "utf8");
        endpoint.searchParams.set("secret-key", secret);
        console.log(`ChatGPT connector URL: ${endpoint.href}`);
        console.log("Public MCP verified. Keep this process running. The temporary URL may change after restart.");
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    if (!stopping) {
      console.error("Public MCP verification failed. Check network access or use a fixed HTTPS tunnel; no ready URL was issued.");
      process.exitCode = 1;
      child.kill();
    }
  }
  for (const stream of [child.stdout, child.stderr]) {
    const lines = createInterface({ input: stream });
    lines.on("line", (line) => {
      void appendFile(LOG_FILE, `${new Date().toISOString()} ${line}\n`, "utf8").catch(() => {});
      const match = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) { origin = match[0]; void publish(); }
    });
  }
  child.once("error", () => { console.error("Failed to launch cloudflared. Check CLOUDFLARED_BIN."); process.exit(1); });
  child.once("exit", (code, signal) => {
    if (!stopping) console.error("Cloudflare tunnel stopped. Check .mcp-logs/cloudflared-tunnel.log and network DNS access.");
    const exitCode = process.exitCode || (stopping ? 0 : code || 1);
    stopping = true;
    process.exit(exitCode);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { stopping = true; child.kill(signal); });
  }
  const timeout = setTimeout(() => {
    if (!checking && !stopping) { console.error("Cloudflare did not issue a URL. Check .mcp-logs/cloudflared-tunnel.log."); process.exitCode = 1; child.kill(); }
  }, 60000);
  timeout.unref();
}

main().catch((error) => {
  console.error(`Tunnel startup failed: ${error.message}`);
  child?.kill();
  process.exit(1);
});
