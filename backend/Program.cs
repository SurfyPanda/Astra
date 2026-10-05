namespace Astra.Backend;

using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Astra.Backend.Models;
using Astra.Backend.Services;

public static class Program
{
    // Memory notes are per conversation key (in-memory only, by design).
    private static readonly ConcurrentDictionary<string, string> MemoryNotes = new();

    /// <summary>How much history is handed to the engine for one turn.</summary>
    private const int MaxHistoryMessages = 120;

    /// <summary>Flags a reply that came from a slash command / desktop agent action.</summary>
    private const string CommandMetadata = """{"command":true}""";

    public static async Task Main(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);

        // --- Engine selection (pluggable brain) ---
        builder.Services.AddSingleton<IAstraEngine>(sp =>
        {
            var cfg = sp.GetRequiredService<IConfiguration>();

            // Support both appsettings and environment variables (Astra__Provider or ASTRA_PROVIDER)
            var provider = cfg["Astra:Provider"]
                ?? Environment.GetEnvironmentVariable("Astra__Provider")
                ?? Environment.GetEnvironmentVariable("ASTRA_PROVIDER")
                ?? "openai"; // Default to openai instead of demo

            return provider.Equals("openai", StringComparison.OrdinalIgnoreCase)
                ? (IAstraEngine)ActivatorUtilities.CreateInstance<OpenAiCompatibleEngine>(sp)
                : (IAstraEngine)ActivatorUtilities.CreateInstance<DemoAstraEngine>(sp);
        });

        builder.Services.AddHttpClient("astra-llm", client =>
        {
            client.Timeout = TimeSpan.FromMinutes(3);
        });

        builder.Services.AddHttpClient("astra-agent");
        builder.Services.ConfigureHttpClientDefaults(b =>
            b.ConfigurePrimaryHttpMessageHandler(() => new System.Net.Http.HttpClientHandler
            {
                AutomaticDecompression = System.Net.DecompressionMethods.GZip
                    | System.Net.DecompressionMethods.Deflate
                    | System.Net.DecompressionMethods.Brotli,
            }));
        builder.Services.AddSingleton<OsControl>();
        builder.Services.AddSingleton<AgentRouter>();
        builder.Services.AddSingleton<SystemDiagnostics>();

        // Durable chat history (SQLite file, no external service).
        builder.Services.AddSingleton<IChatStore, SqliteChatStore>();

        builder.Services.AddCors(options =>
        {
            options.AddDefaultPolicy(policy => policy
                .WithOrigins("http://localhost:5173", "http://127.0.0.1:5173")
                .AllowAnyHeader()
                .AllowAnyMethod());
        });

        var app = builder.Build();

        app.UseCors();

        await app.Services.GetRequiredService<IChatStore>().InitializeAsync();

        var log = app.Logger;

        // --- Status endpoint ---
        app.MapGet("/api/status", (IAstraEngine engine) =>
        {
            var status = new EngineStatus(engine.Provider, engine.Model, engine.IsOnline, engine.Note);
            return Results.Json(status);
        });

        // --- Live hardware diagnostics ---
        app.MapGet("/api/diagnostics", async (SystemDiagnostics diag, CancellationToken ct) =>
        {
            var report = await diag.GetReportAsync(ct);
            return Results.Json(new
            {
                cpu = report.CpuPercent,
                memory = report.MemoryUsedPercent,
                memoryDetail = report.MemoryDetail,
                latencies = report.LatenciesMs,
            });
        });

        // --- Conversation CRUD (sidebar, rename, delete, clear) ---
        app.MapAstraChatEndpoints();

        // --- SSE chat endpoint ---
        app.MapPost("/api/chat", async (
            ChatRequest req,
            IAstraEngine engine,
            AgentRouter agent,
            SystemDiagnostics diag,
            IConfiguration cfg,
            IChatStore store,
            HttpContext http,
            CancellationToken ct) =>
        {
            var message = ChatInput.SanitizeMessage(req.Message);
            if (message is null)
            {
                return Results.BadRequest(new { error = "Message is empty or exceeds the size limit." });
            }

            // --- Resolve the conversation: the server decides, never the client cache ---
            string conversationId;
            if (!string.IsNullOrWhiteSpace(req.ConversationId))
            {
                if (!ChatInput.IsValidId(req.ConversationId))
                {
                    return Results.BadRequest(new { error = "Invalid conversation id." });
                }

                conversationId = req.ConversationId!;
                var existing = await store.GetSummaryAsync(conversationId, ct);
                if (existing is null)
                {
                    // Unknown id: seed a fresh conversation for it so the client's
                    // next view is consistent (ids are validated opaque tokens).
                    await store.CreateAsync(conversationId, ChatInput.DefaultTitle, ct);
                }
            }
            else
            {
                // Legacy client without a conversation: hand it a real one and
                // report the id back in the meta event.
                conversationId = (await store.CreateAsync(null, ChatInput.DefaultTitle, ct)).Id;
            }

            // Name the conversation from its first message — local rules, no LLM.
            // No-op once the chat has messages or a manual name.
            await store.ApplyTitleIfEmptyAsync(conversationId, req.ProposedTitle, ct);

            var trimmed = message.Trim();

            // --- Slash commands (agent quick actions) return plain JSON, not SSE ---
            string? commandResult;
            if (trimmed is "/diagnostics" or "/diag")
            {
                commandResult = diag.RenderVoice(await diag.GetReportAsync(ct));
            }
            else
            {
                commandResult = TryHandleCommand(message, conversationId, engine, cfg);
            }

            if (commandResult is not null)
            {
                if (trimmed.Equals("/clear", StringComparison.OrdinalIgnoreCase))
                {
                    // Clear messages, keep the conversation entity and its title.
                    await store.ClearMessagesAsync(conversationId, ct);
                    return Results.Json(new
                    {
                        mode = "command",
                        reply = commandResult,
                        cleared = true,
                        meta = await BuildMetaAsync(store, conversationId, ct),
                    });
                }

                await store.AddMessageAsync(conversationId, Roles.User, message, "complete", null, ct);
                await store.AddMessageAsync(
                    conversationId, Roles.Assistant, commandResult, "complete", CommandMetadata, ct);
                return Results.Json(new
                {
                    mode = "command",
                    reply = commandResult,
                    meta = await BuildMetaAsync(store, conversationId, ct),
                });
            }

            // --- Desktop agent intents: open apps/sites, play on YouTube, find on Amazon, type, press keys ---
            var agentResult = await agent.RouteAsync(message, http.RequestAborted);
            if (agentResult is not null)
            {
                await store.AddMessageAsync(conversationId, Roles.User, message, "complete", null, ct);
                await store.AddMessageAsync(
                    conversationId, Roles.Assistant, agentResult.Reply, "complete", CommandMetadata, ct);
                return Results.Json(new
                {
                    mode = "command",
                    action = true,
                    success = agentResult.Success,
                    reply = agentResult.Reply,
                    meta = await BuildMetaAsync(store, conversationId, ct),
                });
            }

            // --- Normal streamed reply (Server-Sent Events) ---
            // 1. persist the user message and seed the assistant placeholder
            await store.AddMessageAsync(conversationId, Roles.User, message, "complete", null, ct);
            var assistant = await store.AddMessageAsync(
                conversationId, Roles.Assistant, string.Empty, "streaming", null, ct);
            // 2. history comes from the store — keyed by this conversation only
            var history = await LoadHistoryAsync(store, conversationId, ct);

            return Results.Stream(async _ =>
            {
                var reply = new StringBuilder();
                var lastFlush = DateTime.UtcNow;
                var lastFlushLength = 0;
                var status = "complete";

                try
                {
                    await foreach (var token in engine.StreamReplyAsync(history, conversationId, http.RequestAborted))
                    {
                        reply.Append(token);
                        await WriteEventAsync(http.Response, new { token }, http.RequestAborted);

                        // Incremental persistence: a refresh mid-stream keeps progress.
                        var now = DateTime.UtcNow;
                        if (now - lastFlush >= TimeSpan.FromMilliseconds(400) || reply.Length - lastFlushLength >= 1500)
                        {
                            lastFlush = now;
                            lastFlushLength = reply.Length;
                            await store.UpdateMessageAsync(assistant.Id, reply.ToString(), "streaming", CancellationToken.None);
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                    status = "interrupted";
                }
                catch (Exception ex)
                {
                    status = "error";
                    log.LogError(ex, "Stream failed for conversation {ConversationId}", conversationId);
                }

                // Persist whatever we have — even after the client vanished.
                await store.UpdateMessageAsync(assistant.Id, reply.ToString(), status, CancellationToken.None);

                // 7/8. publish the refreshed conversation metadata, then finish.
                try
                {
                    var meta = await BuildMetaAsync(store, conversationId, CancellationToken.None);
                    await WriteEventAsync(http.Response, new { @event = "meta", meta }, http.RequestAborted);
                    await http.Response.WriteAsync("data: [DONE]\n\n", http.RequestAborted);
                    await http.Response.Body.FlushAsync(http.RequestAborted);
                }
                catch
                {
                    // Client is gone; the message is already safely stored.
                }
            }, contentType: "text/event-stream");
        });

        await app.RunAsync();
    }

    // ------------------------------------------------------------------
    // Chat helpers
    // ------------------------------------------------------------------

    /// <summary>Metadata both response shapes (JSON + SSE) hand back to the UI.</summary>
    private static async Task<object> BuildMetaAsync(
        IChatStore store,
        string conversationId,
        CancellationToken ct)
    {
        var summary = await store.GetSummaryAsync(conversationId, ct);
        return new
        {
            conversationId,
            title = summary?.Title ?? ChatInput.DefaultTitle,
            updatedAt = (DateTimeOffset?)summary?.UpdatedAt,
            messageCount = summary?.MessageCount ?? 0,
        };
    }

    /// <summary>Loads this conversation's history for the engine (and only this conversation's).</summary>
    private static async Task<List<ChatMessage>> LoadHistoryAsync(
        IChatStore store,
        string conversationId,
        CancellationToken ct)
    {
        var detail = await store.GetAsync(conversationId, ct);
        if (detail is null) return new List<ChatMessage>();

        return detail.Messages
            .Where(m => m.Role is Roles.User or Roles.Assistant)
            .Where(m => !string.IsNullOrWhiteSpace(m.Content))
            .Select(m => new ChatMessage(m.Role, m.Content))
            .TakeLast(MaxHistoryMessages)
            .ToList();
    }

    private static Task WriteEventAsync(HttpResponse response, object payload, CancellationToken ct) =>
        response.WriteAsync($"data: {JsonSerializer.Serialize(payload)}\n\n", ct);

    // ------------------------------------------------------------------
    // Slash commands
    // ------------------------------------------------------------------

    private static readonly HttpClient AgentBridge = new() { Timeout = TimeSpan.FromSeconds(5) };

    private static string? TryHandleCommand(string rawInput, string sessionId, IAstraEngine engine, IConfiguration cfg)
    {
        var input = rawInput.Trim();
        if (!input.StartsWith('/')) return null;

        var parts = input.Split(' ', 2, StringSplitOptions.TrimEntries);
        var cmd = parts[0].ToLowerInvariant();
        var arg = parts.Length > 1 ? parts[1] : string.Empty;

        return cmd switch
        {
            "/help" =>
                "Available commands: /status — systems report · /time — chronometer · " +
                "/remember <fact> — store a memory note · /recall — list memory notes · " +
                "/diagnostics — full sweep · /erase — purge memory notes · /clear — wipe this chat. " +
                "I also act as a desktop agent — just ask in plain language: open youtube · open spotify · " +
                "play lofi beats on youtube · find mechanical keyboard on amazon · search google for weather tomorrow · " +
                "type hello world then press enter · press cmd+t. Everything else is normal conversation.",

            "/status" =>
                $"ASTRA systems nominal. Memory: {CountSessionNotes(sessionId)} note(s) stored. " +
                $"Engine: {engine.Provider} ({engine.Model}){(engine.IsOnline ? "" : " - offline")}. " +
                $"{engine.Note}",

            "/time" =>
                $"Chronometer reads {DateTime.Now:f} — logged and annotated with unearned confidence.",

            "/remember" => HandleRemember(sessionId, arg),
            "/recall" => HandleRecall(sessionId),

            "/diagnostics" =>
                "Diagnostics: Neural lattice nominal · Voice system ready · Streaming channels open · " +
                $"Engine: {engine.Provider} · All systems operational.",

            "/clear" =>
                ClearSession(sessionId, cfg),

            "/erase" => EraseMemory(sessionId),

            _ => $"Unrecognized command '{cmd}'. Type /help for the flight manual, Aarav."
        };
    }

    private static int CountSessionNotes(string sessionId) =>
        MemoryNotes.Keys.Count(k => k.StartsWith(sessionId + ':', StringComparison.Ordinal));

    private static string ClearSession(string sessionId, IConfiguration cfg)
    {
        // Message history itself is cleared by the endpoint against the store —
        // this only drops the bridge-side agent memory for this conversation.
        ResetAgentMemory(sessionId, cfg);
        return "Chat cleared. Fresh start, Aarav.";
    }

    /// <summary>Tells the local agent bridge to drop the matching agent session (best effort).</summary>
    private static void ResetAgentMemory(string sessionId, IConfiguration cfg)
    {
        try
        {
            var baseUrl = cfg["Astra:OpenAI:BaseUrl"] ?? "http://127.0.0.1:4321/v1/";
            var url = new Uri(new Uri(baseUrl), "session/reset");
            _ = AgentBridge.PostAsJsonAsync(url, new { sessionId }, CancellationToken.None)
                .ContinueWith(task => { _ = task.Exception; }, TaskScheduler.Default);
        }
        catch
        {
            // The bridge is optional: a failed reset only means the old context is kept.
        }
    }

    private static string HandleRemember(string sessionId, string fact)
    {
        if (string.IsNullOrWhiteSpace(fact))
        {
            return "Usage: /remember <fact> — for example: /remember The reactor coolant is fictional.";
        }

        var key = $"{sessionId}:{Guid.NewGuid():N}";
        MemoryNotes[key] = fact.Trim();
        return $"Committed to memory: \"{fact.Trim()}\". {CountSessionNotes(sessionId)} note(s) on file.";
    }

    private static string HandleRecall(string sessionId)
    {
        var notes = MemoryNotes
            .Where(kvp => kvp.Key.StartsWith(sessionId + ':', StringComparison.Ordinal))
            .Select(kvp => kvp.Value)
            .ToList();

        if (notes.Count == 0)
            return "Memory banks empty for this chat. Feed me something with /remember <fact>.";

        return "Memory banks, current chat:\n" +
               string.Join("\n", notes.Select((n, i) => $"  {i + 1}. {n}"));
    }

    private static string EraseMemory(string sessionId)
    {
        var removed = 0;
        foreach (var key in MemoryNotes.Keys.Where(k => k.StartsWith(sessionId + ':', StringComparison.Ordinal)).ToList())
        {
            if (MemoryNotes.TryRemove(key, out _)) removed++;
        }
        return removed > 0
            ? $"Purged {removed} memory note(s). What happens in this chat, stays deleted."
            : "No memory notes to purge, Aarav.";
    }
}
