namespace Astra.Backend.Models;

/// <summary>Roles allowed on a stored message.</summary>
public static class MessageRoles
{
    public static bool IsValid(string? role) =>
        role is Roles.User or Roles.Assistant or Roles.System;
}

/// <summary>One persisted message belonging to exactly one conversation.</summary>
public sealed record StoredMessage(
    string Id,
    string ConversationId,
    string Role,
    string Content,
    DateTimeOffset CreatedAt,
    string? Status,
    string? Metadata);

/// <summary>Conversation metadata without the message payload (sidebar row).</summary>
public sealed record ConversationSummary(
    string Id,
    string Title,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    bool Pinned,
    bool Archived,
    bool TitleManual,
    int MessageCount);

/// <summary>Conversation metadata plus its messages.</summary>
public sealed record ConversationDetail(
    string Id,
    string Title,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    bool Pinned,
    bool Archived,
    bool TitleManual,
    IReadOnlyList<StoredMessage> Messages);

/// <summary>POST /api/chats body.</summary>
public sealed record CreateConversationRequest(string? Title);

/// <summary>PATCH-style update: only supplied fields change.</summary>
public sealed record UpdateConversationRequest(
    string? Title,
    bool? Pinned,
    bool? Archived,
    bool? TitleManual);
