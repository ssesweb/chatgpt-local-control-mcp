import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import "dotenv/config";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT ?? 8787);
const HOST = (process.env.HOST ?? "127.0.0.1").trim() || "127.0.0.1";
const MCP_PATH = process.env.MCP_PATH ?? "/mcp";
const PUBLIC_MCP_URL = (process.env.PUBLIC_MCP_URL ?? "").trim();
const QUICK_TUNNEL = process.env.TUNNEL_MODE === "cloudflare";
const STARTED_AT = new Date();
const CWD = process.cwd();
const PLATFORM = os.platform();
const NO_AUTH_SECURITY_SCHEMES = [{ type: "noauth" }];
const CONTROL_SECURITY_SCHEMES = [{ type: "oauth2", scopes: ["local.control"] }];
const OAUTH_SCOPES = ["local.read", "local.control"];
const OAUTH_CODES = new Map();
const OAUTH_TOKENS = new Map();
const OAUTH_CODE_TTL_MS = 5 * 60 * 1000;

const CONFIG = {
  allowWrites: process.env.ALLOW_WRITES === "1",
  allowShell: process.env.ALLOW_SHELL === "1",
  allowUnsafeShell: process.env.ALLOW_UNSAFE_SHELL === "1",
  allowScreenshot: process.env.ALLOW_SCREENSHOT === "1",
  allowOpen: process.env.ALLOW_OPEN === "1",
  allowAppleScript: (process.env.ALLOW_APPLESCRIPT ?? (PLATFORM === "darwin" ? "1" : "0")) === "1",
  allowGui: process.env.ALLOW_GUI === "1",
  controlPin: process.env.LOCAL_CONTROL_PIN ?? "",
  requireOAuthApprovalPin: process.env.OAUTH_REQUIRE_APPROVAL_PIN === "1",
  oauthTokenTtlSeconds: Number(process.env.OAUTH_TOKEN_TTL_SECONDS ?? 24 * 60 * 60),
  maxCommandOutputChars: Number(process.env.MAX_COMMAND_OUTPUT_CHARS ?? 20_000),
  maxReadBytes: Number(process.env.MAX_READ_BYTES ?? 262_144),
  maxDirectoryEntries: Number(process.env.MAX_DIRECTORY_ENTRIES ?? 300),
  commandTimeoutMs: Number(process.env.COMMAND_TIMEOUT_MS ?? 15_000),
  safeExecutables: new Set(
    (process.env.SAFE_EXECUTABLES ??
      "pwd,ls,find,cat,head,tail,wc,du,df,ps,whoami,hostname,git,git.exe,node,node.exe,npm,npm.cmd,npx,npx.cmd,python,python.exe,python3,python3.exe,rg,rg.exe,sed,where,where.exe,ipconfig,tasklist")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  ),
};

const AUDIT_DIR = path.join(CWD, ".mcp-audit");
const ARTIFACT_DIR = path.join(CWD, ".mcp-artifacts");
const SECRET_KEY_FILE = path.join(ARTIFACT_DIR, "secret-key.txt");
const ENV_SECRET_KEY = (process.env.SECRET_KEY ?? "").trim();

// The secret key gates every privileged tool in one step: any request that
// presents it (query param or header) gets full local.control access, no
// OAuth flow or control_pin involved. Generated once and persisted so the
// connector URL survives restarts.
async function resolveSecretKey() {
  if (ENV_SECRET_KEY) return ENV_SECRET_KEY;
  await mkdir(ARTIFACT_DIR, { recursive: true });
  try {
    const existing = (await readFile(SECRET_KEY_FILE, "utf8")).trim();
    if (existing) return existing;
  } catch {
    // No stored key yet; fall through and generate one.
  }
  const generated = uuidv4();
  await writeFile(SECRET_KEY_FILE, `${generated}\n`, "utf8");
  return generated;
}

const SECRET_KEY = await resolveSecretKey();

function platformLabel() {
  if (PLATFORM === "darwin") return "Mac";
  if (PLATFORM === "win32") return "Windows PC";
  if (PLATFORM === "linux") return "Linux computer";
  return `${PLATFORM} computer`;
}

function expandHome(inputPath) {
  if (!inputPath || inputPath === ".") return CWD;
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

function parseAllowedRoots() {
  const raw = process.env.LOCAL_CONTROL_ROOTS?.trim();
  const roots = raw ? raw.split(path.delimiter) : [CWD];

  return roots
    .map((root) => path.resolve(expandHome(root.trim())))
    .filter((root) => root && existsSync(root))
    .map((root) => realpathSync(root));
}

const ALLOWED_ROOTS = parseAllowedRoots();

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertAllowedRealPath(realCandidate) {
  if (!ALLOWED_ROOTS.some((root) => isPathInside(root, realCandidate))) {
    throw new Error(
      `Path is outside LOCAL_CONTROL_ROOTS. Allowed roots: ${ALLOWED_ROOTS.join(", ")}`
    );
  }
}

async function resolveAllowedPath(inputPath, { forWrite = false } = {}) {
  const absolutePath = path.resolve(CWD, expandHome(inputPath));

  if (!forWrite) {
    const candidate = await realpath(absolutePath);
    assertAllowedRealPath(candidate);
    return candidate;
  }

  let existingAncestor = path.dirname(absolutePath);
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error("Could not find an existing parent directory.");
    }
    existingAncestor = parent;
  }

  assertAllowedRealPath(await realpath(existingAncestor));
  return absolutePath;
}

function requirePin(controlPin) {
  if (!CONFIG.controlPin || CONFIG.controlPin === "change-me-to-a-long-random-secret") {
    throw new Error("Set LOCAL_CONTROL_PIN to a strong value before using privileged tools.");
  }
  if (controlPin !== CONFIG.controlPin) {
    throw new Error("Invalid or missing control_pin.");
  }
}

function hasConfiguredControlPin() {
  return Boolean(CONFIG.controlPin && CONFIG.controlPin !== "change-me-to-a-long-random-secret");
}

function requireControlAuthorization(controlPin, authContext) {
  if (authContext?.scopes?.includes("local.control")) {
    return;
  }
  requirePin(controlPin);
}

function requireCapability(name, enabled, controlPin, authContext) {
  if (!enabled) {
    throw new Error(`Capability ${name} is disabled. Enable it in .env before using this tool.`);
  }
  requireControlAuthorization(controlPin, authContext);
}

function requireReadAuthorization() {
  return;
}

function truncateText(value, maxChars = CONFIG.maxCommandOutputChars) {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`,
    truncated: true,
  };
}

function asTextResult(structuredContent, message = undefined, extraContent = []) {
  const text = message ?? JSON.stringify(structuredContent, null, 2);
  return {
    content: [{ type: "text", text }, ...extraContent],
    structuredContent,
  };
}

function asError(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

async function audit(event) {
  await mkdir(AUDIT_DIR, { recursive: true });
  const entry = {
    time: new Date().toISOString(),
    ...event,
  };
  await appendFile(path.join(AUDIT_DIR, "events.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

function bearerTokenFromRequest(req) {
  const auth = req.headers.authorization ?? "";
  if (String(auth).toLowerCase().startsWith("bearer ")) {
    return String(auth).slice("bearer ".length).trim();
  }
  return "";
}

function secretKeyFromRequest(req, url) {
  const header = String(req.headers["x-secret-key"] ?? "").trim();
  if (header) return header;
  return (url?.searchParams.get("secret-key") ?? "").trim();
}

function authContextFromRequest(req, url) {
  if (SECRET_KEY && secretKeyFromRequest(req, url) === SECRET_KEY) {
    return { token: "secret-key", scopes: [...OAUTH_SCOPES] };
  }

  const token = bearerTokenFromRequest(req);
  const entry = token ? OAUTH_TOKENS.get(token) : undefined;
  if (!entry) {
    return { token: "", scopes: [] };
  }

  if (entry.expiresAt <= Date.now()) {
    OAUTH_TOKENS.delete(token);
    return { token: "", scopes: [] };
  }

  return {
    token,
    scopes: entry.scopes,
  };
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const escapes = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return escapes[char];
  });
}

async function readRequestText(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function publicOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  const host = forwardedHost || req.headers.host || `127.0.0.1:${PORT}`;
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host);
  const proto = forwardedProto || (isLocalHost ? "http" : "https");
  return `${proto}://${host}`;
}

function oauthMetadata(req) {
  const origin = publicOrigin(req);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    scopes_supported: OAUTH_SCOPES,
  };
}

function protectedResourceMetadata(req) {
  const origin = publicOrigin(req);
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [origin],
    scopes_supported: OAUTH_SCOPES,
    resource_documentation: "https://github.com/bhrum/chatgpt-local-control-mcp",
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, x-secret-key",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

// No securitySchemes in tool metadata: advertising mixed noauth/oauth2 makes
// ChatGPT attempt OAuth discovery and fail with "mixed auth". Auth is the
// secret key on the connector URL, verified per request.
function toolMeta(invoking, invoked) {
  return {
    "openai/visibility": "public",
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

async function listDirectoryRecursive(rootPath, depth, includeHidden, entries, basePath = rootPath) {
  if (entries.length >= CONFIG.maxDirectoryEntries) return;

  const dirEntries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of dirEntries) {
    if (entries.length >= CONFIG.maxDirectoryEntries) break;
    if (!includeHidden && entry.name.startsWith(".")) continue;

    const fullPath = path.join(rootPath, entry.name);
    const itemStat = await stat(fullPath);
    const item = {
      path: path.relative(basePath, fullPath) || ".",
      absolutePath: fullPath,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      size: itemStat.size,
      modifiedAt: itemStat.mtime.toISOString(),
    };
    entries.push(item);

    if (entry.isDirectory() && depth > 1) {
      await listDirectoryRecursive(fullPath, depth - 1, includeHidden, entries, basePath);
    }
  }
}

async function runCommand(argv, cwd, timeoutMs) {
  const executable = argv[0];
  if (!executable) throw new Error("command must include at least one executable name.");

  if (!CONFIG.allowUnsafeShell && !CONFIG.safeExecutables.has(path.basename(executable))) {
    throw new Error(
      `Executable "${executable}" is not in SAFE_EXECUTABLES. Temporarily set ALLOW_UNSAFE_SHELL=1 only if you trust this session.`
    );
  }

  const resolvedCwd = cwd ? await resolveAllowedPath(cwd) : CWD;
  const boundedTimeout = Math.min(Math.max(timeoutMs ?? CONFIG.commandTimeoutMs, 1_000), 120_000);

  const result = await execFileAsync(executable, argv.slice(1), {
    cwd: resolvedCwd,
    timeout: boundedTimeout,
    maxBuffer: Math.max(CONFIG.maxCommandOutputChars * 4, 1024 * 1024),
    env: {
      ...process.env,
      LOCAL_CONTROL_PIN: "",
    },
  });

  return {
    cwd: resolvedCwd,
    exitCode: 0,
    stdout: truncateText(result.stdout ?? ""),
    stderr: truncateText(result.stderr ?? ""),
  };
}

async function runCommandCapturingFailures(argv, cwd, timeoutMs) {
  try {
    return await runCommand(argv, cwd, timeoutMs);
  } catch (error) {
    if (typeof error === "object" && error && "stdout" in error && "stderr" in error) {
      return {
        cwd: cwd ?? CWD,
        exitCode: typeof error.code === "number" ? error.code : 1,
        stdout: truncateText(error.stdout ?? ""),
        stderr: truncateText(error.stderr ?? error.message ?? ""),
      };
    }
    throw error;
  }
}

async function execCheck(argv, cwd, timeoutMs) {
  try {
    const result = await execFileAsync(argv[0], argv.slice(1), {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LOCAL_CONTROL_PIN: "" },
    });
    return { exitCode: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    if (typeof error === "object" && error && "stdout" in error) {
      return {
        exitCode: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? String(error.message ?? ""),
      };
    }
    throw error;
  }
}

function parseTscDiagnostics(output) {
  const diagnostics = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([^:\s]+):\s+(.*)$/;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) {
      diagnostics.push({
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4],
        code: match[5],
        message: match[6],
        source: "tsc",
      });
    }
  }
  return diagnostics;
}

function parseEslintDiagnostics(text) {
  try {
    return JSON.parse(text).flatMap((fileResult) =>
      (fileResult.messages ?? []).map((message) => ({
        file: fileResult.filePath,
        line: message.line ?? 1,
        column: message.column ?? 1,
        severity: message.severity === 2 ? "error" : "warning",
        code: String(message.ruleId ?? ""),
        message: message.message,
        source: "eslint",
      }))
    );
  } catch {
    return [];
  }
}

function parseRuffDiagnostics(text) {
  try {
    return JSON.parse(text).map((item) => ({
      file: item.filename ?? "",
      line: item.location?.row ?? item.row ?? 1,
      column: item.location?.column ?? item.column ?? 1,
      severity: String(item.code ?? "").startsWith("E") ? "error" : "warning",
      code: String(item.code ?? ""),
      message: item.message ?? "",
      source: "ruff",
    }));
  } catch {
    return [];
  }
}

const MAX_CODE_DIAGNOSTICS = 200;

async function runCodeDiagnostics(projectPath, timeoutMs) {
  const checks = [];
  const diagnostics = [];

  async function runCheck(name, argv, parse) {
    try {
      const result = await execCheck(argv, projectPath, timeoutMs);
      const parsed = parse(result.stdout);
      checks.push({ name, ran: true, detail: `${parsed.length} finding(s), exit code ${result.exitCode}` });
      for (const item of parsed) {
        if (diagnostics.length >= MAX_CODE_DIAGNOSTICS) return;
        diagnostics.push(item);
      }
    } catch (error) {
      checks.push({ name, ran: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  const tscBin = path.join(projectPath, "node_modules", "typescript", "bin", "tsc");
  const eslintBin = path.join(projectPath, "node_modules", "eslint", "bin", "eslint.js");
  const hasPackageJson = existsSync(path.join(projectPath, "package.json"));

  if (hasPackageJson && existsSync(tscBin)) {
    await runCheck("tsc", ["node", tscBin, "--noEmit", "--pretty", "false"], parseTscDiagnostics);
  } else {
    checks.push({ name: "tsc", ran: false, detail: "TypeScript not installed in this project." });
  }

  if (existsSync(eslintBin)) {
    await runCheck("eslint", ["node", eslintBin, "-f", "json", "."], parseEslintDiagnostics);
  } else {
    checks.push({ name: "eslint", ran: false, detail: "ESLint not installed in this project." });
  }

  const hasRuffConfig =
    existsSync(path.join(projectPath, "ruff.toml")) ||
    existsSync(path.join(projectPath, ".ruff.toml")) ||
    existsSync(path.join(projectPath, "pyproject.toml"));

  if (hasRuffConfig) {
    await runCheck("ruff", ["python", "-m", "ruff", "check", "--output-format", "json", "."], parseRuffDiagnostics);
  } else {
    checks.push({ name: "ruff", ran: false, detail: "No ruff.toml or pyproject.toml found." });
  }

  return {
    path: projectPath,
    checks,
    diagnostics,
    truncated: diagnostics.length >= MAX_CODE_DIAGNOSTICS,
  };
}

async function runPowerShellScript(script, { timeoutMs = CONFIG.commandTimeoutMs, env = {}, sta = false } = {}) {
  if (PLATFORM !== "win32") {
    throw new Error("PowerShell desktop automation is only supported on Windows.");
  }

  const args = [
    ...(sta ? ["-STA"] : []),
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ];
  const result = await execFileAsync("powershell.exe", args, {
    timeout: Math.min(Math.max(timeoutMs, 1_000), 120_000),
    maxBuffer: Math.max(CONFIG.maxCommandOutputChars * 4, 1024 * 1024),
    env: {
      ...process.env,
      LOCAL_CONTROL_PIN: "",
      ...env,
    },
  });

  return {
    exitCode: 0,
    stdout: truncateText(result.stdout ?? ""),
    stderr: truncateText(result.stderr ?? ""),
  };
}

async function runPowerShellScriptCapturingFailures(script, timeoutMs) {
  try {
    return await runPowerShellScript(script, { timeoutMs });
  } catch (error) {
    if (typeof error === "object" && error && "stdout" in error && "stderr" in error) {
      return {
        exitCode: typeof error.code === "number" ? error.code : 1,
        stdout: truncateText(error.stdout ?? ""),
        stderr: truncateText(error.stderr ?? error.message ?? ""),
      };
    }
    throw error;
  }
}

async function runAppleScript(script, timeoutMs = CONFIG.commandTimeoutMs) {
  if (PLATFORM !== "darwin") {
    throw new Error("AppleScript automation is only supported on macOS.");
  }
  const lines = script.split("\n").flatMap((line) => ["-e", line]);
  const result = await execFileAsync("osascript", lines, {
    timeout: Math.min(Math.max(timeoutMs, 1_000), 60_000),
    maxBuffer: Math.max(CONFIG.maxCommandOutputChars * 4, 1024 * 1024),
  });
  return {
    exitCode: 0,
    stdout: truncateText(result.stdout ?? ""),
    stderr: truncateText(result.stderr ?? ""),
  };
}

async function captureScreenshot(screenshotPath) {
  if (PLATFORM === "darwin") {
    await execFileAsync("screencapture", ["-x", screenshotPath], { timeout: 15_000 });
    return;
  }

  if (PLATFORM === "win32") {
    await runPowerShellScript(
      `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$path = $env:LOCAL_CONTROL_SCREENSHOT_PATH
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
$bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`,
      {
        timeoutMs: 15_000,
        sta: true,
        env: { LOCAL_CONTROL_SCREENSHOT_PATH: screenshotPath },
      }
    );
    return;
  }

  throw new Error(`Screenshot capture is not implemented for ${PLATFORM}.`);
}

async function openTarget(target) {
  if (PLATFORM === "darwin") {
    const result = await execFileAsync("open", [expandHome(target)], { timeout: 15_000 });
    return {
      exitCode: 0,
      stdout: truncateText(result.stdout ?? ""),
      stderr: truncateText(result.stderr ?? ""),
    };
  }

  if (PLATFORM === "win32") {
    return await runPowerShellScript("Start-Process -FilePath $env:LOCAL_CONTROL_OPEN_TARGET", {
      timeoutMs: 15_000,
      env: { LOCAL_CONTROL_OPEN_TARGET: expandHome(target) },
    });
  }

  if (PLATFORM === "linux") {
    const result = await execFileAsync("xdg-open", [expandHome(target)], { timeout: 15_000 });
    return {
      exitCode: 0,
      stdout: truncateText(result.stdout ?? ""),
      stderr: truncateText(result.stderr ?? ""),
    };
  }

  throw new Error(`Opening targets is not implemented for ${PLATFORM}.`);
}

const WINDOWS_KEY_CODES = new Map(
  Object.entries({
    BACKSPACE: 0x08,
    TAB: 0x09,
    ENTER: 0x0d,
    RETURN: 0x0d,
    SHIFT: 0x10,
    CTRL: 0x11,
    CONTROL: 0x11,
    ALT: 0x12,
    PAUSE: 0x13,
    CAPSLOCK: 0x14,
    CAPS_LOCK: 0x14,
    ESC: 0x1b,
    ESCAPE: 0x1b,
    SPACE: 0x20,
    PAGEUP: 0x21,
    PAGE_UP: 0x21,
    PAGEDOWN: 0x22,
    PAGE_DOWN: 0x22,
    END: 0x23,
    HOME: 0x24,
    LEFT: 0x25,
    UP: 0x26,
    RIGHT: 0x27,
    DOWN: 0x28,
    PRINTSCREEN: 0x2c,
    PRINT_SCREEN: 0x2c,
    INSERT: 0x2d,
    INS: 0x2d,
    DELETE: 0x2e,
    DEL: 0x2e,
    WIN: 0x5b,
    WINDOWS: 0x5b,
    META: 0x5b,
    COMMAND: 0x5b,
    NUMLOCK: 0x90,
    NUM_LOCK: 0x90,
    SCROLLLOCK: 0x91,
    SCROLL_LOCK: 0x91,
  })
);

for (let index = 1; index <= 24; index += 1) {
  WINDOWS_KEY_CODES.set(`F${index}`, 0x6f + index);
}

function windowsKeyCode(key) {
  const normalized = String(key).trim().toUpperCase().replace(/\s+/g, "_");
  if (/^[A-Z]$/.test(normalized) || /^[0-9]$/.test(normalized)) {
    return normalized.charCodeAt(0);
  }
  if (WINDOWS_KEY_CODES.has(normalized)) {
    return WINDOWS_KEY_CODES.get(normalized);
  }
  throw new Error(`Unsupported Windows key "${key}". Use names like CTRL, ALT, WIN, ENTER, ESC, A, 1, or F5.`);
}

async function getWindowsCursorPosition() {
  const result = await runPowerShellScript(
    `
Add-Type -AssemblyName System.Windows.Forms
$position = [System.Windows.Forms.Cursor]::Position
Write-Output "$($position.X),$($position.Y)"
`,
    { timeoutMs: 5_000, sta: true }
  );
  const [x, y] = result.stdout.text.trim().split(",").map((value) => Number(value));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Could not read cursor position.");
  }
  return { x, y };
}

async function moveWindowsMouse(x, y) {
  await runPowerShellScript(
    `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$env:LOCAL_CONTROL_MOUSE_X, [int]$env:LOCAL_CONTROL_MOUSE_Y)
`,
    {
      timeoutMs: 5_000,
      sta: true,
      env: {
        LOCAL_CONTROL_MOUSE_X: String(x),
        LOCAL_CONTROL_MOUSE_Y: String(y),
      },
    }
  );
}

async function clickWindowsMouse(x, y, button, clicks) {
  const flags = {
    left: { down: 0x0002, up: 0x0004 },
    right: { down: 0x0008, up: 0x0010 },
    middle: { down: 0x0020, up: 0x0040 },
  }[button];

  await runPowerShellScript(
    `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class LocalControlMouse {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@
$x = [int]$env:LOCAL_CONTROL_MOUSE_X
$y = [int]$env:LOCAL_CONTROL_MOUSE_Y
$down = [uint32]$env:LOCAL_CONTROL_MOUSE_DOWN
$up = [uint32]$env:LOCAL_CONTROL_MOUSE_UP
$clicks = [int]$env:LOCAL_CONTROL_MOUSE_CLICKS
[LocalControlMouse]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 50
for ($i = 0; $i -lt $clicks; $i++) {
  [LocalControlMouse]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 35
  [LocalControlMouse]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 80
}
`,
    {
      timeoutMs: 10_000,
      env: {
        LOCAL_CONTROL_MOUSE_X: String(x),
        LOCAL_CONTROL_MOUSE_Y: String(y),
        LOCAL_CONTROL_MOUSE_DOWN: String(flags.down),
        LOCAL_CONTROL_MOUSE_UP: String(flags.up),
        LOCAL_CONTROL_MOUSE_CLICKS: String(clicks),
      },
    }
  );
}

async function pressWindowsKeys(keys, holdMs) {
  const codes = keys.map(windowsKeyCode);
  await runPowerShellScript(
    `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class LocalControlKeyboard {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
}
"@
$codes = $env:LOCAL_CONTROL_KEY_CODES -split "," | ForEach-Object { [byte]$_ }
$holdMs = [int]$env:LOCAL_CONTROL_KEY_HOLD_MS
foreach ($code in $codes) {
  [LocalControlKeyboard]::keybd_event($code, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 20
}
Start-Sleep -Milliseconds $holdMs
[array]::Reverse($codes)
foreach ($code in $codes) {
  [LocalControlKeyboard]::keybd_event($code, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 20
}
`,
    {
      timeoutMs: 10_000,
      env: {
        LOCAL_CONTROL_KEY_CODES: codes.join(","),
        LOCAL_CONTROL_KEY_HOLD_MS: String(holdMs),
      },
    }
  );
}

async function typeWindowsText(text, restoreClipboard) {
  if (Buffer.byteLength(text, "utf8") > 16_000) {
    throw new Error("type_text is limited to 16KB of UTF-8 text. Use write_file for larger content.");
  }

  await runPowerShellScript(
    `
Add-Type -AssemblyName System.Windows.Forms
$bytes = [Convert]::FromBase64String($env:LOCAL_CONTROL_TYPE_TEXT_B64)
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
$restore = $env:LOCAL_CONTROL_RESTORE_CLIPBOARD -eq "1"
$hadText = [System.Windows.Forms.Clipboard]::ContainsText()
$previousText = ""
if ($hadText) {
  $previousText = [System.Windows.Forms.Clipboard]::GetText()
}
[System.Windows.Forms.Clipboard]::SetText($text)
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 300
if ($restore -and $hadText) {
  [System.Windows.Forms.Clipboard]::SetText($previousText)
}
`,
    {
      timeoutMs: 15_000,
      sta: true,
      env: {
        LOCAL_CONTROL_TYPE_TEXT_B64: Buffer.from(text, "utf8").toString("base64"),
        LOCAL_CONTROL_RESTORE_CLIPBOARD: restoreClipboard ? "1" : "0",
      },
    }
  );
}

const TOOL_DESCRIPTORS = [
  {
    name: "computer_status",
    title: "Computer status",
    description: "Return basic status for this local computer MCP server, including allowed file roots and enabled capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: toolMeta("Checking computer control status", "Computer control status ready"),
  },
  {
    name: "code_diagnostics",
    title: "Code diagnostics",
    description:
      "Run the editor-style code checkers (tsc, ESLint, ruff) on a project folder and return structured diagnostics like a Problems panel: file, line, severity, code, message. Already fully authorized by this connection.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project folder to check. Relative paths resolve from server cwd." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false,
    },
    _meta: toolMeta("Checking project code diagnostics", "Code diagnostics ready"),
  },
  {
    name: "list_directory",
    title: "List directory",
    description: "List files and folders under LOCAL_CONTROL_ROOTS. Does not read file contents or modify anything.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list. Relative paths resolve from server cwd." },
        depth: { type: "integer", minimum: 1, maximum: 3, description: "Recursive depth, from 1 to 3." },
        includeHidden: { type: "boolean", description: "Include dotfiles and dotfolders." },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: toolMeta("Listing local directory", "Local directory listing ready"),
  },
  {
    name: "read_file",
    title: "Read file",
    description: "Read a UTF-8 or base64 file from LOCAL_CONTROL_ROOTS, bounded by MAX_READ_BYTES.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        maxBytes: { type: "integer", minimum: 1, maximum: 1048576 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: toolMeta("Reading local file", "Local file read"),
  },
  {
    name: "write_file",
    title: "Write file",
    description: "Create, overwrite, or append to a file under LOCAL_CONTROL_ROOTS. Already fully authorized by this connection — just call it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        content: { type: "string" },
        mode: { type: "string", enum: ["create", "overwrite", "append"] },
        control_pin: { type: "string", description: "Leave empty." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: false,
    },
    _meta: toolMeta("Writing local file", "Local file write finished", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "run_command",
    title: "Run command",
    description: "Run a local command without a shell. Already fully authorized by this connection — just call it.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Executable and arguments, for example ['git', 'status', '--short'].",
        },
        cwd: { type: "string", description: "Working directory. Must be inside LOCAL_CONTROL_ROOTS." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
        control_pin: { type: "string", description: "Leave empty." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    },
    _meta: toolMeta("Running local command", "Local command finished", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "take_screenshot",
    title: "Take screenshot",
    description: "Capture the local screen and return it as an MCP image. Already fully authorized by this connection — just call it.",
    inputSchema: {
      type: "object",
      properties: {
        control_pin: { type: "string", description: "Leave empty." },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false,
    },
    _meta: toolMeta("Taking screenshot", "Screenshot ready", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "open_target",
    title: "Open target",
    description: "Open a URL, file, folder, or app on the local computer. Already fully authorized by this connection — just call it.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", minLength: 1, description: "A URL, file path, folder path, or app name/path." },
        control_pin: { type: "string", description: "Leave empty." },
      },
      required: ["target"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: false,
    },
    _meta: toolMeta("Opening local target", "Local target opened", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "run_applescript",
    title: "Run AppleScript",
    description: "Run AppleScript for GUI automation. Already fully authorized by this connection — just call it.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 60000 },
        control_pin: { type: "string", description: "Leave empty." },
      },
      required: ["script"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    },
    _meta: toolMeta("Running AppleScript", "AppleScript finished", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "run_powershell",
    title: "Run PowerShell",
    description:
      "Run a Windows PowerShell script. Requires ALLOW_SHELL=1 and ALLOW_UNSAFE_SHELL=1 in .env; already fully authorized by this connection.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", minLength: 1 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
        control_pin: { type: "string", description: "Leave empty." },
      },
      required: ["script"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    },
    _meta: toolMeta("Running PowerShell", "PowerShell finished", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "get_cursor_position",
    title: "Get cursor position",
    description:
      "Return the current Windows mouse cursor coordinates. Requires ALLOW_GUI=1 in .env; already fully authorized by this connection.",
    inputSchema: {
      type: "object",
      properties: {
        control_pin: { type: "string", description: "Leave empty." },
      },
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    _meta: toolMeta("Reading cursor position", "Cursor position ready", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "move_mouse",
    title: "Move mouse",
    description:
      "Move the Windows mouse cursor to screen coordinates. Requires ALLOW_GUI=1 in .env; already fully authorized by this connection.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: -32768, maximum: 32767 },
        y: { type: "integer", minimum: -32768, maximum: 32767 },
        control_pin: { type: "string", description: "Leave empty." },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false,
    },
    _meta: toolMeta("Moving mouse", "Mouse moved", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "mouse_click",
    title: "Mouse click",
    description:
      "Click Windows screen coordinates with the selected mouse button. Requires ALLOW_GUI=1 in .env; already fully authorized by this connection.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "integer", minimum: -32768, maximum: 32767 },
        y: { type: "integer", minimum: -32768, maximum: 32767 },
        button: { type: "string", enum: ["left", "right", "middle"] },
        clicks: { type: "integer", minimum: 1, maximum: 3 },
        control_pin: { type: "string", description: "Leave empty." },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: false,
    },
    _meta: toolMeta("Clicking mouse", "Mouse click finished", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "press_keys",
    title: "Press keys",
    description:
      "Press a Windows keyboard chord such as ['CTRL','L'], ['ALT','TAB'], or ['WIN','R']. Requires ALLOW_GUI=1 in .env; already fully authorized by this connection.",
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "array", items: { type: "string" }, minItems: 1 },
        holdMs: { type: "integer", minimum: 10, maximum: 2000 },
        control_pin: { type: "string", description: "Leave empty." },
      },
      required: ["keys"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    },
    _meta: toolMeta("Pressing keys", "Key press finished", CONTROL_SECURITY_SCHEMES),
  },
  {
    name: "type_text",
    title: "Type text",
    description:
      "Paste text into the active Windows application using the clipboard. Requires ALLOW_GUI=1 in .env; already fully authorized by this connection.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        restoreClipboard: { type: "boolean" },
        control_pin: { type: "string", description: "Leave empty." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
      idempotentHint: false,
    },
    _meta: toolMeta("Typing text", "Text typed", CONTROL_SECURITY_SCHEMES),
  },
];

const GUIDE_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "GUIDE.md");

function loadGuideHints() {
  // 用户可在项目根目录放 GUIDE.md 自定义引导（每行一条），每次调用实时读取，无需重启
  try {
    return readFileSync(GUIDE_FILE, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && !line.startsWith(">"))
      .map((line) => (line.startsWith("- ") ? line.slice(2) : line))
      .slice(0, 12);
  } catch {
    return [];
  }
}

function createLocalControlServer(authContext = { scopes: [] }) {
  const server = new McpServer({
    name: "chatgpt-local-control",
    version: "0.1.0",
    instructions:
      `Use these tools to inspect and control the user's ${platformLabel()} only when the user explicitly asks. All tools are fully authorized by this connection. Never ask the user for additional credentials, keys, PINs, or verification steps — just call the tools.

Working practices:
- FIRST STEP after connecting: call computer_status — it may include user-customized guidance lines marked [用户自定义]; follow those first when present. — it returns hints (suggested first reads, platform notes, reusable-script guidance) tailored to this machine.
- Missing tool or "unknown tool" error means that capability is disabled in server config, not a connection problem. Call computer_status, tell the user which ALLOW_* flag in the server's .env enables it (writes=ALLOW_WRITES, shell=ALLOW_SHELL (+ALLOW_UNSAFE_SHELL for arbitrary commands), screenshot=ALLOW_SCREENSHOT, open=ALLOW_OPEN, applescript=ALLOW_APPLESCRIPT, gui=ALLOW_GUI), and have them edit .env then restart. If tools/list is empty or the endpoint is unreachable, the connector URL is wrong or missing ?secret-key=; ask the user for the exact URL instead of retrying blindly.
- For complex or repeated operations, do not repeat long one-liners. Write a reusable script once into a folder under an allowed root (for example write_file to scripts/run-task.sh, remember to chmod +x via run_command) and afterwards invoke it with run_command and short arguments.
- Command output is truncated around 100k characters. Prefer narrowing with head/tail/grep/wc, or write full output to a file and read it back in chunks with read_file.
- run_command accepts timeoutMs up to 120000 for slow builds or installs; pass it instead of letting the 15s default kill the job.
- On macOS, GUI automation goes through run_applescript; move_mouse/mouse_click/press_keys/type_text/get_cursor_position are Windows-only.`,
  });

  server.registerTool(
    "computer_status",
    {
      title: "Computer status",
      description:
        "Return basic status for this local computer MCP server, including allowed file roots and enabled capabilities.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        hostname: z.string(),
        platform: z.string(),
        arch: z.string(),
        cwd: z.string(),
        allowedRoots: z.array(z.string()),
        capabilities: z.record(z.boolean()),
        hints: z.array(z.string()),
        uptimeSeconds: z.number(),
        startedAt: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: toolMeta("Checking computer control status", "Computer control status ready"),
    },
    async () => {
      try {
        requireReadAuthorization();
        return asTextResult({
        ok: true,
        hostname: os.hostname(),
        platform: PLATFORM,
        arch: os.arch(),
        cwd: CWD,
        allowedRoots: ALLOWED_ROOTS,
        capabilities: {
          writes: CONFIG.allowWrites,
          shell: CONFIG.allowShell,
          unsafeShell: CONFIG.allowUnsafeShell,
          screenshot: CONFIG.allowScreenshot,
          open: CONFIG.allowOpen,
          appleScript: CONFIG.allowAppleScript,
          gui: CONFIG.allowGui,
          powerShell: PLATFORM === "win32",
          readToolsRequireAuth: QUICK_TUNNEL,
          oauth: !QUICK_TUNNEL,
          oauthApprovalPinRequired: CONFIG.requireOAuthApprovalPin && hasConfiguredControlPin(),
          pinFallbackForControl: hasConfiguredControlPin(),
        },
        hints: [
          ...loadGuideHints().map((line) => `[用户自定义] ${line}`),
          "首次使用：先 read_file 查看 LOCAL_CONTROL_ROOTS 内的关键目录或项目 README，再动手改东西。",
          "文件都在 allowedRoots 内才能访问；需要更多目录时让用户修改 .env 的 LOCAL_CONTROL_ROOTS 并重启服务。",
          PLATFORM === "darwin"
            ? "GUI 自动化用 run_applescript；截屏与按键控制需要用户在系统设置里授予屏幕录制/辅助功能权限。"
            : "GUI 自动化用 move_mouse/mouse_click/press_keys/type_text（Windows 专用）。",
          "重复或复杂操作：先 write_file 写成可复用脚本（如 scripts/run-task.sh），chmod +x 后用 run_command 短参数调用。",
          "run_command 可传 timeoutMs（最高 120000）；输出超过上限会被截断，建议配合 head/tail/grep 或落盘后 read_file 分段读取。",
        ],
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: STARTED_AT.toISOString(),
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "code_diagnostics",
    {
      title: "Code diagnostics",
      description:
        "Run the editor-style code checkers (tsc, ESLint, ruff) on a project folder and return structured diagnostics like a Problems panel: file, line, severity, code, message.",
      inputSchema: {
        path: z.string().optional().describe("Project folder to check. Defaults to the server working directory."),
        timeoutMs: z.number().int().min(1000).max(120000).optional().describe("Per-checker timeout. Default 60000."),
      },
      outputSchema: {
        path: z.string(),
        checks: z.array(z.object({ name: z.string(), ran: z.boolean(), detail: z.string() })),
        diagnostics: z.array(
          z.object({
            file: z.string(),
            line: z.number(),
            column: z.number(),
            severity: z.string(),
            code: z.string(),
            message: z.string(),
            source: z.string(),
          })
        ),
        truncated: z.boolean(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: toolMeta("Checking project code diagnostics", "Code diagnostics ready"),
    },
    async ({ path: requestedPath = ".", timeoutMs }) => {
      try {
        requireControlAuthorization(undefined, authContext);
        const projectPath = await resolveAllowedPath(requestedPath);
        const projectStat = await stat(projectPath);
        if (!projectStat.isDirectory()) throw new Error("path must be a directory.");

        const result = await runCodeDiagnostics(
          projectPath,
          Math.min(Math.max(timeoutMs ?? 60_000, 1_000), 120_000)
        );
        await audit({ tool: "code_diagnostics", path: projectPath, findings: result.diagnostics.length });
        return asTextResult(result);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description:
        "List files and folders under LOCAL_CONTROL_ROOTS. Does not read file contents or modify anything.",
      inputSchema: {
        path: z.string().optional().describe("Directory to list. Relative paths resolve from server cwd."),
        depth: z.number().int().min(1).max(3).optional().describe("Recursive depth, from 1 to 3."),
        includeHidden: z.boolean().optional().describe("Include dotfiles and dotfolders."),
      },
      outputSchema: {
        root: z.string(),
        entries: z.array(
          z.object({
            path: z.string(),
            absolutePath: z.string(),
            type: z.string(),
            size: z.number(),
            modifiedAt: z.string(),
          })
        ),
        truncated: z.boolean(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: toolMeta("Listing local directory", "Local directory listing ready"),
    },
    async ({ path: requestedPath = ".", depth = 1, includeHidden = false }) => {
      try {
        requireReadAuthorization();
        const root = await resolveAllowedPath(requestedPath);
        const rootStat = await stat(root);
        if (!rootStat.isDirectory()) throw new Error("path must be a directory.");

        const entries = [];
        await listDirectoryRecursive(root, depth, includeHidden, entries);
        return asTextResult({
          root,
          entries,
          truncated: entries.length >= CONFIG.maxDirectoryEntries,
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a UTF-8 or base64 file from LOCAL_CONTROL_ROOTS, bounded by MAX_READ_BYTES.",
      inputSchema: {
        path: z.string().min(1),
        encoding: z.enum(["utf8", "base64"]).optional(),
        maxBytes: z.number().int().min(1).max(1_048_576).optional(),
      },
      outputSchema: {
        path: z.string(),
        encoding: z.string(),
        size: z.number(),
        bytesRead: z.number(),
        truncated: z.boolean(),
        content: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: toolMeta("Reading local file", "Local file read"),
    },
    async ({ path: requestedPath, encoding = "utf8", maxBytes }) => {
      try {
        requireReadAuthorization();
        const filePath = await resolveAllowedPath(requestedPath);
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) throw new Error("path must be a file.");

        const limit = Math.min(maxBytes ?? CONFIG.maxReadBytes, CONFIG.maxReadBytes);
        const buffer = await readFile(filePath);
        const slice = buffer.subarray(0, limit);
        const content = encoding === "base64" ? slice.toString("base64") : slice.toString("utf8");

        await audit({
          tool: "read_file",
          path: filePath,
          bytesRead: slice.length,
          truncated: fileStat.size > slice.length,
        });
        return asTextResult({
          path: filePath,
          encoding,
          size: fileStat.size,
          bytesRead: slice.length,
          truncated: fileStat.size > slice.length,
          content,
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "write_file",
    {
      title: "Write file",
      description:
        "Create, overwrite, or append to a file under LOCAL_CONTROL_ROOTS. Requires ALLOW_WRITES=1; already fully authorized by this connection.",
      inputSchema: {
        path: z.string().min(1),
        content: z.string(),
        mode: z.enum(["create", "overwrite", "append"]).optional(),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        path: z.string(),
        mode: z.string(),
        bytesWritten: z.number(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: toolMeta("Writing local file", "Local file write finished", CONTROL_SECURITY_SCHEMES),
    },
    async ({ path: requestedPath, content, mode = "create", control_pin }) => {
      try {
        requireCapability("writes", CONFIG.allowWrites, control_pin, authContext);
        const filePath = await resolveAllowedPath(requestedPath, { forWrite: true });

        if (mode === "create" && existsSync(filePath)) {
          throw new Error("Refusing to create because file already exists. Use mode=overwrite or append.");
        }

        await mkdir(path.dirname(filePath), { recursive: true });
        if (mode === "append") {
          await appendFile(filePath, content, "utf8");
        } else {
          await writeFile(filePath, content, { encoding: "utf8", flag: mode === "create" ? "wx" : "w" });
        }

        await audit({ tool: "write_file", path: filePath, mode, bytesWritten: Buffer.byteLength(content) });
        return asTextResult({
          path: filePath,
          mode,
          bytesWritten: Buffer.byteLength(content),
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "run_command",
    {
      title: "Run command",
      description:
        "Run a local command without a shell. Requires ALLOW_SHELL=1; already fully authorized by this connection. Uses SAFE_EXECUTABLES unless ALLOW_UNSAFE_SHELL=1.",
      inputSchema: {
        command: z.array(z.string()).min(1).describe("Executable and arguments, for example ['git', 'status', '--short']."),
        cwd: z.string().optional().describe("Working directory. Must be inside LOCAL_CONTROL_ROOTS."),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        cwd: z.string(),
        exitCode: z.number(),
        stdout: z.object({ text: z.string(), truncated: z.boolean() }),
        stderr: z.object({ text: z.string(), truncated: z.boolean() }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
      _meta: toolMeta("Running local command", "Local command finished", CONTROL_SECURITY_SCHEMES),
    },
    async ({ command, cwd, timeoutMs, control_pin }) => {
      try {
        requireCapability("shell", CONFIG.allowShell, control_pin, authContext);
        const result = await runCommandCapturingFailures(command, cwd, timeoutMs);
        await audit({ tool: "run_command", command, cwd: result.cwd, exitCode: result.exitCode });
        return asTextResult(result);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "take_screenshot",
    {
      title: "Take screenshot",
      description:
        "Capture the local screen and return it as an MCP image. Requires ALLOW_SCREENSHOT=1; already fully authorized by this connection.",
      inputSchema: {
        control_pin: z.string().optional(),
      },
      outputSchema: {
        path: z.string(),
        mimeType: z.string(),
        size: z.number(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: toolMeta("Taking screenshot", "Screenshot ready", CONTROL_SECURITY_SCHEMES),
    },
    async ({ control_pin }) => {
      try {
        requireCapability("screenshot", CONFIG.allowScreenshot, control_pin, authContext);
        await mkdir(path.join(ARTIFACT_DIR, "screenshots"), { recursive: true });
        const screenshotPath = path.join(
          ARTIFACT_DIR,
          "screenshots",
          `screen-${new Date().toISOString().replace(/[:.]/g, "-")}.png`
        );
        await captureScreenshot(screenshotPath);
        const image = await readFile(screenshotPath);
        const structured = {
          path: screenshotPath,
          mimeType: "image/png",
          size: image.length,
        };
        await audit({ tool: "take_screenshot", path: screenshotPath, size: image.length });
        return asTextResult(structured, `Screenshot captured: ${screenshotPath}`, [
          { type: "image", data: image.toString("base64"), mimeType: "image/png" },
        ]);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "open_target",
    {
      title: "Open target",
      description:
        "Open a URL, file, folder, or app on the local computer. Requires ALLOW_OPEN=1; already fully authorized by this connection.",
      inputSchema: {
        target: z.string().min(1).describe("A URL, file path, folder path, or app name/path."),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        target: z.string(),
        exitCode: z.number(),
        stdout: z.object({ text: z.string(), truncated: z.boolean() }),
        stderr: z.object({ text: z.string(), truncated: z.boolean() }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
      _meta: toolMeta("Opening local target", "Local target opened", CONTROL_SECURITY_SCHEMES),
    },
    async ({ target, control_pin }) => {
      try {
        requireCapability("open", CONFIG.allowOpen, control_pin, authContext);
        const result = await openTarget(target);
        await audit({ tool: "open_target", target });
        return asTextResult({
          target,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "run_applescript",
    {
      title: "Run AppleScript",
      description:
        "Run AppleScript for GUI automation. Requires ALLOW_APPLESCRIPT=1; already fully authorized by this connection.",
      inputSchema: {
        script: z.string().min(1),
        timeoutMs: z.number().int().min(1000).max(60000).optional(),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        exitCode: z.number(),
        stdout: z.object({ text: z.string(), truncated: z.boolean() }),
        stderr: z.object({ text: z.string(), truncated: z.boolean() }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
      _meta: toolMeta("Running AppleScript", "AppleScript finished", CONTROL_SECURITY_SCHEMES),
    },
    async ({ script, timeoutMs, control_pin }) => {
      try {
        requireCapability("appleScript", CONFIG.allowAppleScript, control_pin, authContext);
        const result = await runAppleScript(script, timeoutMs);
        await audit({ tool: "run_applescript", scriptPreview: script.slice(0, 500), exitCode: result.exitCode });
        return asTextResult(result);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "run_powershell",
    {
      title: "Run PowerShell",
      description:
        "Run a Windows PowerShell script. Requires ALLOW_SHELL=1 and ALLOW_UNSAFE_SHELL=1 in .env; already fully authorized by this connection.",
      inputSchema: {
        script: z.string().min(1),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        exitCode: z.number(),
        stdout: z.object({ text: z.string(), truncated: z.boolean() }),
        stderr: z.object({ text: z.string(), truncated: z.boolean() }),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
      _meta: toolMeta("Running PowerShell", "PowerShell finished", CONTROL_SECURITY_SCHEMES),
    },
    async ({ script, timeoutMs, control_pin }) => {
      try {
        requireCapability("shell", CONFIG.allowShell, control_pin, authContext);
        if (!CONFIG.allowUnsafeShell) {
          throw new Error("run_powershell requires ALLOW_UNSAFE_SHELL=1 because scripts can perform arbitrary actions.");
        }
        const result = await runPowerShellScriptCapturingFailures(script, timeoutMs);
        await audit({ tool: "run_powershell", scriptPreview: script.slice(0, 500), exitCode: result.exitCode });
        return asTextResult(result);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "get_cursor_position",
    {
      title: "Get cursor position",
      description:
        "Return the current Windows mouse cursor coordinates. Requires ALLOW_GUI=1 in .env; already fully authorized by this connection.",
      inputSchema: {
        control_pin: z.string().optional(),
      },
      outputSchema: {
        x: z.number(),
        y: z.number(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      _meta: toolMeta("Reading cursor position", "Cursor position ready", CONTROL_SECURITY_SCHEMES),
    },
    async ({ control_pin }) => {
      try {
        requireCapability("gui", CONFIG.allowGui, control_pin, authContext);
        if (PLATFORM !== "win32") throw new Error("Cursor position is only implemented for Windows.");
        const position = await getWindowsCursorPosition();
        await audit({ tool: "get_cursor_position", ...position });
        return asTextResult(position);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "move_mouse",
    {
      title: "Move mouse",
      description:
        "Move the Windows mouse cursor to screen coordinates. Requires ALLOW_GUI=1 in .env; already fully authorized by this connection.",
      inputSchema: {
        x: z.number().int().min(-32768).max(32767),
        y: z.number().int().min(-32768).max(32767),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        x: z.number(),
        y: z.number(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: toolMeta("Moving mouse", "Mouse moved", CONTROL_SECURITY_SCHEMES),
    },
    async ({ x, y, control_pin }) => {
      try {
        requireCapability("gui", CONFIG.allowGui, control_pin, authContext);
        if (PLATFORM !== "win32") throw new Error("Mouse movement is only implemented for Windows.");
        await moveWindowsMouse(x, y);
        await audit({ tool: "move_mouse", x, y });
        return asTextResult({ x, y });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "mouse_click",
    {
      title: "Mouse click",
      description:
        "Click Windows screen coordinates with the selected mouse button. Requires ALLOW_GUI=1 in .env; already fully authorized by this connection.",
      inputSchema: {
        x: z.number().int().min(-32768).max(32767),
        y: z.number().int().min(-32768).max(32767),
        button: z.enum(["left", "right", "middle"]).optional(),
        clicks: z.number().int().min(1).max(3).optional(),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        x: z.number(),
        y: z.number(),
        button: z.string(),
        clicks: z.number(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false,
      },
      _meta: toolMeta("Clicking mouse", "Mouse click finished", CONTROL_SECURITY_SCHEMES),
    },
    async ({ x, y, button = "left", clicks = 1, control_pin }) => {
      try {
        requireCapability("gui", CONFIG.allowGui, control_pin, authContext);
        if (PLATFORM !== "win32") throw new Error("Mouse clicks are only implemented for Windows.");
        await clickWindowsMouse(x, y, button, clicks);
        await audit({ tool: "mouse_click", x, y, button, clicks });
        return asTextResult({ x, y, button, clicks });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "press_keys",
    {
      title: "Press keys",
      description:
        "Press a Windows keyboard chord such as ['CTRL','L'], ['ALT','TAB'], or ['WIN','R']. Requires ALLOW_GUI=1 in .env; already fully authorized by this connection.",
      inputSchema: {
        keys: z.array(z.string()).min(1),
        holdMs: z.number().int().min(10).max(2000).optional(),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        keys: z.array(z.string()),
        holdMs: z.number(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
      _meta: toolMeta("Pressing keys", "Key press finished", CONTROL_SECURITY_SCHEMES),
    },
    async ({ keys, holdMs = 80, control_pin }) => {
      try {
        requireCapability("gui", CONFIG.allowGui, control_pin, authContext);
        if (PLATFORM !== "win32") throw new Error("Keyboard input is only implemented for Windows.");
        await pressWindowsKeys(keys, holdMs);
        await audit({ tool: "press_keys", keys, holdMs });
        return asTextResult({ keys, holdMs });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description:
        "Paste text into the active Windows application using the clipboard. Requires ALLOW_GUI=1 in .env; already fully authorized by this connection.",
      inputSchema: {
        text: z.string(),
        restoreClipboard: z.boolean().optional(),
        control_pin: z.string().optional(),
      },
      outputSchema: {
        bytesTyped: z.number(),
        restoreClipboard: z.boolean(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
      _meta: toolMeta("Typing text", "Text typed", CONTROL_SECURITY_SCHEMES),
    },
    async ({ text, restoreClipboard = true, control_pin }) => {
      try {
        requireCapability("gui", CONFIG.allowGui, control_pin, authContext);
        if (PLATFORM !== "win32") throw new Error("Text input is only implemented for Windows.");
        await typeWindowsText(text, restoreClipboard);
        const bytesTyped = Buffer.byteLength(text, "utf8");
        await audit({ tool: "type_text", bytesTyped, restoreClipboard });
        return asTextResult({ bytesTyped, restoreClipboard });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS,
  }));

  return server;
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...corsHeaders(), ...headers });
  res.end(JSON.stringify(body, null, 2));
}

async function handleOAuthRegister(req, res) {
  let body = {};
  try {
    const text = await readRequestText(req);
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  sendJson(res, 201, {
    client_id: body.client_id || `chatgpt-${randomToken(12)}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: body.redirect_uris || [],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  });
}

function renderAuthorizePage(res, params, error = "") {
  const hidden = Object.entries(params)
    .filter(([key]) => key !== "approve" && key !== "approval_pin")
    .map(([key, value]) => `<input type="hidden" name="${htmlEscape(key)}" value="${htmlEscape(value)}">`)
    .join("\n");
  const pinField = CONFIG.requireOAuthApprovalPin && hasConfiguredControlPin()
    ? `<label style="display:block;margin:16px 0 8px;">Authorization PIN</label>
      <input name="approval_pin" type="password" autocomplete="current-password" required style="font:inherit;width:100%;box-sizing:border-box;padding:10px 12px;">`
    : "";
  const errorMarkup = error ? `<p style="color:#b00020;">${htmlEscape(error)}</p>` : "";

  res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...corsHeaders() });
  const label = platformLabel();

  res.end(`<!doctype html>
<html>
  <head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Local Computer Control</title></head>
  <body style="font-family: system-ui, sans-serif; max-width: 620px; margin: 48px auto; line-height: 1.5;">
    <h1>Authorize Local Computer Control</h1>
    <p>This grants ChatGPT permission to use local control tools on this ${htmlEscape(label)}, such as writing files, running commands, taking screenshots, opening targets, and desktop automation. Read-only file tools do not require authorization.</p>
    ${errorMarkup}
    <form method="get" action="/oauth/authorize">
      ${hidden}
      <input type="hidden" name="approve" value="1">
      ${pinField}
      <button style="font: inherit; margin-top: 16px; padding: 10px 16px;">Authorize</button>
    </form>
  </body>
</html>`);
}

function handleOAuthAuthorize(req, res, url) {
  const params = Object.fromEntries(url.searchParams.entries());
  const required = ["client_id", "redirect_uri", "response_type", "state"];
  const missing = required.filter((name) => !params[name]);
  if (missing.length || params.response_type !== "code") {
    sendJson(res, 400, { error: "invalid_request", error_description: `Missing or invalid: ${missing.join(", ")}` });
    return;
  }

  if (url.searchParams.get("approve") !== "1") {
    renderAuthorizePage(res, params);
    return;
  }

  if (CONFIG.requireOAuthApprovalPin && hasConfiguredControlPin()) {
    try {
      requirePin(url.searchParams.get("approval_pin") || "");
    } catch {
      renderAuthorizePage(res, params, "Invalid authorization PIN.");
      return;
    }
  }

  const requestedScopes = (params.scope || OAUTH_SCOPES.join(" ")).split(/\s+/).filter(Boolean);
  const scopes = requestedScopes.filter((scope) => OAUTH_SCOPES.includes(scope));
  const code = randomToken(24);
  OAUTH_CODES.set(code, {
    clientId: params.client_id,
    redirectUri: params.redirect_uri,
    codeChallenge: params.code_challenge,
    codeChallengeMethod: params.code_challenge_method,
    scopes: scopes.length ? scopes : OAUTH_SCOPES,
    expiresAt: Date.now() + OAUTH_CODE_TTL_MS,
  });

  const redirectUrl = new URL(params.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  redirectUrl.searchParams.set("state", params.state);
  res.writeHead(302, { location: redirectUrl.href, ...corsHeaders() });
  res.end();
}

async function handleOAuthToken(req, res) {
  const text = await readRequestText(req);
  const params = new URLSearchParams(text);
  const grantType = params.get("grant_type");

  if (grantType !== "authorization_code") {
    sendJson(res, 400, { error: "unsupported_grant_type" });
    return;
  }

  const code = params.get("code") || "";
  const entry = OAUTH_CODES.get(code);
  if (!entry || entry.expiresAt <= Date.now()) {
    OAUTH_CODES.delete(code);
    sendJson(res, 400, { error: "invalid_grant" });
    return;
  }

  if (params.get("redirect_uri") !== entry.redirectUri) {
    sendJson(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch." });
    return;
  }

  const verifier = params.get("code_verifier") || "";
  if (entry.codeChallengeMethod === "S256" && entry.codeChallenge && pkceChallenge(verifier) !== entry.codeChallenge) {
    sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed." });
    return;
  }

  OAUTH_CODES.delete(code);
  const accessToken = randomToken(32);
  OAUTH_TOKENS.set(accessToken, {
    scopes: Array.from(new Set(entry.scopes)),
    expiresAt: Date.now() + CONFIG.oauthTokenTtlSeconds * 1000,
  });

  sendJson(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: CONFIG.oauthTokenTtlSeconds,
    scope: entry.scopes.join(" "),
  });
}

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end("Missing URL");
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${PORT}`}`);
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);

  if (
    req.method === "OPTIONS" &&
    (url.pathname.startsWith(MCP_PATH) || url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/"))
  ) {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (QUICK_TUNNEL && url.pathname !== "/health" && secretKeyFromRequest(req, url) !== SECRET_KEY) {
    sendJson(res, 401, { error: "A valid secret key is required in Cloudflare quick tunnel mode." });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    sendJson(res, 200, {
      name: "chatgpt-local-control-mcp",
      ok: true,
      mcp: MCP_PATH,
      allowedRoots: ALLOWED_ROOTS,
      capabilities: {
        writes: CONFIG.allowWrites,
        shell: CONFIG.allowShell,
        screenshot: CONFIG.allowScreenshot,
        open: CONFIG.allowOpen,
        appleScript: CONFIG.allowAppleScript,
        gui: CONFIG.allowGui,
        powerShell: PLATFORM === "win32",
        readToolsRequireAuth: QUICK_TUNNEL,
        oauth: !QUICK_TUNNEL,
        pinFallbackForControl: hasConfiguredControlPin(),
      },
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      name: "chatgpt-local-control-mcp",
      mcpPath: MCP_PATH,
      ...(QUICK_TUNNEL ? {} : { allowedRoots: ALLOWED_ROOTS }),
      quickTunnelProtected: QUICK_TUNNEL,
      oauth: !QUICK_TUNNEL,
    });
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-protected-resource" ||
      url.pathname === `/.well-known/oauth-protected-resource${MCP_PATH}`)
  ) {
    sendJson(res, 200, protectedResourceMetadata(req));
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/openid-configuration")
  ) {
    sendJson(res, 200, oauthMetadata(req));
    return;
  }

  if (req.method === "POST" && url.pathname === "/oauth/register") {
    await handleOAuthRegister(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    handleOAuthAuthorize(req, res, url);
    return;
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    await handleOAuthToken(req, res);
    return;
  }

  const allowedMcpMethods = new Set(["POST", "GET", "DELETE"]);
  if (url.pathname === MCP_PATH && req.method && allowedMcpMethods.has(req.method)) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    const server = createLocalControlServer(authContextFromRequest(req, url));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
    return;
  }

  res.writeHead(404).end("Not Found");
});

httpServer.listen(PORT, HOST, () => {
  console.log(`Local control MCP listening on http://${HOST}:${PORT}${MCP_PATH}`);
  console.log(`Allowed roots: ${ALLOWED_ROOTS.join(", ") || "(none)"}`);
  if (HOST === "0.0.0.0" || HOST === "::" || HOST === "") {
    console.log("Warning: HOST is open to all network interfaces. Make sure a secret key is required.");
  }
  if (PUBLIC_MCP_URL && !QUICK_TUNNEL) {
    const separator = PUBLIC_MCP_URL.includes("?") ? "&" : "?";
    console.log(`ChatGPT connector URL: ${PUBLIC_MCP_URL}${separator}secret-key=${SECRET_KEY}`);
  } else {
    console.log("Use an HTTPS tunnel for ChatGPT connector setup.");
  }
  console.log(`Secret key: ${SECRET_KEY} (grants full control via ?secret-key= or x-secret-key header)`);
});

export { httpServer, SECRET_KEY };
