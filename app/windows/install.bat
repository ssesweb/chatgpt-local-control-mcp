@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 一键安装：编译托盘程序 + 创建桌面快捷方式 + 可选开机自启 + 立即启动
call build-tray.bat || exit /b 1

powershell -NoProfile -Command "$d=[Environment]::GetFolderPath('Desktop'); $ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut((Join-Path $d 'MCP本地控制.lnk')); $s.TargetPath='%~dp0MCP本地控制.exe'; $s.WorkingDirectory='%~dp0'; $s.Save()"
echo 已创建桌面快捷方式。

set AUTO=Y
set /p AUTO=是否开机自启？(Y/n):
if /I not "%AUTO%"=="n" (
  powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell; $s=$ws.CreateShortcut((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\MCP本地控制.lnk')); $s.TargetPath='%~dp0MCP本地控制.exe'; $s.WorkingDirectory='%~dp0'; $s.Save()"
  echo 已加入开机自启。
)

start "" "%~dp0MCP本地控制.exe"
echo 全部完成。右下角任务栏托盘会出现圆点图标，右键可操作。
