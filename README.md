# ChatGPT Local Control MCP

让 ChatGPT 通过 MCP Connector 控制这台电脑：读写文件、运行命令、截屏、打开应用、鼠标键盘操作、代码诊断。

## 快速开始

root@device:/#
```bash
npm install
npm start
```

首次运行自动进入配置向导。快速开启默认允许访问用户主目录、开启本平台支持的高权限能力并生成 UUID 密钥, Mac 同时开启 AppleScript。向导会让你选择接入方式:

- `cloudflare` (默认): 自动启动 Cloudflare 临时隧道, 无需填写域名。服务仍监听 `127.0.0.1`, 隧道提供公网 HTTPS 入口, 所有业务请求必须携带密钥。
- `manual`: 输入已配置好的完整 HTTPS MCP 地址, 例如 `https://mcp.example.com/mcp`。程序不会替你创建域名或反向代理。
- `local`: 仅启动本地服务, 不提供可供 ChatGPT 官网连接的公网地址。

Cloudflare 模式会先验证公网 MCP 连接、工具列表和状态调用, 成功后才输出:

root@device:/#
```text
ChatGPT connector URL: https://<temporary-name>.trycloudflare.com/mcp?secret-key=<your-secret-key>
```

保持终端运行; Ctrl+C 会停止服务与自动启动的隧道。临时地址重启后可能变化, 需要更新 ChatGPT 连接器地址。长期使用建议配置固定域名的 Cloudflare Tunnel 或 HTTPS 反向代理, 在向导中选择 `manual`。

重新配置使用 `npm run setup`, 然后 `npm start`。已有 `.env` 不会自动迁移; 要启用自动隧道, 请重新配置或设 `TUNNEL_MODE=cloudflare`。`npm run tunnel` 可单独启动隧道, 但本地服务必须已按该模式重启。

## 接入 ChatGPT

在 ChatGPT 官网的自定义 MCP 连接器入口填写完整带密钥 URL, Authentication 选择 `No authentication` (密钥已在 URL 中)。需要账号具有自定义 MCP 连接器功能。程序验证的是公网 MCP 协议连通性, 不代表已替你完成 ChatGPT 官网添加连接器。

首次使用需要允许下载 cloudflared, 并确保网络可连接 Cloudflare。下载或隧道验证失败会报错, 不会输出已就绪的 Connector URL。若日志出现 `_v2-origintunneld._tcp.argotunnel.com` 查询失败, 请检查网络 DNS; 详细日志位于 `.mcp-logs/cloudflared-tunnel.log`。

[Cloudflare 临时隧道](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)用于测试, 不保证可用性且不支持 SSE; 本项目使用 Streamable HTTP 的 JSON 响应模式。

## 工具

- `computer_status` / `list_directory` / `read_file`：状态与只读文件访问; Cloudflare 临时隧道模式需要密钥, 其他模式维持原有只读免授权行为
- `code_diagnostics`：运行 tsc / ESLint / ruff，返回问题面板式结构化诊断
- `write_file` / `run_command` / `run_powershell` / `take_screenshot` / `open_target` / `run_applescript` / `move_mouse` / `mouse_click` / `press_keys` / `type_text` / `get_cursor_position`：高权限工具，凭密钥或 OAuth `local.control` 使用

## 配置

完整项见 `.env.example`。`TUNNEL_MODE` 可选 `cloudflare`、`manual`、`local`; `PUBLIC_MCP_URL` 用于已有固定 HTTPS 地址。多目录在 Mac/Linux 上用冒号分隔, Windows 用分号分隔。常用配置如下:

root@device:/#
```env
LOCAL_CONTROL_ROOTS=C:\Users\you
ALLOW_WRITES=1
SECRET_KEY=<uuid>
PUBLIC_MCP_URL=https://your-domain.example/mcp   # 启动时打印 Connector URL 用
HOST=127.0.0.1
```

## 安全

带 `secret-key` 的 URL 等于本机完整控制权，只发给可信客户端。高权限调用全部记录在 `.mcp-audit/events.jsonl`。

## macOS

需要 Node.js 20+。Mac 首次快速配置默认开启 AppleScript; 未设置 `ALLOW_APPLESCRIPT` 时也默认开启, 显式设为 `0` 可禁用。已有 `.env` 若为 `0`, 需改为 `1` 或重新运行配置向导。

AppleScript 操作应用界面时, 请在系统设置 > 隐私与安全性中为启动服务的应用授予所需的自动化、辅助功能权限; 截图需要屏幕录制权限。MCP 密钥授权不替代 macOS 系统授权, 系统弹窗需要用户确认。

`move_mouse`、`mouse_click`、`press_keys`、`type_text`、`get_cursor_position` 目前仅支持 Windows; Mac 应用自动化使用 `run_applescript`。

## macOS 菜单栏控制中心 App

`app/` 内提供一个常驻菜单栏的中文控制中心 `MCP本地控制.app`（Swift 编写，源码见 `app/menubar/main.swift`）：

- 启动 App 会幂等拉起 MCP 服务与 Cloudflare 隧道（已运行则跳过），并常驻菜单栏；
- 图标实时显示状态（● 绿 = 全部正常，◐ 橙 = 部分运行，○ 灰 = 全部停止），每 5 秒刷新；
- 菜单内可一键复制连接器 URL（含密钥）、查看脱敏 URL；
- 可直接开关写文件 / 命令执行 / 截屏 / 打开应用 / AppleScript / 鼠标键盘等权限，点击即改写 `.env` 并自动重启服务生效；
- 提供重启服务、停止服务与隧道、打开日志与项目文件夹等快捷操作。

从源码构建：

root@device:/#
```bash
cd app && swiftc menubar/main.swift -o /tmp/mcp-menubar
```

然后把二进制放进 `MCP本地控制.app/Contents/MacOS/mcp-menubar`（`Info.plist` 中 `CFBundleExecutable` 需与之对应），再将整个 `.app` 拷贝到 `/Applications`。服务与隧道的启动日志位于 `.mcp-logs/app-server.log` 与 `.mcp-logs/app-tunnel.log`。

## Windows 托盘控制中心（amd64）

`app/windows/` 提供功能对等的任务栏托盘控制中心（中文界面），源码单文件 `mcp-tray.cs`，在目标 Windows 机器上用**系统自带**的 .NET Framework 编译器现场编译，无需安装 SDK：

root@device:/#
```bat
cd app\windows
setup-tunnel.bat   && rem 一次性: 登录 Cloudflare、建隧道、绑子域、写配置、改 .env
install.bat        && rem 编译 MCP本地控制.exe、建桌面快捷方式、可选开机自启、启动
```

托盘菜单支持复制连接器 URL、权限开关（自动改 `.env` 并重启服务）、重启/停止服务与隧道、打开日志与项目文件夹；图标颜色实时反映服务与隧道状态。详见 `app/windows/README-WIN.md`。
