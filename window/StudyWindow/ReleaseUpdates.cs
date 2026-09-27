using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace StudyWindow;

internal sealed record AvailableUpdate(string Version, string DownloadUrl, string? Digest);

internal static class ReleaseUpdates
{
    private const string LatestUrl = "https://api.github.com/repos/aaa-927418924/Stellar/releases/latest";
    private const string AssetName = "Stellar-win-x64.zip";
    private static readonly HttpClient Client = new() { Timeout = TimeSpan.FromSeconds(120) };

    static ReleaseUpdates()
    {
        Client.DefaultRequestHeaders.UserAgent.ParseAdd("Stellar-Desktop-Updater");
        Client.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
    }

    internal static async Task<AvailableUpdate?> CheckAsync()
    {
        using var response = await Client.GetAsync(LatestUrl);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound) return null;
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStreamAsync());
        var release = json.RootElement;
        if (release.GetProperty("draft").GetBoolean() || release.GetProperty("prerelease").GetBoolean()) return null;
        var tag = release.GetProperty("tag_name").GetString() ?? "";
        if (!Version.TryParse(tag.TrimStart('v', 'V'), out var latest) ||
            latest <= Assembly.GetExecutingAssembly().GetName().Version) return null;
        foreach (var asset in release.GetProperty("assets").EnumerateArray())
        {
            if (asset.GetProperty("name").GetString() != AssetName) continue;
            var url = asset.GetProperty("browser_download_url").GetString() ?? "";
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
                uri.Host != "github.com") return null;
            var digest = asset.TryGetProperty("digest", out var hash) ? hash.GetString() : null;
            return new AvailableUpdate(latest.ToString(3), url, digest);
        }
        return null;
    }

    internal static async Task<string> PrepareAsync(AvailableUpdate update)
    {
        var staging = Path.Combine(Path.GetTempPath(), "Stellar-update-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            var zipPath = Path.Combine(staging, AssetName);
            using (var response = await Client.GetAsync(update.DownloadUrl, HttpCompletionOption.ResponseHeadersRead))
            {
                response.EnsureSuccessStatusCode();
                if (response.Content.Headers.ContentLength > 250_000_000) throw new InvalidDataException("更新ファイルが大きすぎます。");
                await using var input = await response.Content.ReadAsStreamAsync();
                await using var output = File.Create(zipPath);
                var buffer = new byte[81920];
                long size = 0;
                int count;
                while ((count = await input.ReadAsync(buffer)) > 0)
                {
                    size += count;
                    if (size > 250_000_000) throw new InvalidDataException("更新ファイルが大きすぎます。");
                    await output.WriteAsync(buffer.AsMemory(0, count));
                }
            }
            if (update.Digest is { } digest && digest.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
            {
                await using var file = File.OpenRead(zipPath);
                var actual = Convert.ToHexString(await SHA256.HashDataAsync(file));
                if (!actual.Equals(digest[7..], StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("更新ファイルの検証に失敗しました。");
            }
            using (var archive = ZipFile.OpenRead(zipPath))
            {
                var expected = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Stellar.exe" };
                foreach (var entry in archive.Entries)
                {
                    if (!expected.Remove(entry.FullName) || entry.Length > 150_000_000)
                        throw new InvalidDataException("更新ファイルの内容が正しくありません。");
                    entry.ExtractToFile(Path.Combine(staging, entry.FullName));
                }
                if (expected.Count != 0) throw new InvalidDataException("更新に必要なファイルがありません。");
            }
            var version = FileVersionInfo.GetVersionInfo(Path.Combine(staging, "Stellar.exe")).ProductVersion;
            if (version == null || !Regex.IsMatch(version, "^" + Regex.Escape(update.Version) + "(?:[.+]|$)"))
                throw new InvalidDataException("更新ファイルのバージョンが一致しません。");
            using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("StudyWindow.apply-update.ps1")
                ?? throw new InvalidDataException("更新プログラムが見つかりません。");
            await using var script = File.Create(Path.Combine(staging, "apply-update.ps1"));
            await resource.CopyToAsync(script);
            return staging;
        }
        catch
        {
            try { Directory.Delete(staging, true); } catch { /* ignore */ }
            throw;
        }
    }

    internal static void Apply(string staging, int pid)
    {
        var start = new ProcessStartInfo("powershell.exe") { UseShellExecute = false, CreateNoWindow = true };
        foreach (var arg in new[] { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                     Path.Combine(staging, "apply-update.ps1"), "-ParentPid", pid.ToString(),
                     "-InstallDir", AppContext.BaseDirectory, "-StagingDir", staging })
            start.ArgumentList.Add(arg);
        if (Process.Start(start) == null) throw new InvalidOperationException("更新プログラムを起動できません。");
    }
}
