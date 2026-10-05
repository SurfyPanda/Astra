namespace Astra.Backend.Services;

/// <summary>
/// Validation + sanitization for everything a client may influence.
/// Nothing reaches the store without passing through here first.
/// </summary>
public static class ChatInput
{
    public const int MaxTitleLength = 80;
    public const int MaxMessageLength = 20_000;
    public const int MaxHistoryLength = 200;
    public const string DefaultTitle = "New Chat";

    /// <summary>Conversation ids must look like opaque tokens, never paths or SQL.</summary>
    public static bool IsValidId(string? id) =>
        id is { Length: >= 8 and <= 64 } && id.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');

    /// <summary>Generates a server-side id (used whenever the client id is unusable).</summary>
    public static string NewId() => Guid.NewGuid().ToString("N");

    /// <summary>
    /// Returns a safe title, or null when nothing usable is left.
    /// Control characters are stripped, whitespace collapsed, length capped.
    /// </summary>
    public static string? SanitizeTitle(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return null;

        var cleaned = new string(title
            .Select(c => char.IsControl(c) ? ' ' : c)
            .ToArray());
        cleaned = string.Join(' ', cleaned.Split(' ', StringSplitOptions.RemoveEmptyEntries));

        // Reject titles that are only punctuation/symbols.
        if (!cleaned.Any(char.IsLetterOrDigit)) return null;
        if (cleaned.Length > MaxTitleLength) cleaned = cleaned[..MaxTitleLength].TrimEnd();
        return cleaned.Length == 0 ? null : cleaned;
    }

    /// <summary>Returns a safe message body, or null when it is empty or too large.</summary>
    public static string? SanitizeMessage(string? message)
    {
        if (string.IsNullOrWhiteSpace(message)) return null;
        var body = message.Trim();
        if (body.Length > MaxMessageLength) return null;
        return body;
    }
}
