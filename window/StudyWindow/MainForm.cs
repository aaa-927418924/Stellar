using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace StudyWindow;

public sealed class MainForm : Form
{
    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

    private const int WM_NCLBUTTONDOWN = 0xA1;
    private const int HTCAPTION = 2;

    private readonly WebView2 view = new() { Dock = DockStyle.Fill };
    private Process? backend;
    private bool ownsBackend = true;

    public MainForm()
    {
        Text = "Study App";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1320, 850);
        MinimumSize = new Size(900, 600);
        FormBorderStyle = FormBorderStyle.None;
        BackColor = Color.FromArgb(0x17, 0x17, 0x17);
        Controls.Add(view);
        view.DefaultBackgroundColor = Color.FromArgb(0x17, 0x17, 0x17);
        view.WebMessageReceived += OnWebMessage;
        Resize += (_, _) => PostMaxState();
        FormClosing += OnClosing;
        Load += async (_, _) => await InitializeAsync();
    }

    private static string BackendPath()
    {
        var dir = AppContext.BaseDirectory;
        var backend = Path.Combine(dir, "StudyApp.Server.exe");
        if (File.Exists(backend)) return backend;
        throw new FileNotFoundException("バックエンドが見つかりません: " + backend);
    }

    private static string InstancePath()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return Path.Combine(appData, "StudyApp", "data", "instance.json");
    }

    private async Task InitializeAsync()
    {
        string backendPath;
        try
        {
            backendPath = BackendPath();
        }
        catch (Exception error)
        {
            Fail(error.Message);
            return;
        }

        try
        {
            var dataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "StudyApp", "webview");
            Directory.CreateDirectory(dataDir);
            var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
            await view.EnsureCoreWebView2Async(env);
        }
        catch (Exception error)
        {
            Fail("WebView2を初期化できません: " + error.Message);
            return;
        }

        view.NavigationCompleted += (_, _) => PostMaxState();
        StartBackend(backendPath);
        var url = await WaitForLaunchUrlAsync(TimeSpan.FromSeconds(60));
        if (url == null)
        {
            Fail("バックエンドが起動しませんでした。");
            return;
        }
        view.CoreWebView2.Navigate(url);
    }

    private void StartBackend(string backendPath)
    {
        var start = new ProcessStartInfo(backendPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(backendPath) ?? AppContext.BaseDirectory,
        };
        start.Environment["STUDY_NO_BROWSER"] = "1";
        var child = new Process { StartInfo = start, EnableRaisingEvents = true };
        child.OutputDataReceived += (_, args) =>
        {
            if (args.Data != null && args.Data.Contains("既に起動しています")) ownsBackend = false;
        };
        try
        {
            if (!child.Start()) throw new InvalidOperationException("バックエンドを開始できません。");
            child.BeginOutputReadLine();
            backend = child;
        }
        catch (Exception error)
        {
            Fail("バックエンドを開始できません: " + error.Message);
        }
    }

    private static async Task<string?> WaitForLaunchUrlAsync(TimeSpan timeout)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var json = await File.ReadAllTextAsync(InstancePath());
                using var document = JsonDocument.Parse(json);
                var root = document.RootElement;
                var port = root.GetProperty("port").GetInt32();
                var secret = root.GetProperty("secret").GetString();
                var url = $"http://127.0.0.1:{port}/?launch={secret}";
                var response = await http.GetAsync(url);
                if ((int)response.StatusCode is 302 or 200) return url;
            }
            catch
            {
                // 起動途中。ポーリングを続ける。
            }
            await Task.Delay(500);
        }
        return null;
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        string type;
        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            type = document.RootElement.GetProperty("type").GetString() ?? "";
        }
        catch
        {
            return;
        }
        switch (type)
        {
            case "min":
                WindowState = FormWindowState.Minimized;
                break;
            case "max":
                WindowState = WindowState == FormWindowState.Maximized
                    ? FormWindowState.Normal
                    : FormWindowState.Maximized;
                break;
            case "close":
                Close();
                break;
            case "drag":
                ReleaseCapture();
                SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
                break;
        }
    }

    private void PostMaxState()
    {
        try
        {
            view.CoreWebView2?.PostWebMessageAsString(
                JsonSerializer.Serialize(new
                {
                    type = "maxstate",
                    maximized = WindowState == FormWindowState.Maximized,
                }));
        }
        catch
        {
            // 移動前は無視する。
        }
    }

    private void OnClosing(object? sender, FormClosingEventArgs args)
    {
        if (ownsBackend && backend is { HasExited: false })
        {
            try { KillTree(backend.Id); } catch { /* ignore */ }
        }
    }

    private static void KillTree(int pid)
    {
        foreach (var child in ChildrenOf(pid)) KillTree(child);
        try
        {
            using var process = Process.GetProcessById(pid);
            process.Kill();
        }
        catch (ArgumentException)
        {
            // 既に終了している。
        }
        catch (InvalidOperationException)
        {
            // 既に終了している。
        }
    }

    private static IEnumerable<int> ChildrenOf(int pid)
    {
        var children = new List<int>();
        using var searcher = new System.Management.ManagementObjectSearcher(
            $"Select ProcessId From Win32_Process Where ParentProcessId={pid}");
        foreach (var obj in searcher.Get())
        {
            if (int.TryParse(obj["ProcessId"]?.ToString(), out var child)) children.Add(child);
        }
        return children;
    }

    private void Fail(string message)
    {
        MessageBox.Show(this, message, "Study App", MessageBoxButtons.OK, MessageBoxIcon.Error);
        BeginInvoke(Application.Exit);
    }
}
