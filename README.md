# ChatGPT Local Control MCP

让 ChatGPT 通过 MCP Connector 控制这台电脑：读写文件、运行命令、截屏、打开应用、鼠标键盘操作、代码诊断。

## 快速开始

```bash
npm install
npm start
```

首次运行自动进入配置向导，直接回车即一键快速开启（目录为用户主目录、全部高权限能力、自动生成 UUID 密钥、仅监听本机）。启动后直接输出可粘贴到 ChatGPT 的 Connector URL：

```text
ChatGPT connector URL: https://your-domain.example/mcp?secret-key=<your-secret-key>
```

重新配置：`npm run setup`

## 接入 ChatGPT

`Settings -> Connectors -> Create`，Connector URL 填启动时打印的带密钥地址，Authentication 选 `No authentication`。

对外暴露需要 HTTPS 反代或隧道（如 `npm run tunnel`）。服务默认只监听 `127.0.0.1`，设 `HOST=0.0.0.0` 才映射到所有网卡。

## 工具

- `computer_status` / `list_directory` / `read_file`：状态与只读文件访问，无须授权
- `code_diagnostics`：运行 tsc / ESLint / ruff，返回问题面板式结构化诊断
- `write_file` / `run_command` / `run_powershell` / `take_screenshot` / `open_target` / `run_applescript` / `move_mouse` / `mouse_click` / `press_keys` / `type_text` / `get_cursor_position`：高权限工具，凭密钥或 OAuth `local.control` 使用

## 配置

完整项见 `.env.example`。常用：

```env
LOCAL_CONTROL_ROOTS=C:\Users\you     # 允许访问的目录,分号分隔
ALLOW_WRITES=1                       # 能力开关: WRITES / SHELL / UNSAFE_SHELL / SCREENSHOT / OPEN / GUI
SECRET_KEY=<uuid>                    # 全权限密钥,留空则自动生成并保存到 .mcp-artifacts/secret-key.txt
PUBLIC_MCP_URL=https://your-domain.example/mcp   # 启动时打印 Connector URL 用
HOST=127.0.0.1                       # 0.0.0.0 才对外
```

## 安全

带 `secret-key` 的 URL 等于本机完整控制权，只发给可信客户端。高权限调用全部记录在 `.mcp-audit/events.jsonl`。

## macOS

需要 Node.js 20+。Mac 首次快速配置默认开启 AppleScript; 未设置 `ALLOW_APPLESCRIPT` 时也默认开启, 显式设为 `0` 可禁用。已有 `.env` 若为 `0`, 需改为 `1` 或重新运行配置向导。

AppleScript 操作应用界面时, 请在系统设置 > 隐私与安全性中为启动服务的应用授予所需的自动化、辅助功能权限; 截图需要屏幕录制权限。MCP 密钥授权不替代 macOS 系统授权, 系统弹窗需要用户确认。

`move_mouse`、`mouse_click`、`press_keys`、`type_text`、`get_cursor_position` 目前仅支持 Windows; Mac 应用自动化使用 `run_applescript`。
