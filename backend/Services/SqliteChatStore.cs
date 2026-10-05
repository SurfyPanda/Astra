namespace Astra.Backend.Services;

using Astra.Backend.Models;
using Microsoft.Data.Sqlite;

/// <summary>
/// Durable conversation storage.
///
/// The source of truth for chat history is this SQLite file on disk — not
/// React state, not an in-memory session, not an external service. Everything
/// the UI shows is read back from here, so a refresh, a browser restart or a
/// backend restart can never lose a conversation.
/// </summary>
public interface IChatStore
{
    Task InitializeAsync(CancellationToken ct = default);

    /// <summary>All conversations (pinned first, most recently used first).</summary>
    Task<IReadOnlyList<ConversationSummary>> ListAsync(CancellationToken ct = default);

    /// <summary>Conversation metadata, or null when the id is unknown.</summary>
    Task<ConversationSummary?> GetSummaryAsync(string id, CancellationToken ct = default);

    /// <summary>Conversation metadata plus every message, or null when unknown.</summary>
    Task<ConversationDetail?> GetAsync(string id, CancellationToken ct = default);

    /// <summary>Creates a conversation. When <paramref name="id"/> is null a server id is used.</summary>
    Task<ConversationDetail> CreateAsync(string? id, string title, CancellationToken ct = default);

    /// <summary>Applies a partial update; returns the fresh summary or null when unknown.</summary>
    Task<ConversationSummary?> UpdateAsync(string id, UpdateConversationRequest patch, CancellationToken ct = default);

    Task<bool> DeleteAsync(string id, CancellationToken ct = default);

    /// <summary>Drops messages but keeps the conversation entity and its title.</summary>
    Task<bool> ClearMessagesAsync(string id, CancellationToken ct = default);

    Task<int> CountMessagesAsync(string id, CancellationToken ct = default);

    /// <summary>
    /// Applies a client-proposed automatic title only while the conversation is
    /// still empty and has no manual title. Returns the effective title.
    /// </summary>
    Task<string> ApplyTitleIfEmptyAsync(string id, string? proposedTitle, CancellationToken ct = default);

    Task<StoredMessage> AddMessageAsync(
        string conversationId,
        string role,
        string content,
        string? status = null,
        string? metadata = null,
        CancellationToken ct = default);

    /// <summary>Partial update of a streamed message (content and/or status).</summary>
    Task<bool> UpdateMessageAsync(
        string messageId,
        string? content,
        string? status,
        CancellationToken ct = default);
}

public sealed class SqliteChatStore : IChatStore
{
    private readonly string _connectionString;
    private readonly string _dbPath;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ILogger<SqliteChatStore> _logger;

    public SqliteChatStore(IWebHostEnvironment env, IConfiguration config, ILogger<SqliteChatStore> logger)
    {
        _logger = logger;
        var configured = config["Astra:Chat:DbPath"]
            ?? Environment.GetEnvironmentVariable("ASTRA_CHAT_DB");
        var path = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(env.ContentRootPath, "data", "astra-chat.db")
            : Path.GetFullPath(configured);

        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadWriteCreate,
        }.ToString();
        _dbPath = path;
    }

    // ------------------------------------------------------------------
    // Connection helpers
    // ------------------------------------------------------------------

    private async Task<SqliteConnection> OpenAsync(CancellationToken ct)
    {
        var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(ct);
        // Per-connection pragmas: enforced on every open so pooled or fresh
        // connections behave identically.
        await using (var cmd = connection.CreateCommand())
        {
            cmd.CommandText = "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;";
            await cmd.ExecuteNonQueryAsync(ct);
        }
        return connection;
    }

    public async Task InitializeAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var connection = await OpenAsync(ct);
            await using var cmd = connection.CreateCommand();
            cmd.CommandText =
                """
                PRAGMA journal_mode=WAL;

                CREATE TABLE IF NOT EXISTS conversations (
                    id           TEXT PRIMARY KEY,
                    title        TEXT NOT NULL,
                    title_manual INTEGER NOT NULL DEFAULT 0,
                    created_at   TEXT NOT NULL,
                    updated_at   TEXT NOT NULL,
                    pinned       INTEGER NOT NULL DEFAULT 0,
                    archived     INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id              TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role            TEXT NOT NULL,
                    content         TEXT NOT NULL,
                    created_at      TEXT NOT NULL,
                    status          TEXT,
                    metadata        TEXT,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_messages_conversation
                    ON messages(conversation_id, created_at);
                """;
            await cmd.ExecuteNonQueryAsync(ct);
            _logger.LogInformation("Conversation store ready at {Path}", _dbPath);
        }
        finally
        {
            _gate.Release();
        }
    }

    // ------------------------------------------------------------------
    // Conversations
    // ------------------------------------------------------------------

    public async Task<IReadOnlyList<ConversationSummary>> ListAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var connection = await OpenAsync(ct);
            await using var cmd = connection.CreateCommand();
            cmd.CommandText =
                """
                SELECT c.id, c.title, c.created_at, c.updated_at, c.pinned, c.archived, c.title_manual,
                       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
                FROM conversations c
                ORDER BY c.pinned DESC, c.updated_at DESC, c.rowid DESC;
                """;

            var result = new List<ConversationSummary>();
            await using var reader = await cmd.ExecuteReaderAsync(ct);
            while (await reader.ReadAsync(ct)) result.Add(ReadSummary(reader));
            return result;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<ConversationSummary?> GetSummaryAsync(string id, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var connection = await OpenAsync(ct);
            await using var cmd = connection.CreateCommand();
            cmd.CommandText =
                """
                SELECT c.id, c.title, c.created_at, c.updated_at, c.pinned, c.archived, c.title_manual,
                       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
                FROM conversations c WHERE c.id = $id;
                """;
            cmd.Parameters.AddWithValue("$id", id);

            await using var reader = await cmd.ExecuteReaderAsync(ct);
            return await reader.ReadAsync(ct) ? ReadSummary(reader) : null;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<ConversationDetail?> GetAsync(string id, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var connection = await OpenAsync(ct);

            SummaryRow? summary;
            await using (var cmd = connection.CreateCommand())
            {
                cmd.CommandText =
                    """
                    SELECT id, title, created_at, updated_at, pinned, archived, title_manual
                    FROM conversations WHERE id = $id;
                    """;
                cmd.Parameters.AddWithValue("$id", id);
                await using var reader = await cmd.ExecuteReaderAsync(ct);
                summary = await reader.ReadAsync(ct) ? ReadSummaryRow(reader) : null;
            }

            if (summary is null) return null;

            var messages = new List<StoredMessage>();
            await using (var cmd = connection.CreateCommand())
            {
                cmd.CommandText =
                    """
                    SELECT id, conversation_id, role, content, created_at, status, metadata
                    FROM messages WHERE conversation_id = $id
                    ORDER BY created_at ASC, rowid ASC;
                    """;
                cmd.Parameters.AddWithValue("$id", id);
                await using var reader = await cmd.ExecuteReaderAsync(ct);
                while (await reader.ReadAsync(ct)) messages.Add(ReadMessage(reader));
            }

            return new ConversationDetail(
                summary.Id, summary.Title, summary.CreatedAt, summary.UpdatedAt,
                summary.Pinned, summary.Archived, summary.TitleManual, messages);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<ConversationDetail> CreateAsync(string? id, string title, CancellationToken ct = default)
    {
        var conversationId = ChatInput.IsValidId(id) ? id! : ChatInput.NewId();
        var now = DateTimeOffset.UtcNow;

        await _gate.WaitAsync(ct);
        try
        {
            await using var connection = await OpenAsync(ct);
            await using var cmd = connection.CreateCommand();
            cmd.CommandText =
                """
                INSERT INTO conversations (id, title, title_manual, created_at, updated_at, pinned, archived)
                VALUES ($id, $title, 0, $now, $now, 0, 0)
                ON CONFLICT(id) DO NOTHING;
                """;
            cmd.Parameters.AddWithValue("$id", conversationId);
            cmd.Parameters.AddWithValue("$title", title);
            cmd.Parameters.AddWithValue("$now", now.ToString("O"));
            await cmd.ExecuteNonQueryAsync(ct);
        }
        finally
        {
            _gate.Release();
        }

        // Read back so the caller always gets the real stored row.
        var detail = await GetAsync(conversationId, ct);
        return detail ?? new ConversationDetail(
            conversationId, title, now, now, false, false, false,
            Array.Empty<StoredMessage>());
    }

    public async Task<ConversationSummary?> UpdateAsync(
        string id,
        UpdateConversationRequest patch,
        CancellationToken ct = default)
    {
        var title = patch.Title is null ? null : ChatInput.SanitizeTitle(patch.Title);
        if (patch.Title is not null && title is null) return null;

        await _gate.WaitAsync(ct);
        try
        {
            await using var connection = await OpenAsync(ct);
            await using var cmd = connection.CreateCommand();
            cmd.CommandText =
                """
                UPDATE conversations SET
                    title       = COALESCE($title, title),
                    title_manual = CASE WHEN $manual IS NULL THEN title_manual ELSE $manual END,
                    pinned      = COALESCE($pinned, pinned),
                    archived    = COALESCE($archived, archived),
                    updated_at  = $now
                WHERE id = $id;
                """;
            cmd.Parameters.AddWithValue("$title", (object?)title ?? DBNull.Value);
            cmd.Parameters.AddWithValue(
                "$manual",
                patch.TitleManual is null ? DBNull.Value : (object)(patch.TitleManual.Value ? 1 : 0));
            cmd.Parameters.AddWithValue(
                "$pinned", patch.Pinned is null ? DBNull.Value : (object)(patch.Pinned.Value ? 1 : 0));
            cmd.Parameters.AddWithValue(
                "$archived", patch.Archived is null ? DBNull.Value : (object)(patch.Archived.Value ? 1 : 0));
            cmd.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
            cmd.Parameters.AddWithValue("$id", id);

            var affected = await cmd.ExecuteNonQueryAsync(ct);
            if (affected == 0) return null;
        }
        finally
        {
            _gate.Release();
        }

        return await GetSummaryAsync(id, ct);
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var connection = await OpenAsync(ct);
            await using var cmd = connection.CreateCommand();
            cmd.CommandText = "DELETE FROM conversations WHERE id = $id;";
            cmd.Parameters.AddWithValue("$id", id);
            return await cmd.ExecuteNonQueryAsync(ct) > 0;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> ClearMessagesAsync(string id, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var connection = await OpenAsync(ct);
            await using var cmd = connection.CreateCommand();
            cmd.CommandText =
                """
                DELETE FROM messages WHERE conversation_id = $id;
                UPDATE conversations SET updated_at = $now WHERE id = $id;
                """;
            cmd.Parameters.AddWithValue("$id", id);
            cmd.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToString("O"));
            await cmd.ExecuteNonQueryAsync(ct);

            // Distinguish "no such conversation" from "cleared an empty one".
            await using var check = connection.CreateCommand();
            check.CommandText = "SELECT COUNT(*) FROM conversations WHERE id = $id;";
            check.Parameters.AddWithValue("$id", id);
            var count = (long)(await check.ExecuteScalarAsync(ct) ?? 0L);
            return count > 0;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<int> CountMessagesAsync(string id, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var connection = await OpenAsync(ct);
            await using var cmd = connection.CreateCommand();
            cmd.CommandText = "SELECT COUNT(*) FROM messages WHERE conversation_id = $id;";
            cmd.Parameters.AddWithValue("$id", id);
            return (int)(long)(await cmd.ExecuteScalarAsync(ct) ?? 0L);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<string> ApplyTitleIfEmptyAsync(
        string id,
        string? proposedTitle,
        CancellationToken ct = default)
    {
        var proposed = ChatInput.SanitizeTitle(proposedTitle);
        await _gate.WaitAsync(ct);
        try
        {
            await using var connection = await OpenAsync(ct);

            string currentTitle;
            int manual;
            await using (var read = connection.CreateCommand())
            {
                read.CommandText =
                    "SELECT title, title_manual FROM conversations WHERE id = $id;";
                read.Parameters.AddWithValue("$id", id);
                await using var reader = await read.ExecuteReaderAsync(ct);
                if (!await reader.ReadAsync(ct)) return proposed ?? ChatInput.DefaultTitle;
                currentTitle = reader.GetString(0);
                manual = reader.GetInt32(1);
            }

            // Manual names and already-started conversations are never retitled.
            if (manual != 0 || proposed is null) return currentTitle;

            var hasMessages = await CountMessagesUnlockedAsync(connection, id, ct);
            if (hasMessages > 0) return currentTitle;

            await using var write = connection.CreateCommand();
            write.CommandText = "UPDATE conversations SET title = $title WHERE id = $id;";
            write.Parameters.AddWithValue("$title", proposed);
            write.Parameters.AddWithValue("$id", id);
            await write.ExecuteNonQueryAsync(ct);
            return proposed;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<StoredMessage> AddMessageAsync(
        string conversationId,
        string role,
        string content,
        string? status = null,
        string? metadata = null,
        CancellationToken ct = default)
    {
        var message = new StoredMessage(
            ChatInput.NewId(),
            conversationId,
            role,
            content,
            DateTimeOffset.UtcNow,
            status,
            metadata);

        await _gate.WaitAsync(ct);
        try
        {
            await using var connection = await OpenAsync(ct);
            await using var cmd = connection.CreateCommand();
            cmd.CommandText =
                """
                INSERT INTO messages (id, conversation_id, role, content, created_at, status, metadata)
                VALUES ($id, $cid, $role, $content, $created, $status, $metadata);

                UPDATE conversations SET updated_at = $created WHERE id = $cid;
                """;
            cmd.Parameters.AddWithValue("$id", message.Id);
            cmd.Parameters.AddWithValue("$cid", conversationId);
            cmd.Parameters.AddWithValue("$role", role);
            cmd.Parameters.AddWithValue("$content", content);
            cmd.Parameters.AddWithValue("$created", message.CreatedAt.ToString("O"));
            cmd.Parameters.AddWithValue("$status", (object?)status ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$metadata", (object?)metadata ?? DBNull.Value);
            await cmd.ExecuteNonQueryAsync(ct);
        }
        finally
        {
            _gate.Release();
        }

        return message;
    }

    public async Task<bool> UpdateMessageAsync(
        string messageId,
        string? content,
        string? status,
        CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await using var connection = await OpenAsync(ct);
            await using var cmd = connection.CreateCommand();
            cmd.CommandText =
                """
                UPDATE messages SET
                    content = COALESCE($content, content),
                    status  = COALESCE($status, status)
                WHERE id = $id;
                """;
            cmd.Parameters.AddWithValue("$content", (object?)content ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$status", (object?)status ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$id", messageId);
            return await cmd.ExecuteNonQueryAsync(ct) > 0;
        }
        finally
        {
            _gate.Release();
        }
    }

    // ------------------------------------------------------------------
    // Readers
    // ------------------------------------------------------------------

    private static async Task<int> CountMessagesUnlockedAsync(
        SqliteConnection connection,
        string conversationId,
        CancellationToken ct)
    {
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM messages WHERE conversation_id = $id;";
        cmd.Parameters.AddWithValue("$id", conversationId);
        return (int)(long)(await cmd.ExecuteScalarAsync(ct) ?? 0L);
    }

    private sealed record SummaryRow(
        string Id,
        string Title,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt,
        bool Pinned,
        bool Archived,
        bool TitleManual,
        int MessageCount);

    private static SummaryRow ReadSummaryRow(SqliteDataReader reader) => new(
        reader.GetString(0),
        reader.GetString(1),
        DateTimeOffset.Parse(reader.GetString(2)),
        DateTimeOffset.Parse(reader.GetString(3)),
        reader.GetInt64(4) != 0,
        reader.GetInt64(5) != 0,
        reader.GetInt64(6) != 0,
        0);

    private static ConversationSummary ReadSummary(SqliteDataReader reader)
    {
        var row = ReadSummaryRow(reader);
        var messageCount = reader.FieldCount > 7 ? (int)reader.GetInt64(7) : 0;
        return new ConversationSummary(
            row.Id, row.Title, row.CreatedAt, row.UpdatedAt,
            row.Pinned, row.Archived, row.TitleManual, messageCount);
    }

    private static StoredMessage ReadMessage(SqliteDataReader reader) => new(
        reader.GetString(0),
        reader.GetString(1),
        reader.GetString(2),
        reader.GetString(3),
        DateTimeOffset.Parse(reader.GetString(4)),
        reader.IsDBNull(5) ? null : reader.GetString(5),
        reader.IsDBNull(6) ? null : reader.GetString(6));
}
