// 小工具: 把 .env 中某个键改写为新值（不存在则追加）
// 用法: node patch-env.js KEY VALUE
const fs = require("fs");
const path = require("path");
const key = process.argv[2];
const value = process.argv[3];
if (!key || value === undefined) {
  console.error("用法: node patch-env.js KEY VALUE");
  process.exit(1);
}
const p = path.resolve(process.cwd(), ".env");
let lines = [];
try {
  lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
} catch (e) {
  console.error("未找到 .env，请先运行 npm run setup");
  process.exit(1);
}
let hit = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim().startsWith(key + "=")) {
    lines[i] = key + "=" + value;
    hit = true;
  }
}
if (!hit) lines.push(key + "=" + value);
fs.writeFileSync(p, lines.join("\n"));
console.log("已设置 " + key + "=" + value);
