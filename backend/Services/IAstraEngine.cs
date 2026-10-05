namespace Astra.Backend.Services;

using Astra.Backend.Models;

/// <summary>A pluggable "brain" for Astra. Implementations produce a token-by-token reply stream.</summary>
public interface IAstraEngine
{
    /// <summary>Human-readable provider name (e.g. "demo", "openai").</summary>
    string Provider { get; }

    /// <summary>Model identifier reported to the client (may be a label for the demo engine).</summary>
    string Model { get; }

    /// <summary>Whether this engine can currently produce replies.</summary>
    bool IsOnline { get; }

    /// <summary>Extra detail for /api/status.</summary>
    string Note { get; }

    /// <summary>
    /// Streams a reply for the given conversation, token by token.
    /// <paramref name="clientTag"/> is an opaque per-chat-session id (the proxy uses it to
    /// route the request onto a persistent agent session).
    /// </summary>
    IAsyncEnumerable<string> StreamReplyAsync(
        IReadOnlyList<ChatMessage> conversation,
        string? clientTag = null,
        CancellationToken cancellationToken = default);
}
