#!/usr/bin/env node
// Interactive first-run configuration wizard. Writes .env next to the project
// root, then the server boots with the generated configuration.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { v4 as uuidv4 } from "uuid";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT_DIR, ".env");
const FORCE = process.argv.includes("--force");

const SAFE_EXECUTABLES_DEFAULT =
  "pwd,ls,find,cat,head,tail,wc,du,df,ps,whoami,hostname,git,git.exe,node,node.exe,npm,npm.cmd,npx,npx.cmd,python,python.exe,python3,python3.exe,rg,rg.exe,sed,where,where.exe,ipconfig,tasklist";

function parseEnvFile(filePath) {
  const values = {};
  if (!existsSync(filePath)) return values;
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !line.trim().startsWith("#")) values[match[1]] = match[2].trim();
  }
  return values;
}

const existing = parseEnvFile(ENV_FILE);

if (existsSync(ENV_FILE) && !FORCE) {
  console.log("已检测到 .env,跳过配置向导。需要重新配置请运行 npm run setup。");
  process.exit(0);
}

const rl = createInterface({ input: stdin, output: stdout });

let inputClosed = false;
const closedPromise = new Promise((resolve) => rl.once("close", resolve));

async function askRaw(prompt) {
  if (inputClosed) return "";
  try {
    return await Promise.race([rl.question(prompt), closedPromise.then(() => "")]);
  } catch {
    return "";
  }
}

async function ask(question, fallback = "") {
  const suffix = fallback ? ` (回车 = ${fallback})` : "";
  const answer = (await askRaw(`${question}${suffix}: `)).trim();
  return answer || fallback;
}

async function askBoolean(question, fallbackYes) {
  const hint = fallbackYes ? "Y/n" : "y/N";
  for (;;) {
    const answer = (await askRaw(`${question} (${hint}): `)).trim().toLowerCase();
    if (inputClosed) return fallbackYes;
    if (!answer) return fallbackYes;
    if (["y", "yes", "1"].includes(answer)) return true;
    if (["n", "no", "0"].includes(answer)) return false;
    console.log("请输入 y 或 n。");
  }
}

console.log("");
console.log("=== ChatGPT Local Control MCP 配置向导 ===");
console.log("");
console.log("一键快速开启: 目录 = 当前用户主目录, 开启全部高权限能力,");
console.log("自动生成 UUID 密钥, 服务监听 127.0.0.1, 接下来选择公网 HTTPS 接入方式。");
console.log("");

const previousAllowAll =
  existing.ALLOW_WRITES === "1" &&
  existing.ALLOW_SHELL === "1" &&
  existing.ALLOW_SCREENSHOT === "1" &&
  existing.ALLOW_OPEN === "1" &&
  existing.ALLOW_GUI === "1";

const quickStart = await askBoolean("一键快速开启?", true);

let roots = existing.LOCAL_CONTROL_ROOTS || os.homedir();
let allowWrites = true;
let allowShell = true;
let allowUnsafeShell = true;
let allowScreenshot = true;
let allowOpen = true;
let allowGui = true;
let allowAppleScript = process.platform === "darwin";
let publicUrl = existing.PUBLIC_MCP_URL || "";
let host = existing.HOST || "127.0.0.1";

if (!quickStart) {
  roots = await ask("允许 ChatGPT 访问的目录(Windows 多目录用分号分隔)", roots);

  const allowAll = await askBoolean("开启全部高权限能力?", previousAllowAll);
  allowWrites = allowAll;
  allowShell = allowAll;
  allowUnsafeShell = allowAll;
  allowScreenshot = allowAll;
  allowOpen = allowAll;
  allowGui = allowAll;
  allowAppleScript = allowAll && process.platform === "darwin";

  if (!allowAll) {
    allowWrites = await askBoolean("允许写文件 (ALLOW_WRITES)?", existing.ALLOW_WRITES === "1");
    allowShell = await askBoolean("允许运行命令 (ALLOW_SHELL)?", existing.ALLOW_SHELL === "1");
    allowUnsafeShell = allowShell && (await askBoolean("允许任意命令与 PowerShell 脚本 (ALLOW_UNSAFE_SHELL)?", existing.ALLOW_UNSAFE_SHELL === "1"));
    allowScreenshot = await askBoolean("允许截屏 (ALLOW_SCREENSHOT)?", existing.ALLOW_SCREENSHOT === "1");
    allowOpen = await askBoolean("允许打开 URL/文件/应用 (ALLOW_OPEN)?", existing.ALLOW_OPEN === "1");
    if (process.platform === "darwin") {
      allowAppleScript = await askBoolean("允许 AppleScript 应用自动化 (ALLOW_APPLESCRIPT)?", existing.ALLOW_APPLESCRIPT !== "0");
    }
    allowGui = await askBoolean("允许鼠标键盘控制 (ALLOW_GUI)?", existing.ALLOW_GUI === "1");
  }

  host = await ask("监听地址 HOST(127.0.0.1 仅本机,0.0.0.0 映射到所有网卡)", host);
}

console.log("接入方式: cloudflare = 自动临时 HTTPS 隧道, manual = 已有 HTTPS 地址, local = 仅本机。");
console.log("Cloudflare 临时隧道会公开服务入口, 请求需携带密钥; 重启后地址可能变化。");
let tunnelMode;
for (;;) {
  tunnelMode = await ask("接入方式", existing.TUNNEL_MODE || (publicUrl ? "manual" : "cloudflare"));
  if (["cloudflare", "manual", "local"].includes(tunnelMode)) break;
  console.log("请输入 cloudflare, manual 或 local。");
}
if (tunnelMode === "manual") {
  for (;;) {
    publicUrl = await ask("完整公网 HTTPS MCP 地址 (例如 https://mcp.example.com/mcp)", publicUrl);
    try {
      const parsed = new URL(publicUrl);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error();
      break;
    } catch {
      console.log("请输入有效的 HTTPS 地址。");
      if (!stdin.isTTY) process.exit(1);
    }
  }
} else {
  publicUrl = "";
}

let secretKey = await ask("SECRET_KEY 密钥(回车 = 自动生成 UUID)", existing.SECRET_KEY || "");
if (!secretKey) secretKey = uuidv4();

let controlPin = await ask("LOCAL_CONTROL_PIN 备用 PIN(回车 = 自动生成 UUID)", existing.LOCAL_CONTROL_PIN || "");
if (!controlPin || controlPin === "change-me-to-a-long-random-secret") controlPin = uuidv4();

rl.close();

if (existsSync(ENV_FILE)) {
  const backup = `${ENV_FILE}.backup`;
  renameSync(ENV_FILE, backup);
  console.log(`原 .env 已备份为 ${path.basename(backup)}`);
}

const envContent = `# Generated by scripts/setup-wizard.js
# MCP HTTP endpoint. HOST defaults to 127.0.0.1 (local only); set 0.0.0.0 to
# expose the service on all network interfaces.
PORT=8787
HOST=${host}
MCP_PATH=/mcp

# File tools are restricted to these roots. Separate multiple paths with the
# platform path delimiter: ":" on macOS/Linux, ";" on Windows.
LOCAL_CONTROL_ROOTS=${roots}

# Fallback PIN for privileged tools. Not needed when the connector URL carries
# a valid secret key.
LOCAL_CONTROL_PIN=${controlPin}

OAUTH_TOKEN_TTL_SECONDS=86400
OAUTH_REQUIRE_APPROVAL_PIN=0

ALLOW_WRITES=${allowWrites ? 1 : 0}
ALLOW_SHELL=${allowShell ? 1 : 0}
ALLOW_UNSAFE_SHELL=${allowUnsafeShell ? 1 : 0}
ALLOW_SCREENSHOT=${allowScreenshot ? 1 : 0}
ALLOW_OPEN=${allowOpen ? 1 : 0}
ALLOW_GUI=${allowGui ? 1 : 0}
ALLOW_APPLESCRIPT=${allowAppleScript ? 1 : 0}

SAFE_EXECUTABLES=${existing.SAFE_EXECUTABLES || SAFE_EXECUTABLES_DEFAULT}

# Output and file safety limits.
MAX_COMMAND_OUTPUT_CHARS=20000
MAX_READ_BYTES=262144
MAX_DIRECTORY_ENTRIES=300
COMMAND_TIMEOUT_MS=15000

# Public HTTPS URL shown at startup for ChatGPT connector setup.
PUBLIC_MCP_URL=${publicUrl}
TUNNEL_MODE=${tunnelMode}

# Secret key that grants full control via ?secret-key= or the x-secret-key header.
SECRET_KEY=${secretKey}
`;

writeFileSync(ENV_FILE, envContent, "utf8");

console.log("");
console.log(`.env 已生成: ${ENV_FILE}`);
console.log(`监听地址: ${host === "0.0.0.0" ? "所有网卡(0.0.0.0)" : "仅本机(127.0.0.1)"}`);
console.log(`允许目录: ${roots}`);
console.log(`高权限能力: writes=${allowWrites ? 1 : 0} shell=${allowShell ? 1 : 0} unsafeShell=${allowUnsafeShell ? 1 : 0} screenshot=${allowScreenshot ? 1 : 0} open=${allowOpen ? 1 : 0} gui=${allowGui ? 1 : 0} applescript=${allowAppleScript ? 1 : 0}`);
if (allowAppleScript) {
  console.log("macOS 界面操作需要在系统设置 > 隐私与安全性中授权启动服务的应用: 自动化 / 辅助功能; 截图另需屏幕录制权限。");
}
if (publicUrl) {
  console.log(`ChatGPT connector URL: ${publicUrl}?secret-key=${secretKey}`);
}
console.log(`SECRET_KEY: ${secretKey}`);
console.log("");
console.log("配置完成。npm start 将按所选方式启动服务。");
