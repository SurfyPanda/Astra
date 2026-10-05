namespace Astra.Backend.Services;

using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

/// <summary>
/// Thin, cross-platform OS control: open URLs/files/apps, type text, press keys.
/// Deliberately narrow by design — no arbitrary shell execution.
/// </summary>
public sealed class OsControl
{
    private readonly ILogger<OsControl> _logger;
    private readonly IConfiguration _config;

    public OsControl(ILogger<OsControl> logger, IConfiguration config)
    {
        _logger = logger;
        _config = config;
    }

    private static bool IsWindows => RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
    private static bool IsMac => RuntimeInformation.IsOSPlatform(OSPlatform.OSX);
    private static bool IsLinux => RuntimeInformation.IsOSPlatform(OSPlatform.Linux);

    private static string Win => "cmd /c start";
    private static string Mac => "open";
    private static string Linux => "xdg-open";

    private string TypeKillSwitch => _config["Astra:Agent:AllowTyping"] ?? "true";

    /// <summary>Opens a URL or file path with the OS default handler.</summary>
    public void OpenUrlOrFile(string target)
    {
        var escaped = CommandEscape(target);
        var psi = IsMac
            ? new ProcessStartInfo(Mac, escaped)
            : IsWindows
                ? new ProcessStartInfo($"{Win} \"{target}\"")
                : new ProcessStartInfo(Linux, escaped);
        psi.UseShellExecute = IsMac || IsLinux;
        Process.Start(psi);
        _logger.LogInformation("Opened {Target}", target);
    }

    /// <summary>Opens a macOS application by name (uses `open -a`).</summary>
    public void OpenMacApp(string appName)
    {
        Process.Start(new ProcessStartInfo(Mac, $"-a {QuoteForShell(appName)}") { UseShellExecute = false });
        _logger.LogInformation("Opened macOS app {App}", appName);
    }

    /// <summary>Opens a Windows application by name via its App Paths registry entry.</summary>
    [SupportedOSPlatform("windows")]
    public bool TryOpenWindowsApp(string appName)
    {
        // Look up under HKLM/HKCU Software\Microsoft\Windows\CurrentVersion\App Paths
        foreach (var root in new[] { Microsoft.Win32.Registry.LocalMachine, Microsoft.Win32.Registry.CurrentUser })
        {
            using var key = root.OpenSubKey($@"Software\Microsoft\Windows\CurrentVersion\App Paths\{appName}.exe");
            var value = key?.GetValue(null) as string;
            if (!string.IsNullOrWhiteSpace(value))
            {
                var exe = value; // may contain quotes; start via shell
                Process.Start(new ProcessStartInfo("cmd", $"/c start \"\" \"{exe}\"") { UseShellExecute = true });
                _logger.LogInformation("Opened Windows app {App} -> {Exe}", appName, exe);
                return true;
            }
        }
        return false;
    }

    /// <summary>Best-effort app opening, OS-aware. Returns false when the OS reports failure.</summary>
    public bool TryOpenApp(string appName)
    {
        if (IsMac)
        {
            // `open -a` exits non-zero when the app doesn't exist.
            var psi = new ProcessStartInfo(Mac, $"-a {QuoteForShell(appName)}") { UseShellExecute = false, RedirectStandardError = true };
            using var p = Process.Start(psi)!;
            p.WaitForExit(8000);
            if (p.ExitCode != 0)
            {
                _logger.LogDebug("macOS open -a failed for {App}", appName);
                return false;
            }
            _logger.LogInformation("Opened macOS app {App}", appName);
            return true;
        }
        if (IsWindows) return TryOpenWindowsApp(appName);
        if (IsLinux)
        {
            Process.Start(new ProcessStartInfo("sh", $"-c \"command -v {CommandEscape(appName)} >/dev/null && nohup {CommandEscape(appName)} >/dev/null 2>&1 &\"") { UseShellExecute = false });
            return true;
        }
        return false;
    }

    /// <summary>Types the given text via macOS Accessibility API. Requires the granted permission.</summary>
    public bool TryTypeText(string text, out string? error)
    {
        error = null;
        if (!bool.TryParse(TypeKillSwitch, out var allow) || !allow)
        {
            error = "Typing is disabled by configuration (Astra:Agent:AllowTyping).";
            return false;
        }

        if (IsMac)
        {
            // Requires the Accessibility (or Automation → System Events) permission for the host terminal/app.
            var script = $"on run argv\n  tell application \"System Events\" to keystroke \"{AppleScriptEscape(text)}\"\nend run";
            var psi = new ProcessStartInfo("osascript", $"- {QuoteForShell(script)}") { UseShellExecute = false, RedirectStandardError = true };
            using var p = Process.Start(psi)!;
            var err = p.StandardError.ReadToEnd();
            p.WaitForExit(5000);
            if (p.ExitCode != 0)
            {
                error = string.IsNullOrWhiteSpace(err)
                    ? "macOS refused the synthetic keystroke (Accessibility permission)."
                    : err.Trim();
                return false;
            }
            return true;
        }

        if (IsWindows)
        {
            // PowerShell SendKeys via System.Windows.Forms — no extra deps.
            var escapedText = text
                .Replace("'", "''")
                .Replace("[", "{{[")
                .Replace("]", "{{]")
                .Replace("%", "{%}")
                .Replace("^", "{^}")
                .Replace("+", "{+}")
                .Replace("~", "{~}")
                .Replace("(", "{{(}")
                .Replace(")", "{{)}");
            var ps = $"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{escapedText}')";
            var psi = new ProcessStartInfo("powershell", $"-NoProfile -Command \"{ps.Replace("\"", "\\\"")}\"") { UseShellExecute = false, RedirectStandardError = true };
            using var p = Process.Start(psi)!;
            var err = p.StandardError.ReadToEnd();
            p.WaitForExit(5000);
            if (p.ExitCode != 0)
            {
                error = string.IsNullOrWhiteSpace(err) ? "Windows refused SendKeys." : err.Trim();
                return false;
           }
            return true;
        }

        if (IsLinux)
        {
            var psi = new ProcessStartInfo("sh", $"-c \"command -v xdotool >/dev/null && xdotool type -- {QuoteForShell(text)} || echo NEED_XDOTOOL\"") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            using var p = Process.Start(psi)!;
            var output = p.StandardOutput.ReadToEnd();
            p.WaitForExit(5000);
            if (output.Contains("NEED_XDOTOOL"))
            {
                error = "Install xdotool for typing support on Linux.";
                return false;
            }
            if (p.ExitCode != 0)
            {
                error = string.IsNullOrWhiteSpace(output) ? "xdotool failed." : output.Trim();
                return false;
            }
            return true;
        }

        error = "Typing is not supported on this OS.";
        return false;
    }

    /// <summary>Presses a named key or chord (enter, tab, cmd+t, ctrl+c…).</summary>
    public bool TryPressKey(string key, out string? error)
    {
        error = null;
        if (!bool.TryParse(TypeKillSwitch, out var allow) || !allow)
        {
            error = "Typing is disabled by configuration (Astra:Agent:AllowTyping).";
            return false;
        }

        if (IsMac)
        {
            // Named-chord handling: support modifiers cmd/ctrl/alt/option/shift + main key.
            var main = key.Trim().ToLowerInvariant();
            var mods = "";
            foreach (var (token, mod) in new[] {
                ( "cmd", "command down" ), ( "command", "command down" ),
                ( "ctrl", "control down" ), ( "control", "control down" ),
                ( "alt", "option down" ), ( "option", "option down" ),
                ( "shift", "shift down" ),
            })
            {
                if (main.StartsWith(token + "+"))
                {
                    mods += mod + ", ";
                    main = main.Substring(token.Length + 1);
                }
            }
            var keyExpr = main.Length == 1
                ? $"keystroke \"{main}\""
                : $"key code {MacKeyCode(main) ?? -1}";
            if (keyExpr.EndsWith("-1")) { error = $"Unknown key '{main}'."; return false; }
            if (!string.IsNullOrEmpty(mods)) keyExpr += $" using {{{mods.TrimEnd(',', ' ')}}}";
            var script = $"on run argv\n  tell application \"System Events\" to {keyExpr}\nend run";
            return RunOsascript(script, out error);
        }

        if (IsWindows)
        {
            var special = key.ToLowerInvariant() switch
            {
                "enter" or "return" => "{ENTER}",
                "tab" => "{TAB}",
                "esc" or "escape" => "{ESC}",
                "backspace" => "{BACKSPACE}",
                "delete" or "del" => "{DELETE}",
                "space" => " ",
                "up" => "{UP}",
                "down" => "{DOWN}",
                "left" => "{LEFT}",
                "right" => "{RIGHT}",
                "home" => "{HOME}",
                "end" => "{END}",
                "pageup" => "{PGUP}",
                "pagedown" => "{PGDN}",
                _ when key.Length == 1 => key,
                _ => null,
            };
            if (special is null) { error = $"Unknown key '{key}'."; return false; }
            var ps = $"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{special}')";
            var psi = new ProcessStartInfo("powershell", $"-NoProfile -Command \"{ps.Replace("\"", "\\\"")}\"") { UseShellExecute = false, RedirectStandardError = true };
            using var p = Process.Start(psi)!;
            p.WaitForExit(5000);
            if (p.ExitCode != 0) { error = "Windows refused SendKeys."; return false; }
            return true;
        }

        if (IsLinux)
        {
            var k = key.ToLowerInvariant() switch
            {
                "enter" or "return" => "Return",
                "tab" => "Tab",
                "esc" or "escape" => "Escape",
                "backspace" => "BackSpace",
                "delete" or "del" => "Delete",
                "space" => "space",
                "up" => "Up",
                "down" => "Down",
                "left" => "Left",
                "right" => "Right",
                _ when key.Length == 1 => key,
                _ => null,
            };
            if (k is null) { error = $"Unknown key '{key}'."; return false; }
            var psi = new ProcessStartInfo("sh", $"-c \"command -v xdotool >/dev/null && xdotool key {k} || echo NEED_XDOTOOL\"") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            using var p = Process.Start(psi)!;
            var output = p.StandardOutput.ReadToEnd();
            p.WaitForExit(5000);
            if (output.Contains("NEED_XDOTOOL")) { error = "Install xdotool for key support on Linux."; return false; }
            return p.ExitCode == 0;
        }

        error = "Key pressing is not supported on this OS.";
        return false;
    }

    private bool RunOsascript(string script, out string? error)
    {
        var psi = new ProcessStartInfo("osascript", $"- {QuoteForShell(script)}") { UseShellExecute = false, RedirectStandardError = true };
        using var p = Process.Start(psi)!;
        var err = p.StandardError.ReadToEnd();
        p.WaitForExit(5000);
        if (p.ExitCode != 0)
        {
            error = string.IsNullOrWhiteSpace(err) ? "macOS refused the synthetic key event (Accessibility permission)." : err.Trim();
            return false;
        }
        error = null;
        return true;
    }

    private static int? MacKeyCode(string name) => name switch
    {
        "enter" or "return" => 36,
        "tab" => 48,
        "space" => 49,
        "delete" or "backspace" => 51,
        "escape" or "esc" => 53,
        "up" => 126,
        "down" => 125,
        "left" => 123,
        "right" => 124,
        "home" => 115,
        "end" => 119,
        "pageup" => 116,
        "pagedown" => 121,
        "forwarddelete" => 117,
        _ => null,
    };

    private static string CommandEscape(string s) => s.Replace("\"", "\\\"");
    private static string QuoteForShell(string s) => "'" + s.Replace("'", "'\\''") + "'";
    private static string AppleScriptEscape(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"");
}
