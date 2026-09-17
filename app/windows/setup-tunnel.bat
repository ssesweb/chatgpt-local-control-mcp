@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 一次性初始化 Windows 的 Cloudflare 固定隧道：登录 → 建隧道 → 绑子域 → 写配置 → 改 .env
set CF=node_modules\cloudflared\bin\cloudflared.exe
if not exist "%CF%" set CF=node_modules\cloudflared\lib\cloudflared.exe
if not exist "%CF%" set CF=node_modules\cloudflared\cloudflared.exe
if not exist "%CF%" (
  echo 未找到 cloudflared.exe，请先执行: npm install
  exit /b 1
)

set SUB=
set /p SUB=请输入用于这台 Windows 的子域（回车 = mcp-win.quietphoenix.top）:
if "%SUB%"=="" set SUB=mcp-win.quietphoenix.top

echo.
echo [1/5] 浏览器登录 Cloudflare（选择本机授权的域名）...
"%CF%" tunnel login || exit /b 1

echo.
echo [2/5] 检查/创建隧道 chatgpt-win...
set TID=
for /f "tokens=1" %%i in ('"%CF%" tunnel list 2^>^&1 ^| findstr /C:"chatgpt-win"') do set TID=%%i
if not "%TID%"=="" (
  echo 隧道已存在: %TID%
) else (
  for /f "tokens=6" %%i in ('"%CF%" tunnel create chatgpt-win 2^>^&1 ^| findstr /C:"with id"') do set TID=%%i
)
if "%TID%"=="" (
  echo 创建隧道失败，请手动执行: "%CF%" tunnel create chatgpt-win
  exit /b 1
)
echo 隧道 ID: %TID%

echo.
echo [3/5] 绑定 DNS: %SUB% ...
"%CF%" tunnel route dns chatgpt-win %SUB%

echo.
echo [4/5] 写入隧道配置...
> "%USERPROFILE%\.cloudflared\config.yml" echo tunnel: %TID%
>> "%USERPROFILE%\.cloudflared\config.yml" echo credentials-file: %USERPROFILE%\.cloudflared\%TID%.json
>> "%USERPROFILE%\.cloudflared\config.yml" echo ingress:
>> "%USERPROFILE%\.cloudflared\config.yml" echo   - hostname: %SUB%
>> "%USERPROFILE%\.cloudflared\config.yml" echo     service: http://127.0.0.1:8787
>> "%USERPROFILE%\.cloudflared\config.yml" echo   - service: http_status:404

echo.
echo [5/5] 更新 .env（PUBLIC_MCP_URL / TUNNEL_MODE）...
node patch-env.js PUBLIC_MCP_URL https://%SUB%/mcp
node patch-env.js TUNNEL_MODE manual
if errorlevel 1 (
  echo 请手动把 .env 中 PUBLIC_MCP_URL 设为 https://%SUB%/mcp ，TUNNEL_MODE 设为 manual
)

echo.
echo 隧道初始化完成。ChatGPT 连接器地址: https://%SUB%/mcp?secret-key=<你的密钥>
echo 密钥见 .env 的 SECRET_KEY，或由托盘菜单"复制连接器 URL"获取。
