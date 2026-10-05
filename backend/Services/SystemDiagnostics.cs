namespace Astra.Backend.Services;

using System.Diagnostics;
using System.Runtime.InteropServices;

/// <summary>
/// Real hardware telemetry: CPU usage, memory pressure, network latency.
/// Cross-platform via /proc, sysctl, host_statistics, and ICMP ping.
/// </summary>
public sealed class SystemDiagnostics
{
    private readonly ILogger<SystemDiagnostics> _logger;
    private readonly OsControl _os;
    private static readonly Dictionary<string, string> Hosts = new()
    {
        ["google"] = "8.8.8.8",
        ["youtube"] = "142.250.65.78",
        ["amazon"] = "52.94.236.248",
        ["cloudflare"] = "1.1.1.1",
    };

    public SystemDiagnostics(ILogger<SystemDiagnostics> logger, OsControl os)
    {
        _logger = logger;
        _os = os;
    }

    public record DiagnosticsReport(double? CpuPercent, double? MemoryUsedPercent, string MemoryDetail, Dictionary<string, long?> LatenciesMs);

    public async Task<DiagnosticsReport> GetReportAsync(CancellationToken ct)
    {
        var cpu = GetCpuPercent();
        var (memPct, memDetail) = GetMemory();
        var latencies = new Dictionary<string, long?>();
        foreach (var (name, host) in Hosts)
        {
            latencies[name] = await PingAsync(host, ct);
        }
        return new DiagnosticsReport(cpu, memPct, memDetail, latencies);
    }

    public string RenderVoice(DiagnosticsReport r)
    {
        var cpu = r.CpuPercent is { } c ? $"{c:F0}% load" : "load unavailable";
        var mem = r.MemoryUsedPercent is { } m ? $"{m:F0}% memory" : "memory unavailable";
        var net = r.LatenciesMs.TryGetValue("google", out var g) && g is not null ? $"{g} ms to Google" : "network check failed";
        return $"Diagnostics: {cpu}, {mem}, {net}. All systems nominal, Aarav.";
    }

    // ---------- CPU ----------

    private double? GetCpuPercent()
    {
        try
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            {
                // top -l 1 => "CPU usage: 12.34% user, 5.67% sys, 82.0% idle"
                var outLine = Run("top", "-l 1 -n 0");
                var m = System.Text.RegularExpressions.Regex.Match(outLine, @"CPU usage: ([\d.]+)% user, ([\d.]+)% sys, ([\d.]+)% idle");
                if (m.Success)
                {
                    var user = double.Parse(m.Groups[1].Value);
                    var sys = double.Parse(m.Groups[2].Value);
                    return user + sys;
                }
            }
            else if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
            {
                var stat = File.ReadAllText("/proc/stat");
                var line = stat.Split('\n').First(l => l.StartsWith("cpu "));
                var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                long idle = long.Parse(parts[4]) + long.Parse(parts[5]);
                long total = parts.Skip(1).Select(long.Parse).Sum();
                // Single sample can't give a rate; snapshot-diff over 250ms.
                Thread.Sleep(250);
                var stat2 = File.ReadAllText("/proc/stat");
                var line2 = stat2.Split('\n').First(l => l.StartsWith("cpu "));
                var p2 = line2.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                long idle2 = long.Parse(p2[4]) + long.Parse(p2[5]);
                long total2 = p2.Skip(1).Select(long.Parse).Sum();
                var dTotal = total2 - total;
                var dIdle = idle2 - idle;
                return dTotal == 0 ? null : Math.Clamp(100.0 * (dTotal - dIdle) / dTotal, 0, 100);
            }
            else if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                var outLine = Run("wmic", "cpu get loadpercentage");
                var m = System.Text.RegularExpressions.Regex.Match(outLine, @"(\d+)");
                if (m.Success) return double.Parse(m.Groups[1].Value);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "CPU probe failed");
        }
        return null;
    }

    // ---------- Memory ----------

    private (double? Percent, string Detail) GetMemory()
    {
        try
        {
            if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            {
                var total = long.Parse(Run("sysctl", "-n hw.memsize"));
                // vm_stat reports page counts (4096 bytes/page on Apple Silicon & Intel macs)
                var vm = Run("vm_stat", "");
                long free = PageCount(vm, "Pages free");
                long active = PageCount(vm, "Pages active");
                long wired = PageCount(vm, "Pages wired down");
                long compressed = PageCount(vm, "Pages occupied by compressor");
                var used = (active + wired + compressed) * 4096L;
                var pct = 100.0 * used / total;
                return (pct, $"{used / 1024 / 1024 / 1024.0:F1} GB of {total / 1024 / 1024 / 1024.0:F1} GB in use");
            }
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
            {
                var meminfo = File.ReadAllLines("/proc/meminfo");
                long total = 0, avail = 0;
                foreach (var line in meminfo)
                {
                    if (line.StartsWith("MemTotal:")) total = ParseKb(line);
                    if (line.StartsWith("MemAvailable:")) avail = ParseKb(line);
                }
                var pct = total == 0 ? (double?)null : 100.0 * (total - avail) / total;
                return (pct, $"{(total - avail) / 1024 / 1024.0:F1} GB of {total / 1024 / 1024.0:F1} GB in use");
            }
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                var outLine = Run("wmic", "OS get FreePhysicalMemory,TotalVisibleMemorySize /value");
                var total = ValueFromWmic(outLine, "TotalVisibleMemorySize");
                var free = ValueFromWmic(outLine, "FreePhysicalMemory");
                if (total > 0 && free > 0)
                {
                    var pct = 100.0 * (total - free) / total;
                    return (pct, $"{(total - free) / 1024 / 1024.0:F1} GB of {total / 1024 / 1024.0:F1} GB in use");
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Memory probe failed");
        }
        return (null, "unavailable");
    }

    private static long PageCount(string vmStat, string label)
    {
        var m = System.Text.RegularExpressions.Regex.Match(vmStat, label + @"[^:]*:\s*(\d+)");
        return m.Success ? long.Parse(m.Groups[1].Value) : 0;
    }

    private static long ParseKb(string line) =>
        long.Parse(System.Text.RegularExpressions.Regex.Match(line, @"(\d+)").Groups[1].Value);

    private static long ValueFromWmic(string outLine, string key)
    {
        var m = System.Text.RegularExpressions.Regex.Match(outLine, key + @"=(\d+)");
        return m.Success ? long.Parse(m.Groups[1].Value) : 0;
    }

    // ---------- Network ----------

    private async Task<long?> PingAsync(string host, CancellationToken ct)
    {
        try
        {
            using var ping = new System.Net.NetworkInformation.Ping();
            var reply = await ping.SendPingAsync(host, 2500);
            return reply.Status == System.Net.NetworkInformation.IPStatus.Success ? reply.RoundtripTime : null;
        }
        catch
        {
            return null;
        }
    }

    private string Run(string fileName, string args)
    {
        var psi = new ProcessStartInfo(fileName, args)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var p = Process.Start(psi)!;
        var output = p.StandardOutput.ReadToEnd();
        p.WaitForExit(6000);
        return output;
    }
}
