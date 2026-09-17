#!/bin/bash
# 构建 MCP本地控制.app 并安装到 /Applications
# 用法: bash app/menubar/build-app.sh
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUNDLE="$ROOT/app/MCP本地控制.app"
BIN_SRC="$BUNDLE/Contents/MacOS/mcp-menubar"

echo "1/4 编译 Swift…"
swiftc "$ROOT/app/menubar/main.swift" -o "$BIN_SRC"

echo "2/4 拷贝图标到 Resources…"
mkdir -p "$BUNDLE/Contents/Resources"
cp -R "$ROOT/app/menubar/icons/" "$BUNDLE/Contents/Resources/icons"

echo "3/4 安装到 /Applications…"
rm -rf "/Applications/MCP本地控制.app"
cp -R "$BUNDLE" /Applications/

echo "4/4 完成: /Applications/MCP本地控制.app"
