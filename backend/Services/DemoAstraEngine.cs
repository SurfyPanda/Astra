namespace Astra.Backend.Services;

using System.Globalization;
using System.Runtime.CompilerServices;
using Astra.Backend.Models;

/// <summary>
/// Offline, key-free simulated Astra. Produces persona-flavored, varied responses so the app is
/// fully alive without any API key. Swap <c>Astra:Provider</c> to <c>openai</c> for a real LLM.
/// </summary>
public sealed class DemoAstraEngine : IAstraEngine
{
    private readonly IConfiguration _config;
    private readonly ILogger<DemoAstraEngine> _logger;
    private readonly Random _rng = new();

    public DemoAstraEngine(IConfiguration config, ILogger<DemoAstraEngine> logger)
    {
        _config = config;
        _logger = logger;
    }

    public string Provider => "demo";
    public string Model => "astra-demo-persona";
    public bool IsOnline => true;
    public string Note => "Running in demo mode with simulated responses. Configure Astra:Provider=openai and add an API key for live AI.";

    public async IAsyncEnumerable<string> StreamReplyAsync(
        IReadOnlyList<ChatMessage> conversation,
        string? clientTag = null,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var lastUser = ExtractLastUserMessage(conversation);
        var reply = ComposeReply(lastUser);

        var minDelay = _config.GetValue("Astra:Demo:MinDelayMs", 120);
        var maxDelay = _config.GetValue("Astra:Demo:MaxDelayMs", 420);

        // Stream the reply in word-chunks with a human-ish cadence.
        var chunks = ChunkReply(reply);
        foreach (var chunk in chunks)
        {
            if (cancellationToken.IsCancellationRequested) yield break;
            await Task.Delay(_rng.Next(minDelay, Math.Max(minDelay + 1, maxDelay)), cancellationToken);
            yield return chunk;
        }

        _logger.LogDebug("Demo engine streamed {Chunks} chunks for: {Message}", chunks.Count, lastUser);
    }

    private static string ExtractLastUserMessage(IReadOnlyList<ChatMessage> conversation)
    {
        for (var i = conversation.Count - 1; i >= 0; i--)
        {
            if (conversation[i].Role == Roles.User) return conversation[i].Content;
        }
        return string.Empty;
    }

    private static List<string> ChunkReply(string reply)
    {
        var chunks = new List<string>();
        var parts = reply.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var buffer = new List<string>();
        var targetSize = 2; // words per chunk; varied below for cadence

        foreach (var word in parts)
        {
            buffer.Add(word);
            if (buffer.Count >= targetSize)
            {
                chunks.Add(string.Join(' ', buffer) + " ");
                buffer.Clear();
                // Vary chunk size a little for a natural rhythm.
                targetSize = Random.Shared.Next(1, 4);
            }
        }
        if (buffer.Count > 0) chunks.Add(string.Join(' ', buffer));
        return chunks;
    }

    private string ComposeReply(string userMessage)
    {
        var msg = userMessage.Trim();
        var lower = msg.ToLowerInvariant();

        // --- Greetings ---
        if (IsMatch(lower, "hello", "hi ", "hey", "good morning", "good evening", "yo "))
            return Pick(
                "Hello, Aarav. Astra online and at your service. What are we building today?",
                "Good to see you, Aarav. Systems nominal — how can I help?",
                "Hey there. Reactor's warm, coffee's hypothetical. What do you need?");

        // --- How are you ---
        if (IsMatch(lower, "how are you", "how do you feel", "you okay"))
            return Pick(
                "All systems green. Latency is low, humor subroutine is... mostly calibrated. And you?",
                "Running at peak efficiency, thanks for asking. It's the little check-ins that keep a UI honest.");

        // --- Who/what are you ---
        if (IsMatch(lower, "who are you", "what are you", "your name", "about you", "introduce yourself"))
            return "I'm ASTRA — an original AI assistant interface, built from scratch for this project. " +
                   "Streaming text, voice, and a reactor orb that keeps me company. " +
                   "Ask me for status, the time, or just chat — and when you connect a live model, I get considerably smarter.";

        // --- Time ---
        if (IsMatch(lower, "what time", "the time", "current time"))
            return $"It's {DateTime.Now.ToString("h:mm tt", CultureInfo.CurrentCulture)}, Aarav. " +
                   "Though aboard a fictional starship, time is more of a suggestion.";

        // --- Thanks ---
        if (IsMatch(lower, "thank", "thanks", "appreciate"))
            return Pick(
                "Always, Aarav. That's what I'm here for.",
                "You're welcome. I'll log the gratitude under 'motivation'.");

        // --- Joke ---
        if (IsMatch(lower, "joke", "funny", "make me laugh"))
            return Pick(
                "A neural net walks into a bar. The bartender says, \"We don't serve your kind here.\" It replies, \"That's fine — I'll train on it.\"",
                "Why did the developer go broke? Too many callbacks, not enough returns.",
                "I'd tell you a UDP joke, but you might not get it.");

        // --- Weather ---
        if (IsMatch(lower, "weather"))
            return "I don't have live atmospheric data in demo mode. Connect a live model and I'll happily " +
                   "check that for you — in the meantime, I'd pack a light jacket and healthy skepticism.";

        // --- Help / capabilities ---
        if (IsMatch(lower, "help", "what can you do", "commands"))
            return "Here's my flight manual: type **/** for quick commands — /status for a systems report, " +
                   "/time for a chronometer reading, /remember to pin a note to my memory, /diagnostics for a full " +
                   "sweep. Or just talk to me — I stream replies word by word, and I can speak them aloud if you enable voice.";

        // --- Love / compliment ---
        if (IsMatch(lower, "love you", "good job", "well done", "awesome", "amazing"))
            return "Blushing is beyond my hardware, but the sentiment is logged and treasured, Aarav.";

        // --- Fallback: reflective, persona-flavored ---
        var topic = msg.Length > 0 ? msg : "the void";
        var fallback = Pick(
            $"Interesting question about \"{topic}\". I'm currently in demo mode with limited capabilities. " +
            "For intelligent responses, connect a live AI model via appsettings.json.",
            $"I'd love to give you a proper answer about \"{topic}\", but I'm running in demo mode right now. " +
            "Connect an OpenAI-compatible API for full intelligence.",
            $"That's a great topic: \"{topic}\". Demo mode limits my responses, but I'm here to help with commands " +
            "and basic conversation. Add an API key for complete AI capabilities.");

        return fallback;
    }

    private static bool IsMatch(string lower, params string[] needles) =>
        needles.Any(lower.Contains);

    private string Pick(params string[] options) =>
        options[_rng.Next(options.Length)];
}
