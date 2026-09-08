# ChatGPT Local Control MCP

这个项目提供一个本机 MCP server，让 ChatGPT 通过 HTTPS MCP Connector 连接并控制这台电脑。认证默认使用 `SECRET_KEY` 密钥模式：连接 URL 携带 `?secret-key=`（或请求头 `x-secret-key`），密钥匹配即拥有 `local.control` 全部权限，不需要走 OAuth 授权流程。读文件、列目录和查看状态不需要授权；写文件、运行命令、截屏、打开应用、GUI 键鼠控制等高权限能力必须在 `.env` 中显式开启。OAuth 授权流程仍保留作为可选方式，也可以在工具参数里提供 fallback `control_pin`。

目前支持：

- macOS：文件、命令、截屏、`open_target`、AppleScript。
- Windows：文件、命令、PowerShell、截屏、`open_target`、鼠标移动/点击、按键、文本输入。

## 工具

- `computer_status`: 查看服务状态、允许目录和能力开关。无须授权。
- `code_diagnostics`: 在项目目录运行编辑器同款检查器（tsc、ESLint、ruff），返回类似问题面板的结构化诊断（文件、行号、严重级别、错误码、消息）。需要密钥或 OAuth `local.control`。
- `list_directory`: 列出 `LOCAL_CONTROL_ROOTS` 内的文件。无须授权。
- `read_file`: 读取 `LOCAL_CONTROL_ROOTS` 内的文件，默认最大 256KB。无须授权。
- `write_file`: 写入文件。需要 `ALLOW_WRITES=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `run_command`: 运行本机命令。需要 `ALLOW_SHELL=1`，以及 OAuth `local.control` 或 fallback `control_pin`。默认只允许 `SAFE_EXECUTABLES` 中的可执行文件。
- `run_powershell`: 在 Windows 运行 PowerShell 脚本。需要 `ALLOW_SHELL=1`、`ALLOW_UNSAFE_SHELL=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `take_screenshot`: 截屏并把图片返回给 MCP 客户端。需要 `ALLOW_SCREENSHOT=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `open_target`: 打开 URL、文件、目录或应用。需要 `ALLOW_OPEN=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `run_applescript`: 在 macOS 运行 AppleScript 做 GUI 自动化。需要 `ALLOW_APPLESCRIPT=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `get_cursor_position`: Windows 下读取当前鼠标坐标。需要 `ALLOW_GUI=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `move_mouse`: Windows 下移动鼠标到屏幕坐标。需要 `ALLOW_GUI=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `mouse_click`: Windows 下点击屏幕坐标。需要 `ALLOW_GUI=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `press_keys`: Windows 下按键，例如 `["CTRL","L"]`、`["ALT","TAB"]`、`["WIN","R"]`。需要 `ALLOW_GUI=1`，以及 OAuth `local.control` 或 fallback `control_pin`。
- `type_text`: Windows 下把文本粘贴到当前活动应用。需要 `ALLOW_GUI=1`，以及 OAuth `local.control` 或 fallback `control_pin`。

## 本地启动

第一次 `npm start` 时，如果项目目录没有 `.env`，会自动进入配置向导。

一键快速开启：向导第一个问题直接回车或输入 `y`，即按默认配置完成——允许目录为当前用户主目录、开启全部高权限能力、自动生成 UUID 密钥、仅监听 `127.0.0.1`。输入 `n` 则进入逐项配置（目录、能力开关、公网地址、监听地址等）。

服务默认只监听 `127.0.0.1`，外部无法直接访问；需要通过反代或隧道映射出去时，在 `.env` 里把 `HOST` 设为 `0.0.0.0`，或保持 `127.0.0.1` 由本机隧道客户端转发。

之后想重新配置，运行：

```bash
npm run setup
```

也可以手动创建配置后直接启动：

```bash
npm install
cp .env.example .env
npm start
```

Windows PowerShell:

```powershell
npm install
Copy-Item .env.example .env
npm start
```

健康检查：

```bash
curl http://localhost:8787/
npm run smoke
npm run smoke:oauth
```

## Windows 完整控制配置示例

只在你信任当前 ChatGPT 会话时临时使用这种配置。`ALLOW_UNSAFE_SHELL=1` 和 `ALLOW_GUI=1` 代表 ChatGPT 可以通过 PowerShell、键盘和鼠标对电脑做真实操作。

```env
PORT=8787
MCP_PATH=/mcp
LOCAL_CONTROL_ROOTS=C:\Users\你的用户名
LOCAL_CONTROL_PIN=换成一段很长的随机字符串

OAUTH_TOKEN_TTL_SECONDS=86400
OAUTH_REQUIRE_APPROVAL_PIN=0

ALLOW_WRITES=1
ALLOW_SHELL=1
ALLOW_UNSAFE_SHELL=1
ALLOW_SCREENSHOT=1
ALLOW_OPEN=1
ALLOW_GUI=1
ALLOW_APPLESCRIPT=0
```

如果需要多个允许目录，Windows 用分号分隔：

```env
LOCAL_CONTROL_ROOTS=C:\Users\你;D:\Projects
```

## 密钥认证与公网 Connector URL

`.env` 支持两个可选配置：

```env
# 对外公布的 MCP HTTPS 地址，启动时会打印可粘贴的 Connector URL
PUBLIC_MCP_URL=https://your-domain.example/mcp

# 全权限密钥。留空则首次启动自动生成，并持久保存到 .mcp-artifacts/secret-key.txt
SECRET_KEY=换成一段很长的随机字符串
```

启动输出示例：

```text
Local control MCP listening on http://localhost:8787/mcp
Allowed roots: C:\Users\you
ChatGPT connector URL: https://your-domain.example/mcp?secret-key=<your-secret-key>
Secret key: <your-secret-key> (grants full control via ?secret-key= or x-secret-key header)
```

- 请求通过 `?secret-key=` 查询参数或 `x-secret-key` 请求头出示密钥，匹配即拥有全部高权限工具，不需要 OAuth 授权，也不需要在工具参数里传 `control_pin`。
- 不带密钥的请求只能使用只读工具，高权限工具会被拒绝。
- 没有设置 `SECRET_KEY` 时，服务会生成随机密钥并写入 `.mcp-artifacts/secret-key.txt`（该目录已被 `.gitignore` 忽略），重启后密钥保持不变。

### 代码诊断（code_diagnostics）

`code_diagnostics` 工具会在指定项目目录内检测并运行：

- TypeScript：`node_modules/typescript/bin/tsc --noEmit`
- ESLint：`node_modules/eslint/bin/eslint.js -f json .`
- Python：存在 `ruff.toml` 或 `pyproject.toml` 时运行 `python -m ruff check`

输出为结构化诊断数组（`file`、`line`、`column`、`severity`、`code`、`message`、`source`），最多返回 200 条，适合让 ChatGPT 在开发会话中直接感知代码检查结果。

## HTTPS tunnel

ChatGPT Connector 需要能访问 HTTPS 的 `/mcp` 地址。本地开发可以用 Cloudflare Tunnel、ngrok 或其他 HTTPS 隧道。

如果已经安装 `cloudflared`：

```bash
npm run tunnel
```

脚本会把最新地址写入：

- `.mcp-artifacts/tunnel-origin.txt`
- `.mcp-artifacts/tunnel-url.txt`

`tunnel-url.txt` 里的值就是 ChatGPT Connector URL，例如：

```text
https://example.trycloudflare.com/mcp
```

Cloudflare quick tunnel 不保证域名永久固定。如果电脑重启或 tunnel 重新创建，需要在 ChatGPT 应用设置里更新 Connector URL。长期使用请配置 Cloudflare named tunnel 或自己的固定域名。

## 连接 ChatGPT

在 ChatGPT 中进入 `Settings -> Connectors -> Create`，填写：

- Connector name: `Local Computer Control`
- Description: `Controls my local computer through a guarded MCP server. Use only when I explicitly ask.`
- Connector URL: 启动时打印的带密钥地址，例如 `https://你的隧道域名/mcp?secret-key=<your-secret-key>`
- Authentication: `No authentication`（密钥已包含在 URL 中）

工具元数据不声明 OAuth（避免 ChatGPT 触发混合认证的 OAuth 解析而报 `Failed to resolve OAuth config for mixed auth mcp`）。如果你仍想使用 OAuth 授权页方式，Connector URL 不带密钥即可，流程与原来一致。

## macOS 常驻运行

仓库仍保留 launchd 脚本：

```bash
npm run service:install
npm run service:status
npm run service:uninstall
```

这会创建用户级 LaunchAgent，分别运行本机 MCP 服务和 Cloudflare tunnel。

macOS 第一次运行 AppleScript GUI 控制时，可能需要到 `System Settings -> Privacy & Security -> Accessibility` 给 Terminal、Codex 或 Node 授权。

## 安全建议

- `LOCAL_CONTROL_ROOTS` 越窄越好。只开放确实需要 ChatGPT 读写的目录。
- 不要把 `ALLOW_UNSAFE_SHELL=1` 当成长期常驻配置。
- 不要把公开 tunnel 暴露给不可信用户。
- 带 `secret-key` 的 Connector URL 等于本机完整控制权，只发给可信客户端，不要外传或提交到仓库。
- 如需 OAuth 授权页也要求 fallback PIN，可设置 `OAUTH_REQUIRE_APPROVAL_PIN=1`。
- 当前 OAuth token 存在内存里，服务重启后需要在 ChatGPT 里重新授权。
- 所有高权限工具调用都会写入 `.mcp-audit/events.jsonl`，方便追踪。
