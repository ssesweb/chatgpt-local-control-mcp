import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const entry = fileURLToPath(new URL("../src/server.js", import.meta.url));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "local-control-test-"));

for (const setting of [undefined, "0"]) {
  const key = randomUUID();
  const port = 19000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", MCP_PATH: "/mcp", SECRET_KEY: key, LOCAL_CONTROL_ROOTS: tempRoot, PUBLIC_MCP_URL: "", LOCAL_CONTROL_PIN: "", DOTENV_CONFIG_PATH: path.join(tempRoot, "absent.env") };
  delete env.ALLOW_APPLESCRIPT;
  if (setting !== undefined) env.ALLOW_APPLESCRIPT = setting;
  const child = spawn(process.execPath, [entry], { cwd: tempRoot, env, stdio: ["ignore", "pipe", "ignore"] });
  const clients = [];
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Server startup timeout")), 10000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
      child.stdout.on("data", (data) => {
        if (data.toString().includes("Local control MCP listening")) { clearTimeout(timeout); resolve(); }
      });
    });
    for (const authorized of [true, false]) {
      const client = new Client({ name: "compatibility-test", version: "1.0.0" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: authorized ? { "x-secret-key": key } : {} } }));
      const list = await client.listTools();
      assert(list.tools.some((tool) => tool.name === "code_diagnostics"));
      for (const tool of list.tools) assert.equal(tool.inputSchema.type, "object");
      const enabled = setting !== "0" && process.platform === "darwin";
      const status = await client.callTool({ name: "computer_status", arguments: {} });
      assert.equal(status.structuredContent.capabilities.appleScript, enabled);
      const result = await client.callTool({ name: "run_applescript", arguments: { script: 'return "applescript-ok"' } });
      if (enabled && authorized) {
        assert(!result.isError);
        assert.equal(result.structuredContent.stdout.text.trim(), "applescript-ok");
      } else {
        assert.equal(result.isError, true);
        const message = result.content.map((item) => item.text ?? "").join(" ");
        assert.match(message, enabled ? /PIN|auth/i : /disabled/);
      }
      console.log(`PASS: tools/list, AppleScript=${setting ?? "default"}, authorized=${authorized}`);
    }
  } finally {
    for (const client of clients) await client.close();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await exited;
  }
}
