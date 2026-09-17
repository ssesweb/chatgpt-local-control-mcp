@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 用 Windows 系统自带的 .NET Framework 编译器编译托盘程序，无需安装任何 SDK
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo 未找到 .NET Framework 编译器 csc.exe
  exit /b 1
)
"%CSC%" /nologo /target:winexe /out:"MCP本地控制.exe" /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Management.dll mcp-tray.cs IconPng.cs
if errorlevel 1 (
  echo 编译失败，请检查 mcp-tray.cs IconPng.cs
  exit /b 1
)
echo 编译完成: MCP本地控制.exe
