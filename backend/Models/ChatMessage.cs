namespace Astra.Backend.Models;

/// <summary>Roles in a conversation, matching the OpenAI-compatible convention.</summary>
public static class Roles
{
    public const string System = "system";
    public const string User = "user";
    public const string Assistant = "assistant";
}

/// <summary>One message in a conversation (engine-facing shape).</summary>
public record ChatMessage(string Role, string Content);

/// <summary>
/// Incoming chat request from the frontend.
///
/// <see cref="ConversationId"/> is the routing key: history is always loaded
/// from that conversation on the server, so two chats can never share context.
/// <see cref="History"/> is ignored — kept only so older clients still bind.
/// <see cref="ProposedTitle"/> is a local, non-LLM automatic title suggestion
/// used while the conversation is still empty.
/// </summary>
public record ChatRequest(
    string? SessionId,
    string Message,
    IReadOnlyList<ChatMessage>? History,
    string? ConversationId,
    string? ProposedTitle);

/// <summary>Metadata about the active engine, returned by /api/status.</summary>
public record EngineStatus(string Provider, string Model, bool Online, string Note);
