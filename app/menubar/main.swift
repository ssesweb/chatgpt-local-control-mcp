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
  var lastEnsure = Date.distantPast

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

  static func mcpPort() -> Int {
    let envPath = "/Users/tongli/Downloads/git/chatgpt-local-control-mcp/.env"
    if let text = try? String(contentsOfFile: envPath, encoding: .utf8) {
      for line in text.split(separator: "\n") {
        if line.hasPrefix("PORT="), let p = Int(line.dropFirst(5).trimmingCharacters(in: .whitespaces)) { return p }
      }
    }
    return 8787
  }

  static func serverUp() -> Bool {
    guard let url = URL(string: "http://127.0.0.1:\(mcpPort())/health") else { return false }
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
    // 自愈：服务或隧道挂了自动拉起（15 秒节流，避免反复失败刷日志）
    let needEnsure: Bool = { objc_sync_enter(self); defer { objc_sync_exit(self) }
      if Date().timeIntervalSince(lastEnsure) > 15 { lastEnsure = Date(); return true }; return false }()
    if needEnsure {
      if !Self.serverUp() { startServer() }
      if !Self.processUp(tunnelPattern) { startTunnel() }
    }
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

  // MARK: 图标与菜单构建

  func icon(_ name: String) -> NSImage? {
    guard let res = Bundle.main.resourceURL else { return nil }
    guard let img = NSImage(contentsOf: res.appendingPathComponent("icons/\(name).svg")) else { return nil }
    img.size = NSSize(width: 16, height: 16)
    img.isTemplate = true
    return img
  }

  func sectionHeader(_ title: String) -> NSMenuItem {
    if #available(macOS 14.0, *) {
      return NSMenuItem.sectionHeader(title: title)
    }
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.attributedTitle = NSAttributedString(string: title, attributes: [
      .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
      .foregroundColor: NSColor.secondaryLabelColor,
    ])
    item.isEnabled = false
    return item
  }

  func disabledInfo(_ title: String, font: NSFont = NSFont.systemFont(ofSize: 12)) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.attributedTitle = NSAttributedString(string: title, attributes: [
      .font: font,
      .foregroundColor: NSColor.secondaryLabelColor,
    ])
    item.isEnabled = false
    return item
  }

  func applyMenu(serverUp: Bool, tunnelUp: Bool) {
    let menu = NSMenu()
    menu.delegate = self
    menu.autoenablesItems = false

    // ── 分区：连接 ──
    let statusText = "服务：\(serverUp ? "运行中" : "已停止")   隧道：\(tunnelUp ? "运行中" : "已停止")"
    let status = NSMenuItem(title: statusText, action: nil, keyEquivalent: "")
    status.attributedTitle = NSAttributedString(string: statusText, attributes: [
      .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
      .foregroundColor: NSColor.labelColor,
    ])
    status.isEnabled = false
    menu.addItem(status)
    if let masked = maskedURL() {
      let urlItem = disabledInfo(masked, font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular))
      urlItem.title = masked
      menu.addItem(urlItem)
    }
    menu.addItem(.separator())

    let copyItem = menu.addItem(withTitle: "复制连接器 URL（含密钥）", action: #selector(copyURL(_:)), keyEquivalent: "c")
    copyItem.target = self
    copyItem.image = icon("link-2")
    copyItem.isEnabled = serverUp || tunnelUp

    // ── 分区：权限 ──
    menu.addItem(.separator())
    menu.addItem(sectionHeader("权限"))
    let env = envDict()
    let perms: [(String, String, String)] = [
      ("ALLOW_WRITES", "写文件", "file-pen"),
      ("ALLOW_SHELL", "命令执行", "terminal"),
      ("ALLOW_SCREENSHOT", "截屏", "camera"),
      ("ALLOW_OPEN", "打开应用 / URL", "external-link"),
      ("ALLOW_APPLESCRIPT", "AppleScript 自动化", "bot"),
    ]
    for (key, label, iconName) in perms {
      let on = env[key] == "1"
      let item = NSMenuItem(title: "\(on ? "✓ " : "　")\(label)", action: #selector(togglePerm(_:)), keyEquivalent: "")
      item.target = self
      item.image = icon(iconName)
      item.representedObject = key
      menu.addItem(item)
    }
    menu.addItem(disabledInfo("　　点击切换 · 自动重启服务后生效", font: NSFont.systemFont(ofSize: 11)))

    // ── 分区：服务 ──
    menu.addItem(.separator())
    menu.addItem(sectionHeader("服务"))
    let restart = menu.addItem(withTitle: "重启服务", action: #selector(restartAction(_:)), keyEquivalent: "r")
    restart.target = self
    restart.image = icon("refresh-cw")
    let stop = menu.addItem(withTitle: "停止服务与隧道", action: #selector(stopAction(_:)), keyEquivalent: "")
    stop.target = self
    stop.image = icon("power")
    stop.isEnabled = serverUp || tunnelUp

    // ── 分区：资源 ──
    menu.addItem(.separator())
    menu.addItem(sectionHeader("资源"))
    let guideItem = menu.addItem(withTitle: "编辑 GUIDE.md（连接引导）", action: #selector(editGuide(_:)), keyEquivalent: "g")
    guideItem.target = self
    guideItem.image = icon("notebook-pen")
    let logs = menu.addItem(withTitle: "打开日志文件夹", action: #selector(openLogs(_:)), keyEquivalent: "")
    logs.target = self
    logs.image = icon("folder-open")
    let projItem = menu.addItem(withTitle: "打开项目文件夹", action: #selector(openProj(_:)), keyEquivalent: "")
    projItem.target = self
    projItem.image = icon("folder-code")

    menu.addItem(.separator())
    menu.addItem(disabledInfo("　　退出 App 后，服务与隧道保持运行", font: NSFont.systemFont(ofSize: 11)))
    let quit = menu.addItem(withTitle: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    quit.target = NSApp
    quit.image = icon("log-out")

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
  @objc func editGuide(_ sender: NSMenuItem) {
    let guidePath = proj + "/GUIDE.md"
    if !FileManager.default.fileExists(atPath: guidePath) {
      try? "# MCP 连接引导（用户自定义）\n\n- 每行一条引导建议，保存即生效，无需重启服务。\n- 服务端会过滤以 # 或 > 开头的行。\n".write(toFile: guidePath, atomically: true, encoding: .utf8)
    }
    Self.runShell("/usr/bin/open -t '\(proj)/GUIDE.md'")
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
