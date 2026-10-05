namespace Astra.Backend.Services;

using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Astra.Backend.Models;

/// <summary>
/// Streams replies from any OpenAI-compatible chat-completions endpoint
/// (OpenAI, OpenRouter, Together, local Ollama, etc.).
/// </summary>
public sealed class OpenAiCompatibleEngine : IAstraEngine
{
    private readonly IConfiguration _config;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<OpenAiCompatibleEngine> _logger;
    private readonly string _systemPrompt;

    public OpenAiCompatibleEngine(
        IConfiguration config,
        IHttpClientFactory httpClientFactory,
        ILogger<OpenAiCompatibleEngine> logger,
        IWebHostEnvironment env)
    {
        _config = config;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        
        // Load system prompt from Astra:Persona config or fallback to AstraSystemPrompt.md
        var persona = _config["Astra:Persona"];
        if (!string.IsNullOrWhiteSpace(persona))
        {
            _systemPrompt = persona;
        }
        else
        {
            var promptPath = Path.Combine(env.ContentRootPath, "AstraSystemPrompt.md");
            _systemPrompt = File.Exists(promptPath) 
                ? File.ReadAllText(promptPath)
                : "You are ASTRA, an intelligent AI assistant with a calm, professional personality.";
        }
    }

    public string Provider => "opencode-local";
    public string Model => _config["Astra:OpenAI:Model"] ?? "mimo-v2.6-flash-free";
    public bool IsOnline => !string.IsNullOrWhiteSpace(ApiKey) || IsLocalEndpoint;
    public string Note => IsLocalEndpoint
        ? $"Local agent bridge at {BaseUrl.TrimEnd('/')} (OpenCode runtime, free models, full tool access)."
        : string.IsNullOrWhiteSpace(ApiKey) 
            ? "Configure Astra:OpenAI:ApiKey or Astra__OpenAI__ApiKey environment variable to enable live AI."
            : "Live AI model connected and ready.";

    private string? ApiKey => 
        _config["Astra:OpenAI:ApiKey"] ?? 
        Environment.GetEnvironmentVariable("ASTRA_OPENAI__APIKEY") ??
        Environment.GetEnvironmentVariable("Astra__OpenAI__ApiKey");
    private string BaseUrl => _config["Astra:OpenAI:BaseUrl"] ?? "https://api.openai.com/v1/";

    private bool IsLocalEndpoint =>
        BaseUrl.Contains("localhost", StringComparison.OrdinalIgnoreCase) ||
        BaseUrl.Contains("127.0.0.1", StringComparison.OrdinalIgnoreCase);

    public async IAsyncEnumerable<string> StreamReplyAsync(
        IReadOnlyList<ChatMessage> conversation,
        string? clientTag = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(ApiKey) && !IsLocalEndpoint)
        {
            yield return "I'm not connected to a live AI model yet. " +
                         "Set Astra:OpenAI:ApiKey in appsettings.json (or use the Astra__OpenAI__ApiKey environment variable) " +
                         "to enable intelligent responses.";
            yield break;
        }

        // Build messages array: system prompt first, then conversation (without duplicating system messages)
        var messagesList = new List<object>();
        
        // Add system prompt if not already present in conversation
        var hasSystemMessage = conversation.Any(m => m.Role == Roles.System);
        if (!hasSystemMessage)
        {
            messagesList.Add(new { role = "system", content = _systemPrompt });
        }
        
        // Add conversation history
        messagesList.AddRange(conversation.Select(m => new { role = m.Role, content = m.Content }));

        var payload = new
        {
            model = Model,
            stream = true,
            messages = messagesList,
            // The local bridge maps this onto a persistent agent session so memory lives
            // in the agent runtime instead of being resent on every turn.
            user = clientTag ?? "default"
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(new Uri(BaseUrl), "chat/completions"));
        request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        if (!string.IsNullOrWhiteSpace(ApiKey))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", ApiKey);
        }

        var httpClient = _httpClientFactory.CreateClient("astra-llm");

        HttpResponseMessage response;
        Exception? transportError = null;
        try
        {
            response = await httpClient.SendAsync(
                request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            yield break;
        }
        catch (Exception ex)
        {
            transportError = ex;
            response = null!;
        }

        if (transportError is not null)
        {
            _logger.LogError(transportError, "Agent bridge at {BaseUrl} is unreachable", BaseUrl);
            yield return "My local agent bridge is not running. Start it with `npm run proxy` " +
                         "(or ./start.sh) and try again, Aarav.";
            yield break;
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                var errorBody = await response.Content.ReadAsStringAsync(cancellationToken);
                _logger.LogWarning("Agent bridge returned {Status}: {Body}", (int)response.StatusCode, errorBody);
                yield return $"The local agent bridge rejected the request ({(int)response.StatusCode}). " +
                             "Check its console output for details, Aarav.";
                yield break;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var reader = new StreamReader(stream);

            string? line;
            while ((line = await reader.ReadLineAsync(cancellationToken)) is not null)
            {
                if (!line.StartsWith("data: ", StringComparison.Ordinal)) continue;

                var data = line["data: ".Length..].Trim();
                if (data == "[DONE]") yield break;

                string? delta = null;
                try
                {
                    using var doc = JsonDocument.Parse(data);
                    delta = doc.RootElement
                        .GetProperty("choices")[0]
                        .GetProperty("delta")
                        .TryGetProperty("content", out var contentEl) ? contentEl.GetString() : null;
                }
                catch (JsonException)
                {
                    // Ignore malformed keep-alive lines; continue the stream.
                }

                if (!string.IsNullOrEmpty(delta)) yield return delta;
            }
        }

        _logger.LogDebug("OpenAI-compatible stream completed for model {Model}", Model);
    }
}
