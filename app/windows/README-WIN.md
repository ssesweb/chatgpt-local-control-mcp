# MCP 本地控制 · Windows 托盘版（amd64）

与 macOS 菜单栏版功能一致的任务栏托盘控制中心，中文界面。本目录为源码包，在目标 Windows 机器上现场编译（使用 Windows **系统自带**的 .NET Framework 编译器，无需安装任何 SDK）。

## 前置要求

1. Node.js 20+（含 npm），并已克隆本仓库：`git clone https://github.com/ssesweb/chatgpt-local-control-mcp.git`
2. 在项目根目录执行 `npm install`（会自动下载 cloudflared.exe）
3. 执行 `npm run setup` 完成首次配置（选 `cloudflare` 或先随便选，后面 `setup-tunnel.bat` 会改写）

## 安装托盘程序

```bat
cd app\windows
install.bat
```

效果：编译出 `MCP本地控制.exe` → 在桌面创建快捷方式 → 询问是否开机自启 → 立即启动。任务栏右下角出现圆点图标（绿=全部正常 / 橙=部分运行 / 灰=全停，5 秒刷新一次）。

## 初始化这台机器的固定隧道（一次性）

```bat
cd app\windows
setup-tunnel.bat
```

会依次：浏览器登录 Cloudflare（选择授权域名）→ 创建/复用隧道 `chatgpt-win` → 绑定子域（默认 `mcp-win.quietphoenix.top`，可自行输入）→ 写入 `%USERPROFILE%\.cloudflared\config.yml` → 把 `.env` 的 `PUBLIC_MCP_URL` 改为 `https://<子域>/mcp`、`TUNNEL_MODE=manual`。

完成后在托盘菜单点「复制连接器 URL（含密钥）」，填进 ChatGPT 的自定义连接器即可。

## 托盘菜单

- 状态行 + 脱敏 URL（置顶）
- 复制连接器 URL（含密钥）
- 权限：写文件 / 命令执行 / 截屏 / 打开应用 / 鼠标键盘（点击切换，自动改 `.env` 并重启服务生效；`命令执行` 联动 `ALLOW_UNSAFE_SHELL`）
- 服务：重启服务、停止服务与隧道
- 资源：打开日志文件夹（`.mcp-logs\app-server.log`、`.mcp-logs\app-tunnel.log`）、打开项目文件夹
- 退出（服务与隧道保持运行，可从「停止服务与隧道」显式停止）

## 说明

- 编译：`build-tray.bat`（csc.exe，C# 5 语法，兼容 Win10/11 自带 .NET Framework 4.x）
- 端口与 macOS 版一致（8787），本机监听 `127.0.0.1`，公网经 Cloudflare 隧道 HTTPS 暴露
- 批处理脚本以 UTF-8 保存，开头 `chcp 65001`，个别老系统如出现中文乱码可自行转存为 ANSI 编码
