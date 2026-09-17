// MCP 本地控制 · Windows 托盘控制中心
// 单文件 WinForms 应用，.NET Framework 4.x（Windows 系统自带 csc.exe 可编译）
// 功能与 macOS 菜单栏版一致：幂等拉起服务与隧道、复制连接器 URL、
// 权限开关（改 .env 自动重启）、重启/停止、打开日志与项目文件夹。
// 仅使用 C# 5 语法，保证系统自带 csc.exe 可直接编译。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace McpTray
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayContext());
        }
    }

    public class TrayContext : ApplicationContext
    {
        readonly string proj;
        readonly string envPath;
        readonly string logDir;
        readonly string tunnelName = "chatgpt-local-mcp";

        NotifyIcon tray;
        ContextMenuStrip menu;
        System.Windows.Forms.Timer timer;
        Form host;
        Icon iconGreen, iconOrange, iconGray;
        bool serverUp;
        bool tunnelUp;

        public TrayContext()
        {
            proj = ResolveProj();
            envPath = Path.Combine(proj, ".env");
            logDir = Path.Combine(proj, ".mcp-logs");
            try { Directory.CreateDirectory(logDir); } catch { }

            iconGreen = MakeIcon(Color.FromArgb(52, 199, 89));
            iconOrange = MakeIcon(Color.FromArgb(255, 159, 10));
            iconGray = MakeIcon(Color.FromArgb(142, 142, 147));

            // 隐藏宿主窗体：供后台线程把 UI 更新调度回 UI 线程
            host = new Form();
            host.ShowInTaskbar = false;
            host.FormBorderStyle = FormBorderStyle.None;
            host.Opacity = 0;
            host.Show();
            host.Hide();

            menu = new ContextMenuStrip();
            menu.Opening += delegate { RebuildMenu(); };

            tray = new NotifyIcon();
            tray.Text = "MCP 本地控制";
            tray.ContextMenuStrip = menu;
            tray.Icon = iconGray;
            tray.Visible = true;
            tray.DoubleClick += delegate { CopyUrl(); };

            EnsureServices();
            RefreshStatus();

            timer = new System.Windows.Forms.Timer();
            timer.Interval = 5000;
            timer.Tick += delegate { RefreshStatus(); };
            timer.Start();
        }

        string ResolveProj()
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            if (File.Exists(Path.Combine(dir, ".env"))) return dir;
            string parent = Path.GetFullPath(Path.Combine(dir, ".."));
            if (File.Exists(Path.Combine(parent, ".env"))) return parent;
            return dir;
        }

        static Icon MakeIcon(Color c)
        {
            using (Bitmap b = new Bitmap(16, 16))
            using (Graphics g = Graphics.FromImage(b))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.FillEllipse(new SolidBrush(c), 2, 2, 12, 12);
                g.DrawEllipse(new Pen(Color.FromArgb(60, 0, 0, 0)), 2, 2, 12, 12);
                return Icon.FromHandle(b.GetHicon());
            }
        }

        // ── 状态检测 ──

        bool ServerUp()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:8787/health");
                req.Timeout = 2000;
                req.ReadWriteTimeout = 2000;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return (int)resp.StatusCode == 200;
                }
            }
            catch { return false; }
        }

        bool TunnelUp()
        {
            return Process.GetProcessesByName("cloudflared").Length > 0;
        }

        void RefreshStatus()
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                bool s = ServerUp();
                bool t = TunnelUp();
                BeginUI(delegate
                {
                    serverUp = s; tunnelUp = t;
                    tray.Icon = (s && t) ? iconGreen : ((s || t) ? iconOrange : iconGray);
                    tray.Text = "MCP 本地控制 — " + ((s && t) ? "全部正常" : ((s || t) ? "部分运行" : "已停止"));
                });
            });
        }

        // ── .env 读写 ──

        string EnvGet(string key)
        {
            try
            {
                string[] lines = File.ReadAllLines(envPath, Encoding.UTF8);
                foreach (string line in lines)
                {
                    string t = line.Trim();
                    if (t.StartsWith(key + "=", StringComparison.OrdinalIgnoreCase))
                        return t.Substring(key.Length + 1).Trim();
                }
            }
            catch { }
            return null;
        }

        void EnvSet(string key, string value)
        {
            try
            {
                string[] lines = File.ReadAllLines(envPath, Encoding.UTF8);
                bool replaced = false;
                for (int i = 0; i < lines.Length; i++)
                {
                    if (lines[i].TrimStart().StartsWith(key + "=", StringComparison.OrdinalIgnoreCase))
                    {
                        lines[i] = key + "=" + value;
                        replaced = true;
                    }
                }
                if (!replaced)
                {
                    string[] nl = new string[lines.Length + 1];
                    lines.CopyTo(nl, 0);
                    nl[lines.Length] = key + "=" + value;
                    lines = nl;
                }
                File.WriteAllLines(envPath, lines, new UTF8Encoding(false));
            }
            catch (Exception ex) { Balloon("写入 .env 失败：" + ex.Message); }
        }

        string ConnectorUrl()
        {
            string b = EnvGet("PUBLIC_MCP_URL");
            string s = EnvGet("SECRET_KEY");
            if (string.IsNullOrEmpty(b) || string.IsNullOrEmpty(s)) return null;
            return b + "?secret-key=" + s;
        }

        string MaskedUrl()
        {
            string b = EnvGet("PUBLIC_MCP_URL");
            string s = EnvGet("SECRET_KEY");
            if (string.IsNullOrEmpty(b) || string.IsNullOrEmpty(s) || s.Length < 13) return null;
            return b + "?secret-key=" + s.Substring(0, 6) + "…" + s.Substring(s.Length - 4);
        }

        // ── 服务管理 ──

        void EnsureServices()
        {
            if (!ServerUp()) StartServer();
            if (!TunnelUp()) StartTunnel();
        }

        void StartServer()
        {
            RunHidden("cmd.exe", "/c cd /d \"" + proj + "\" && npm start >> \"" + logDir + "\\app-server.log\" 2>&1");
        }

        void StartTunnel()
        {
            string cf = FindCloudflared();
            if (cf == null) { Balloon("未找到 cloudflared，请先在项目目录执行 npm install"); return; }
            RunHidden("cmd.exe", "/c \"" + cf + "\" tunnel run " + tunnelName + " >> \"" + logDir + "\\app-tunnel.log\" 2>&1");
        }

        string FindCloudflared()
        {
            string[] candidates = new string[] {
                Path.Combine(proj, @"node_modules\cloudflared\bin\cloudflared.exe"),
                Path.Combine(proj, @"node_modules\cloudflared\lib\cloudflared.exe"),
                Path.Combine(proj, @"node_modules\cloudflared\cloudflared.exe"),
                Path.Combine(proj, @"node_modules\.bin\cloudflared.cmd")
            };
            foreach (string p in candidates)
                if (File.Exists(p)) return p;
            return null;
        }

        bool BootProcessRunning()
        {
            try
            {
                ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT CommandLine FROM Win32_Process");
                foreach (ManagementObject o in searcher.Get())
                {
                    string cl = Convert.ToString(o["CommandLine"]);
                    if (cl != null && cl.IndexOf("scripts\\boot.js", StringComparison.OrdinalIgnoreCase) >= 0)
                        return true;
                }
            }
            catch { }
            return false;
        }

        void KillMatching(string needle)
        {
            try
            {
                ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId,CommandLine FROM Win32_Process");
                foreach (ManagementObject o in searcher.Get())
                {
                    string cl = Convert.ToString(o["CommandLine"]);
                    if (cl != null && cl.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        try { Process.GetProcessById(Convert.ToInt32(o["ProcessId"])).Kill(); } catch { }
                    }
                }
            }
            catch { }
        }

        void StopServer() { KillMatching("scripts\\boot.js"); }

        void StopAll()
        {
            StopServer();
            foreach (Process p in Process.GetProcessesByName("cloudflared"))
                try { p.Kill(); } catch { }
        }

        void RestartServer()
        {
            Background(delegate
            {
                StopServer();
                for (int i = 0; i < 30; i++)
                {
                    Thread.Sleep(200);
                    if (!BootProcessRunning()) break;
                }
                StartServer();
                Thread.Sleep(2500);
                BeginUI(delegate
                {
                    Balloon(ServerUp() ? "服务已重启 ✓" : "服务重启失败，请查看日志");
                    RefreshStatus();
                });
            });
        }

        void RunHidden(string file, string args)
        {
            try
            {
                ProcessStartInfo si = new ProcessStartInfo();
                si.FileName = file;
                si.Arguments = args;
                si.UseShellExecute = false;
                si.CreateNoWindow = true;
                Process.Start(si);
            }
            catch (Exception ex) { Balloon("启动失败：" + ex.Message); }
        }

        // ── UI 帮助 ──

        void BeginUI(MethodInvoker action)
        {
            try { host.BeginInvoke(action); } catch { }
        }

        void Background(Action a) { ThreadPool.QueueUserWorkItem(delegate { a(); }); }

        void Balloon(string text)
        {
            try { tray.ShowBalloonTip(2000, "MCP 本地控制", text, ToolTipIcon.None); } catch { }
        }

        // ── 菜单 ──

        ToolStripMenuItem InfoItem(string text, bool bold)
        {
            ToolStripMenuItem it = new ToolStripMenuItem(text);
            it.Enabled = false;
            if (bold) it.Font = new Font(SystemFonts.MenuFont, FontStyle.Bold);
            return it;
        }

        ToolStripMenuItem InfoItem(string text) { return InfoItem(text, false); }

        void RebuildMenu()
        {
            menu.Items.Clear();
            menu.Items.Add(InfoItem("服务：" + (serverUp ? "运行中" : "已停止") + " · 隧道：" + (tunnelUp ? "运行中" : "已停止"), true));
            string masked = MaskedUrl();
            if (masked != null) menu.Items.Add(InfoItem(masked));
            menu.Items.Add(new ToolStripSeparator());

            menu.Items.Add(new ToolStripMenuItem("复制连接器 URL（含密钥）", null, delegate { CopyUrl(); }));

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(InfoItem("权限"));
            string[,] perms = new string[,] {
                { "ALLOW_WRITES", "写文件" },
                { "ALLOW_SHELL", "命令执行（run_command / run_powershell）" },
                { "ALLOW_SCREENSHOT", "截屏" },
                { "ALLOW_OPEN", "打开应用 / URL" },
                { "ALLOW_GUI", "鼠标键盘" }
            };
            for (int i = 0; i < perms.GetLength(0); i++)
            {
                string key = perms[i, 0];
                string label = perms[i, 1];
                ToolStripMenuItem it = new ToolStripMenuItem(label, null, delegate { TogglePerm(key); });
                it.Checked = EnvGet(key) == "1";
                menu.Items.Add(it);
            }
            menu.Items.Add(InfoItem("点击切换 · 自动重启服务后生效"));

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(InfoItem("服务"));
            menu.Items.Add(new ToolStripMenuItem("重启服务", null, delegate { RestartServer(); }, Keys.Control | Keys.R));
            ToolStripMenuItem stop = new ToolStripMenuItem("停止服务与隧道", null, delegate { StopAll(); Balloon("已停止服务与隧道"); RefreshStatus(); });
            stop.Enabled = serverUp || tunnelUp;
            menu.Items.Add(stop);

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(InfoItem("资源"));
            menu.Items.Add(new ToolStripMenuItem("打开日志文件夹", null, delegate { Process.Start("explorer.exe", "\"" + logDir + "\""); }));
            menu.Items.Add(new ToolStripMenuItem("打开项目文件夹", null, delegate { Process.Start("explorer.exe", "\"" + proj + "\""); }));

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(InfoItem("退出程序后，服务与隧道保持运行"));
            menu.Items.Add(new ToolStripMenuItem("退出", null, delegate { ExitMenuAndApp(); }, Keys.Control | Keys.Q));
        }

        void ExitMenuAndApp()
        {
            timer.Stop();
            tray.Visible = false;
            host.Close();
            Application.Exit();
        }

        void CopyUrl()
        {
            string url = ConnectorUrl();
            if (url == null) { Balloon("读取 .env 失败"); return; }
            try { Clipboard.SetText(url); Balloon("连接器 URL 已复制 ✓"); }
            catch { Balloon("复制失败，请重试"); }
        }

        void TogglePerm(string key)
        {
            string now = EnvGet(key);
            bool on = now == "1";
            EnvSet(key, on ? "0" : "1");
            if (key == "ALLOW_SHELL") EnvSet("ALLOW_UNSAFE_SHELL", on ? "0" : "1");
            Balloon(key + " → " + (on ? "0" : "1") + "，重启服务生效");
            RestartServer();
        }
    }
}
