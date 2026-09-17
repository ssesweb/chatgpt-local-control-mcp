import AppKit

// MCP 本地控制 · 菜单栏控制中心
// 启动时幂等拉起 MCP 服务与 Cloudflare 隧道，常驻菜单栏：
// 复制连接器 URL、查看状态、开关权限（改 .env 并自动重启服务）、启停服务。

final class AppDelegate: NSObject, NSApplicationDelegate {
  let proj = "/Users/tongli/Downloads/git/chatgpt-local-control-mcp"
  let envPath = "/Users/tongli/Downloads/git/chatgpt-local-control-mcp/.env"
  let logDir = "/Users/tongli/Downloads/git/chatgpt-local-control-mcp/.mcp-logs"
  let tunnelBin = "/Users/tongli/Downloads/git/chatgpt-local-control-mcp/node_modules/cloudflared/bin/cloudflared"
  let bootPath = "/Users/tongli/Downloads/git/chatgpt-local-control-mcp/scripts/boot.js"
  let tunnelPattern = "cloudflared tunnel run chatgpt-local-mcp"

  var statusItem: NSStatusItem!
  var menuOpen = false
  var timer: Timer?

  // MARK: 启动

  func applicationDidFinishLaunching(_ note: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    ensureServices()
    refreshStatus()
    timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
      self?.refreshStatus()
    }
  }

  // MARK: 状态检测

  static func serverUp() -> Bool {
    guard let url = URL(string: "http://127.0.0.1:8787/health") else { return false }
    var req = URLRequest(url: url)
    req.timeoutInterval = 2.0
    let sem = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: req) { _, resp, _ in
      ok = (resp as? HTTPURLResponse)?.statusCode == 200
      sem.signal()
    }.resume()
    sem.wait()
    return ok
  }

  static func processUp(_ pattern: String) -> Bool {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    p.arguments = ["-f", pattern]
    do { try p.run() } catch { return false }
    p.waitUntilExit()
    return p.terminationStatus == 0
  }

  static func runShell(_ command: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", command]
    try? p.run()
  }

  static func notify(_ text: String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = ["-e", "display notification \"\(text)\" with title \"MCP 本地控制\""]
    try? p.run()
  }

  // MARK: .env 读写

  func envDict() -> [String: String] {
    guard let text = try? String(contentsOfFile: envPath, encoding: .utf8) else { return [:] }
    var out: [String: String] = [:]
    for line in text.split(separator: "\n") {
      let parts = line.split(separator: "=", maxSplits: 1)
      if parts.count == 2 {
        out[parts[0].trimmingCharacters(in: .whitespaces)] = parts[1].trimmingCharacters(in: .whitespaces)
      }
    }
    return out
  }

  func setEnv(_ key: String, _ value: String) {
    guard var lines = (try? String(contentsOfFile: envPath, encoding: .utf8))?.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) else { return }
    var replaced = false
    for i in lines.indices {
      if lines[i].hasPrefix("\(key)=") {
        lines[i] = "\(key)=\(value)"
        replaced = true
      }
    }
    if !replaced { lines.append("\(key)=\(value)") }
    try? lines.joined(separator: "\n").write(toFile: envPath, atomically: true, encoding: .utf8)
  }

  func connectorURL() -> String? {
    let env = envDict()
    guard let base = env["PUBLIC_MCP_URL"], let secret = env["SECRET_KEY"] else { return nil }
    return "\(base)?secret-key=\(secret)"
  }

  func maskedURL() -> String? {
    let env = envDict()
    guard let base = env["PUBLIC_MCP_URL"], let s = env["SECRET_KEY"], s.count > 12 else { return nil }
    return "\(base)?secret-key=\(s.prefix(6))…\(s.suffix(4))"
  }

  // MARK: 服务管理

  func ensureServices() {
    if !Self.serverUp() { startServer() }
    if !Self.processUp(tunnelPattern) { startTunnel() }
  }

  func startServer() {
    Self.runShell("cd '\(proj)' && nohup npm start >> '\(logDir)/app-server.log' 2>&1 &")
  }

  func startTunnel() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: tunnelBin)
    p.arguments = ["tunnel", "run", "chatgpt-local-mcp"]
    if let h = FileHandle(forWritingAtPath: "\(logDir)/app-tunnel.log") {
      p.standardOutput = h
      p.standardError = h
    }
    try? p.run()
  }

  func stopAll() {
    let a = Process(); a.executableURL = URL(fileURLWithPath: "/usr/bin/pkill"); a.arguments = ["-f", bootPath]; try? a.run()
    let b = Process(); b.executableURL = URL(fileURLWithPath: "/usr/bin/pkill"); b.arguments = ["-f", tunnelPattern]; try? b.run()
  }

  func restartServer() {
    stopServer()
    for _ in 0..<30 {
      usleep(200_000)
      let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep"); p.arguments = ["-f", bootPath]
      try? p.run(); p.waitUntilExit()
      if p.terminationStatus != 0 { break }
    }
    startServer()
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
      if Self.serverUp() { Self.notify("服务已重启 ✓") } else { Self.notify("服务重启失败，请查看日志") }
      self?.refreshStatus()
    }
  }

  func stopServer() {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/pkill"); p.arguments = ["-f", bootPath]; try? p.run()
  }

  // MARK: 状态图标与菜单

  func refreshStatus() {
    DispatchQueue.global().async {
      let serverUp = Self.serverUp()
      let tunnelUp = Self.processUp(self.tunnelPattern)
      DispatchQueue.main.async { [weak self] in
        guard let self = self, let button = self.statusItem.button else { return }
        let sym: String
        let color: NSColor
        if serverUp && tunnelUp { sym = "●"; color = .systemGreen }
        else if serverUp || tunnelUp { sym = "◐"; color = .systemOrange }
        else { sym = "○"; color = .systemGray }
        let s = NSMutableAttributedString(string: "\(sym) ", attributes: [.foregroundColor: color])
        s.append(NSAttributedString(string: "MCP", attributes: [
          .foregroundColor: NSColor.labelColor,
          .font: NSFont.systemFont(ofSize: NSFont.systemFontSize - 1, weight: .semibold),
        ]))
        button.attributedTitle = s
        button.toolTip = serverUp ? "MCP 服务运行中" : "MCP 服务未运行"
        if !self.menuOpen { self.applyMenu(serverUp: serverUp, tunnelUp: tunnelUp) }
      }
    }
  }

  @objc func menuDidOpen() { menuOpen = true }
  @objc func menuDidClose() {
    menuOpen = false
    refreshStatus()
  }

  func applyMenu(serverUp: Bool, tunnelUp: Bool) {
    let menu = NSMenu()
    menu.delegate = self

    let statusText = "服务：\(serverUp ? "运行中" : "已停止")   隧道：\(tunnelUp ? "运行中" : "已停止")"
    menu.addItem(withTitle: statusText, action: nil, keyEquivalent: "").isEnabled = false

    let urlItem = menu.addItem(withTitle: "复制连接器 URL（含密钥）", action: #selector(copyURL(_:)), keyEquivalent: "c")
    urlItem.target = self
    urlItem.isEnabled = serverUp || tunnelUp

    if let masked = maskedURL() {
      let show = menu.addItem(withTitle: "当前 URL：\(masked)", action: nil, keyEquivalent: "")
      show.isEnabled = false
    }

    menu.addItem(.separator())

    let env = envDict()
    let perms: [(String, String)] = [
      ("ALLOW_WRITES", "写文件"),
      ("ALLOW_SHELL", "命令执行"),
      ("ALLOW_SCREENSHOT", "截屏"),
      ("ALLOW_OPEN", "打开应用/URL"),
      ("ALLOW_APPLESCRIPT", "AppleScript 自动化"),
      ("ALLOW_GUI", "鼠标键盘（仅 Windows）"),
    ]
    for (key, label) in perms {
      let on = env[key] == "1"
      let item = menu.addItem(withTitle: "\(on ? "✓ " : "　")\(label)", action: #selector(togglePerm(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = key
    }
    let hint = menu.addItem(withTitle: "（权限开关点击后自动重启服务生效）", action: nil, keyEquivalent: "")
    hint.isEnabled = false

    menu.addItem(.separator())
    let restart = menu.addItem(withTitle: "重启服务", action: #selector(restartAction(_:)), keyEquivalent: "r")
    restart.target = self
    let stop = menu.addItem(withTitle: "停止服务与隧道", action: #selector(stopAction(_:)), keyEquivalent: "")
    stop.target = self
    stop.isEnabled = serverUp || tunnelUp

    menu.addItem(.separator())
    let logs = menu.addItem(withTitle: "打开日志文件夹", action: #selector(openLogs(_:)), keyEquivalent: "")
    logs.target = self
    let projItem = menu.addItem(withTitle: "打开项目文件夹", action: #selector(openProj(_:)), keyEquivalent: "")
    projItem.target = self

    menu.addItem(.separator())
    let quit = menu.addItem(withTitle: "退出（服务保持运行）", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    quit.target = NSApp

    statusItem.menu = menu
  }

  // MARK: 菜单动作

  @objc func copyURL(_ sender: NSMenuItem) {
    guard let url = connectorURL() else { Self.notify("读取 .env 失败"); return }
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(url, forType: .string)
    Self.notify("连接器 URL 已复制 ✓")
  }

  @objc func togglePerm(_ sender: NSMenuItem) {
    guard let key = sender.representedObject as? String else { return }
    let env = envDict()
    let now = env[key] == "1"
    setEnv(key, now ? "0" : "1")
    if key == "ALLOW_SHELL" { setEnv("ALLOW_UNSAFE_SHELL", now ? "0" : "1") }
    Self.notify("\(key) → \(now ? "0" : "1")，重启服务生效")
    restartServer()
  }

  @objc func restartAction(_ sender: NSMenuItem) { restartServer() }
  @objc func stopAction(_ sender: NSMenuItem) {
    stopAll()
    Self.notify("已停止服务与隧道")
    refreshStatus()
  }
  @objc func openLogs(_ sender: NSMenuItem) {
    NSWorkspace.shared.open(URL(fileURLWithPath: logDir))
  }
  @objc func openProj(_ sender: NSMenuItem) {
    NSWorkspace.shared.open(URL(fileURLWithPath: proj))
  }
}

extension AppDelegate: NSMenuDelegate {
  func menuWillOpen(_ menu: NSMenu) { menuOpen = true }
  func menuDidClose(_ menu: NSMenu) {
    menuOpen = false
    refreshStatus()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
