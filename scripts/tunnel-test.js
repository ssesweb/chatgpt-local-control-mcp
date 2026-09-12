import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  console.log("SKIP: executable tunnel fixture requires a POSIX host");
  process.exit(0);
}
const repo = fileURLToPath(new URL("..", import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "mcp-boot-test-"));
await cp(path.join(repo, "scripts"), path.join(root, "scripts"), { recursive: true });
await cp(path.join(repo, "src"), path.join(root, "src"), { recursive: true });
await cp(path.join(repo, "package.json"), path.join(root, "package.json"));
await symlink(path.join(repo, "node_modules"), path.join(root, "node_modules"), "dir");
await mkdir(path.join(root, "fixture"));
const wizard = spawn(process.execPath, ["scripts/setup-wizard.js"], { cwd: root, stdio: ["pipe", "ignore", "ignore"] });
wizard.stdin.end();
assert.equal((await once(wizard, "exit"))[0], 0);
const generated = await readFile(path.join(root, ".env"), "utf8");
assert.match(generated, /^TUNNEL_MODE=cloudflare$/m);
assert.match(generated, /^PUBLIC_MCP_URL=$/m);
console.log("PASS: first-run wizard selects automatic Cloudflare");
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
await writeFile(path.join(root, ".env"), `PORT=${port}\nHOST=127.0.0.1\nMCP_PATH=/custom-mcp\nLOCAL_CONTROL_ROOTS=${path.join(root, "fixture")}\nTUNNEL_MODE=cloudflare\nALLOW_APPLESCRIPT=0\n`);
const fake = path.join(root, "fake-cloudflared");
await writeFile(fake, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync('child-pid.txt',String(process.pid));\nwriteFileSync('child-args.json',JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write('https://fake-');\nsetTimeout(()=>process.stdout.write('test.trycloudflare.com\\n'),30);\nsetInterval(()=>{},1000);\n`, { mode: 0o755 });
const shim = path.join(root, "fetch-shim.mjs");
await writeFile(shim, `const original = globalThis.fetch;\nglobalThis.fetch = (input,init) => { const u = new URL(input); if (u.hostname === 'fake-test.trycloudflare.com') {u.protocol='http:';u.host='127.0.0.1:${port}';} return original(u,init); };\n`);
const child = spawn(process.execPath, ["--import", shim, "scripts/boot.js"], { cwd: root, env: { ...process.env, CLOUDFLARED_BIN: fake }, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Boot readiness timeout")), 10000);
    child.on("error", reject);
    child.on("exit", () => { clearTimeout(timeout); reject(new Error("Boot exited before readiness")); });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes("Public MCP verified.")) { clearTimeout(timeout); resolve(); }
    });
  });
  const connector = output.match(/ChatGPT connector URL: (\S+)/)[1];
  assert.equal(new URL(connector).pathname, "/custom-mcp");
  assert(new URL(connector).searchParams.get("secret-key"));
  const saved = await readFile(path.join(root, ".mcp-artifacts", "tunnel-url.txt"), "utf8");
  assert(!saved.includes("secret-key"));
  const args = JSON.parse(await readFile(path.join(root, "child-args.json"), "utf8"));
  assert(args.includes(`http://127.0.0.1:${port}`));
  assert.equal((await fetch(`http://127.0.0.1:${port}/custom-mcp`)).status, 401);
  console.log("PASS: simulated tunnel boot, split URL output, custom port/path, MCP verification and key protection");
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const done = once(child, "exit");
    child.kill("SIGTERM");
    await done;
  }
}
const pid = Number(await readFile(path.join(root, "child-pid.txt"), "utf8"));
assert.throws(() => process.kill(pid, 0));
await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
console.log("PASS: shutdown stops both server and tunnel process");

await writeFile(fake, `#!${process.execPath}\nprocess.exit(2);\n`, { mode: 0o755 });
const failed = spawn(process.execPath, ["scripts/boot.js"], { cwd: root, env: { ...process.env, CLOUDFLARED_BIN: fake }, stdio: ["ignore", "pipe", "pipe"] });
let failedOutput = "";
failed.stdout.on("data", (chunk) => { failedOutput += chunk.toString(); });
failed.stderr.on("data", (chunk) => { failedOutput += chunk.toString(); });
const [exitCode] = await once(failed, "exit");
assert.notEqual(exitCode, 0);
assert(!failedOutput.includes("ChatGPT connector URL:"));
assert(failedOutput.includes("Cloudflare tunnel stopped"));
await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
console.log("PASS: failed tunnel exits without issuing a ready URL");
