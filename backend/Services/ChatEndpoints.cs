namespace Astra.Backend.Services;

using Astra.Backend.Models;

/// <summary>
/// Conversation CRUD. Every response shape here is what the sidebar consumes;
/// the frontend never talks to the database directly.
/// </summary>
public static class ChatEndpoints
{
    public static IEndpointRouteBuilder MapAstraChatEndpoints(this IEndpointRouteBuilder app)
    {
        // GET /api/chats — sidebar list, sorted (pinned first, most recent first).
        app.MapGet("/api/chats", async (IChatStore store, CancellationToken ct) =>
            Results.Json(await store.ListAsync(ct)));

        // GET /api/chats/{id} — one conversation with its messages.
        app.MapGet("/api/chats/{id}", async (string id, IChatStore store, CancellationToken ct) =>
        {
            if (!ChatInput.IsValidId(id)) return Results.NotFound();
            var conversation = await store.GetAsync(id, ct);
            return conversation is null ? Results.NotFound() : Results.Json(conversation);
        });

        // POST /api/chats — explicit "New Chat".
        app.MapPost("/api/chats", async (CreateConversationRequest? body, IChatStore store, CancellationToken ct) =>
        {
            var title = ChatInput.SanitizeTitle(body?.Title) ?? ChatInput.DefaultTitle;
            var conversation = await store.CreateAsync(null, title, ct);
            return Results.Json(conversation, statusCode: StatusCodes.Status201Created);
        });

        // PUT /api/chats/{id} — rename / pin / archive.
        app.MapPut("/api/chats/{id}", async (
            string id,
            UpdateConversationRequest? body,
            IChatStore store,
            CancellationToken ct) =>
        {
            if (!ChatInput.IsValidId(id)) return Results.NotFound();
            if (body is null) return Results.BadRequest(new { error = "Update body required." });
            if (body.Title is not null && ChatInput.SanitizeTitle(body.Title) is null)
            {
                return Results.BadRequest(new { error = "Title must contain letters or digits." });
            }

            // A title sent to PUT is a deliberate human rename: mark it manual
            // unless the caller says otherwise, so auto-naming can never
            // overwrite it later.
            var patch = new UpdateConversationRequest(
                body.Title,
                body.Pinned,
                body.Archived,
                body.TitleManual ?? (body.Title is not null ? true : null));

            var summary = await store.UpdateAsync(id, patch, ct);
            return summary is null ? Results.NotFound() : Results.Json(summary);
        });

        // DELETE /api/chats/{id} — removes exactly one conversation.
        app.MapDelete("/api/chats/{id}", async (string id, IChatStore store, CancellationToken ct) =>
        {
            if (!ChatInput.IsValidId(id)) return Results.NotFound();
            return await store.DeleteAsync(id, ct)
                ? Results.Json(new { deleted = true, id })
                : Results.NotFound();
        });

        // POST /api/chats/{id}/clear — clear messages, keep the conversation.
        app.MapPost("/api/chats/{id}/clear", async (string id, IChatStore store, CancellationToken ct) =>
        {
            if (!ChatInput.IsValidId(id)) return Results.NotFound();
            return await store.ClearMessagesAsync(id, ct)
                ? Results.Json(new { cleared = true, id, messageCount = 0 })
                : Results.NotFound();
        });

        return app;
    }
}
