namespace Astra.Backend.Services;

using System.Net.Http;
using System.Text.RegularExpressions;

/// <summary>
/// Turns natural language into OS actions: open apps/sites, play things on YouTube,
/// find products on Amazon, search Google, type text, press keys.
/// Supports multi-intent decomposition ("open github and search google for rust").
/// Returns a structured AgentResult instead of throwing — the UI renders every outcome.
/// </summary>
public sealed partial class AgentRouter
{
    private readonly OsControl _os;
    private readonly IHttpClientFactory _httpFactory;
    private readonly ILogger<AgentRouter> _logger;

    public AgentRouter(OsControl os, IHttpClientFactory httpFactory, ILogger<AgentRouter> logger)
    {
        _os = os;
        _httpFactory = httpFactory;
        _logger = logger;
    }

    public record AgentResult(bool Handled, string Reply, bool Success = true);

    /// <summary>Entry point. Returns null when the utterance is not an agent command.</summary>
    public async Task<AgentResult?> RouteAsync(string input, CancellationToken ct)
    {
        var text = input.Trim();

        // --- Multi-intent decomposition: "open gmail and type hi then press enter" ---
        var segments = DecomposeIntents(text);
        if (segments.Count > 1)
        {
            var log = new System.Text.StringBuilder();
            var allOk = true;
            var step = 0;
            foreach (var seg in segments)
            {
                var r = await RouteSingleAsync(seg, ct);
                if (r is null) continue;
                step++;
                log.AppendLine($"Step {step}: {r.Reply}");
                allOk &= r.Success;
            }
            return log.Length == 0 ? null : new AgentResult(true, log.ToString().Trim(), allOk);
        }

        return await RouteSingleAsync(text, ct);
    }

    /// <summary>
    /// Splits a compound command into atomic steps on "and then / then / and / also".
    /// A "type ..." payload is never split — its text may legitimately contain "and".
    /// </summary>
    private static List<string> DecomposeIntents(string text)
    {
        var parts = SegmentSplitRegex().Split(text)
            .Select(p => p.Trim())
            .Where(p => p.Length > 0)
            .ToList();

        var typeIdx = parts.FindIndex(p => p.StartsWith("type ", StringComparison.OrdinalIgnoreCase));
        if (typeIdx >= 0 && typeIdx < parts.Count - 1)
        {
            var merged = string.Join(" and ", parts.Skip(typeIdx));
            parts = parts.Take(typeIdx).ToList();
            parts.Add(merged);
        }
        return parts;
    }

    private async Task<AgentResult?> RouteSingleAsync(string text, CancellationToken ct)
    {
        var lower = text.ToLowerInvariant();

        // ---------- type ----------
        var typeMatch = TypeRegex().Match(lower);
        if (typeMatch.Success)
        {
            // Preserve the user's original casing for the typed text.
            var idx = text.IndexOf(typeMatch.Groups[1].Value, StringComparison.OrdinalIgnoreCase);
            var payload = idx >= 0 ? text[idx..] : typeMatch.Groups[1].Value;

            var delaySecs = ExtractDelaySeconds(payload, out var afterDelay);
            payload = afterDelay;
            payload = Regex.Replace(payload, @"^type\s+", "", RegexOptions.IgnoreCase);
            payload = Regex.Replace(payload, @"\s*(,\s*)?then\s+press\s+enter\.?\s*$", "", RegexOptions.IgnoreCase);
            payload = payload.Trim('"', '\'', ' ');

            var pressEnterAfter = Regex.IsMatch(text, @"then\s+press\s+enter\s*$", RegexOptions.IgnoreCase);

            if (delaySecs > 0)
            {
                await Task.Delay(TimeSpan.FromSeconds(Math.Min(delaySecs, 300)), ct);
            }

            if (!_os.TryTypeText(payload, out var typeError))
            {
                return new AgentResult(true, typeError ?? "Typing failed.", false);
            }
            if (pressEnterAfter && !_os.TryPressKey("enter", out var keyError))
            {
                return new AgentResult(true, $"Typed the text, but Enter failed: {keyError}", false);
            }
            return new AgentResult(true,
                $"Typed {payload.Length} character(s) into the frontmost window" +
                (delaySecs > 0 ? $" after a {delaySecs}s delay" : "") +
                (pressEnterAfter ? ", then pressed Enter" : "") +
                ". Done, Aarav.");
        }

        // ---------- press key ----------
        var pressMatch = PressRegex().Match(lower);
        if (pressMatch.Success)
        {
            var key = Regex.Replace(pressMatch.Groups[1].Value, @"\s+", "").Trim()
                .Trim('"', '\'', '.', ',', '!', '?');
            var delaySecs = ExtractDelaySeconds(text, out _);
            if (delaySecs > 0)
            {
                await Task.Delay(TimeSpan.FromSeconds(Math.Min(delaySecs, 300)), ct);
            }
            if (!_os.TryPressKey(key, out var error))
            {
                return new AgentResult(true, error ?? "Key press failed.", false);
            }
            return new AgentResult(true, $"Pressed {key}. Done, Aarav.");
        }

        // ---------- amazon (before generic find/play) ----------
        if (lower.Contains("amazon"))
        {
            var m = Regex.Match(text, @"(?:find|look ?up|search(ing)? for|show me|buy)\s+(.+?)\s+on\s+amazon", RegexOptions.IgnoreCase);
            if (m.Success)
            {
                return await HandleAmazonAsync(m.Groups[2].Value.Trim(), ct);
            }
            if (Regex.IsMatch(lower, @"\b(?:open|go to|visit)\s+amazon\b"))
            {
                _os.OpenUrlOrFile("https://www.amazon.com");
                return new AgentResult(true, "Opening Amazon — happy hunting, Aarav.");
            }
        }

        // ---------- google search ----------
        // VERY STRICT: Must be an EXPLICIT web search command, not a normal question
        // 
        // TRIGGERS:
        //   "search google for X"
        //   "search the web for X" 
        //   "look up X online"
        //
        // DOES NOT TRIGGER:
        //   "what is X"
        //   "search what is X" (ambiguous - treated as question)
        //   "how does search work"
        
        // Pattern: requires explicit web context (google/web/online) OR clear imperative
        var googleMatch = Regex.Match(lower, 
            @"^(?:(?:please|can you|could you)\s+)?(?:search|look\s*up|google|find)(?:\s+(?:google|the\s+web|online|on\s+google))?\s+(?:for\s+)?(.+?)(?:\s+(?:on|using)\s+(?:google|the\s+web|online))?[.?]?\s*$",
            RegexOptions.IgnoreCase);
            
        if (googleMatch.Success)
        {
            var query = googleMatch.Groups[1].Value.Trim();
            
            // Reject if query starts with question words - this is a question, not a search command
            var questionWords = new[] { "what", "how", "why", "when", "where", "who", "which", 
                                       "is ", "are ", "does ", "do ", "can ", "will ", "should " };
            var queryLower = query.ToLowerInvariant();
            var looksLikeQuestion = questionWords.Any(qw => queryLower.StartsWith(qw));
            
            if (looksLikeQuestion)
            {
                // "search what is pi" -> normal chat
                return null;
            }
            
            // Must have explicit web indicator OR be clearly imperative (starts with "look up"/"search for")
            var hasExplicitWebContext = 
                lower.Contains("google") || 
                lower.Contains("the web") || 
                lower.Contains("online") ||
                lower.StartsWith("look up") ||
                lower.StartsWith("search for") ||
                lower.StartsWith("search the ") ||
                lower.StartsWith("google ");
            
            if (hasExplicitWebContext && query.Length > 0)
            {
                return await HandleGoogleAsync(query, ct);
            }
        }
        // ---------- play / find on youtube ----------
        var yt = PlayOnRegex().Match(lower);
        if (yt.Success)
        {
            var query = (yt.Groups[1].Success ? yt.Groups[1] : yt.Groups[2]).Value.Trim();
            return await HandleYouTubeAsync(query, ct);
        }

        // ---------- open app or website ----------
        var open = OpenRegex().Match(lower);
        if (open.Success)
        {
            // Voice capture preserves the user's punctuation, so strip sentence
            // terminators before matching an alias, an app name or a domain.
            var target = open.Groups[1].Value.Trim().Trim('"', '\'', '.', ',', '!', '?');
            return HandleOpen(target);
        }

        return null; // not an agent command
    }

    // ------------------------------------------------------------------
    // Handlers
    // ------------------------------------------------------------------

    private AgentResult HandleOpen(string target)
    {
        if (string.IsNullOrWhiteSpace(target))
        {
            return new AgentResult(true, "Open what, Aarav? Try \"open youtube\" or \"open calculator\".", false);
        }

        // Well-known sites people say like apps — treat them as URLs first.
        var aliases = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["youtube"] = "https://www.youtube.com",
            ["google"] = "https://www.google.com",
            ["gmail"] = "https://mail.google.com",
            ["maps"] = "https://maps.google.com",
            ["amazon"] = "https://www.amazon.com",
            ["netflix"] = "https://www.netflix.com",
            ["reddit"] = "https://www.reddit.com",
            ["wikipedia"] = "https://www.wikipedia.org",
            ["github"] = "https://github.com",
            ["twitter"] = "https://twitter.com",
            ["x"] = "https://x.com",
            ["instagram"] = "https://www.instagram.com",
            ["spotify"] = "https://open.spotify.com",
        };
        var key = target.Trim().ToLowerInvariant();
        if (aliases.TryGetValue(key, out var aliasUrl))
        {
            _os.OpenUrlOrFile(aliasUrl);
            return new AgentResult(true, $"Opening {key} — channel open, Aarav.");
        }

        // Looks like a URL / domain?
        if (target.Contains('.') && !target.Contains(' '))
        {
            var url = target.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? target : $"https://{target}";
            _os.OpenUrlOrFile(url);
            return new AgentResult(true, $"Opening {url} — channel open, Aarav.");
        }

        if (_os.TryOpenApp(target))
        {
            return new AgentResult(true, $"Launching {target} — it should be on screen in a moment, Aarav.");
        }
        return new AgentResult(true, $"I couldn't find an app called \"{target}\". Try its exact name, or say \"open {target}.com\".", false);
    }

    private async Task<AgentResult> HandleYouTubeAsync(string query, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            _os.OpenUrlOrFile("https://www.youtube.com");
            return new AgentResult(true, "Opening YouTube — what shall we watch, Aarav?");
        }

        // Direct fetch first; YouTube TLS-fingerprints datacenter clients, so fall back to DDG.
        var (videoId, title, channel) = await TryFetchTopVideoAsync(
            $"https://www.youtube.com/results?search_query={Uri.EscapeDataString(query)}", ct);

        if (videoId is null)
        {
            var results = await FetchDuckDuckGoResultsAsync($"site:youtube.com watch {query}", 6, ct);
            foreach (var r in results)
            {
                var m = WatchIdRegex.Match(r.Url);
                if (m.Success)
                {
                    videoId = m.Groups[1].Value;
                    title = r.Title;
                    break;
                }
            }
        }

        var summary = videoId is null
            ? $"Opening YouTube results for \"{query}\" — I couldn't identify the top video, but the search is live, Aarav."
            : $"Playing the top result for \"{query}\": {(title ?? "the first result")} — it's on screen, Aarav.";

        _os.OpenUrlOrFile(videoId is null
            ? $"https://www.youtube.com/results?search_query={Uri.EscapeDataString(query)}"
            : $"https://www.youtube.com/watch?v={videoId}");

        return new AgentResult(true, summary);
    }

    private async Task<AgentResult> HandleAmazonAsync(string query, CancellationToken ct)
    {
        var url = $"https://www.amazon.com/s?k={Uri.EscapeDataString(query)}";
        var (title, meta) = await TryFetchAmazonMetaAsync(url, ct);

        // Amazon shells bot clients too — DDG fallback for a real product line.
        if (title is null)
        {
            try
            {
                var results = await FetchDuckDuckGoResultsAsync($"site:amazon.com {query}", 1, ct);
                if (results.Count > 0)
                {
                    title = results[0].Title
                        .Replace(" - Amazon.com", "", StringComparison.OrdinalIgnoreCase)
                        .Replace(" : Amazon.com", "", StringComparison.OrdinalIgnoreCase)
                        .Replace("Amazon.com", "", StringComparison.OrdinalIgnoreCase)
                        .Trim(" -:".ToCharArray());
                    meta = results[0].Snippet;
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Amazon DDG fallback failed");
            }
        }
        _os.OpenUrlOrFile(url);

        var summary = title is null
            ? $"Opening Amazon search for \"{query}\" — pick your favourite, Aarav."
            : $"Top match for \"{query}\": {title}" + (string.IsNullOrWhiteSpace(meta) ? "" : $" — {Truncate(meta, 140)}") + " — opened for you, Aarav.";

        return new AgentResult(true, summary);
    }

    private async Task<AgentResult> HandleGoogleAsync(string query, CancellationToken ct)
    {
        // Google shells out bot responses; DuckDuckGo's HTML endpoint is scraper-tolerant
        // and gives a genuine top-result answer.
        string? summary = null;
        try
        {
            var results = await FetchDuckDuckGoResultsAsync(query, 1, ct);
            if (results.Count > 0)
            {
                var top = results[0];
                summary = $"Searched Google for \"{query}\". Top result — {top.Title}" +
                          (string.IsNullOrWhiteSpace(top.Snippet) ? "" : $": {Truncate(top.Snippet, 200)}");
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "DDG summary fetch failed");
        }

        _os.OpenUrlOrFile($"https://www.google.com/search?q={Uri.EscapeDataString(query)}");

        return new AgentResult(true, summary ??
            $"Searched Google for \"{query}\" — results are open in your browser, Aarav.");
    }

    // ------------------------------------------------------------------
    // DuckDuckGo HTML extraction — bot-tolerant source for summaries
    // ------------------------------------------------------------------

    private async Task<List<(string Url, string Title, string Snippet)>> FetchDuckDuckGoResultsAsync(string query, int max, CancellationToken ct)
    {
        var client = _httpFactory.CreateClient("astra-agent");
        client.DefaultRequestHeaders.UserAgent.ParseAdd(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36");
        client.Timeout = TimeSpan.FromSeconds(8);

        var html = await client.GetStringAsync($"https://html.duckduckgo.com/html/?q={Uri.EscapeDataString(query)}", ct);

        var anchors = DdgAnchorRegex.Matches(html);
        var snippets = DdgSnippetRegex.Matches(html);
        var results = new List<(string, string, string)>();

        for (var i = 0; i < anchors.Count && results.Count < max; i++)
        {
            var href = anchors[i].Groups[1].Value;
            var uddg = Regex.Match(href, @"[?&]uddg=([^&]+)");
            var url = uddg.Success ? Uri.UnescapeDataString(uddg.Groups[1].Value) : href;
            var title = StripTags(anchors[i].Groups[2].Value);
            var snippet = i < snippets.Count ? StripTags(snippets[i].Groups[1].Value) : "";
            if (title.Length > 0) results.Add((url, title, snippet));
        }
        return results;
    }

    private static string StripTags(string html)
    {
        var text = TagRegex.Replace(html, "");
        text = System.Net.WebUtility.HtmlDecode(text);
        return SpaceRegex.Replace(text, " ").Trim();
    }

    private static readonly Regex TagRegex = new("<[^>]+>", RegexOptions.Compiled);
    private static readonly Regex SpaceRegex = new("\\s+", RegexOptions.Compiled);

    // ------------------------------------------------------------------
    // Scraping helpers (best-effort; sites may block bots)
    // ------------------------------------------------------------------

    private async Task<(string? VideoId, string? Title, string? Channel)> TryFetchTopVideoAsync(string resultsUrl, CancellationToken ct)
    {
        try
        {
            var client = _httpFactory.CreateClient("astra-agent");
            client.DefaultRequestHeaders.UserAgent.ParseAdd(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36");
            client.Timeout = TimeSpan.FromSeconds(8);
            var html = await client.GetStringAsync(resultsUrl, ct);
            if (LooksLikeBotWall(html)) return (null, null, null);

            // First organic result: videoId + title come from the same videoRenderer block.
            var m = VideoRendererRegex.Match(html);
            var cM = VideoChannelRegex.Match(html);

            var videoId = m.Success ? m.Groups[1].Value : null;
            var title = m.Success ? System.Net.WebUtility.HtmlDecode(m.Groups[2].Value) : null;
            if (title is not null && (title.Length < 3 || LooksLikeExtractedWall(title))) title = null;
            var channel = cM.Success ? System.Net.WebUtility.HtmlDecode(cM.Groups[1].Value) : null;
            return (videoId, title, channel);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "YouTube fetch failed");
            return (null, null, null);
        }
    }

    private async Task<(string? Title, string? Meta)> TryFetchAmazonMetaAsync(string url, CancellationToken ct)
    {
        try
        {
            var client = _httpFactory.CreateClient("astra-agent");
            client.DefaultRequestHeaders.UserAgent.ParseAdd(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36");
            client.Timeout = TimeSpan.FromSeconds(8);
            var html = await client.GetStringAsync(url, ct);
            if (LooksLikeBotWall(html)) return (null, null);
            var t = ExtractMetaTag(html, "og:title") ?? ExtractFirstVisibleLine(html, 120);
            var d = ExtractMetaTag(html, "og:description");
            return (t, d);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Amazon meta fetch failed");
            return (null, null);
        }
    }

    /// <summary>Detects captcha/consent walls so we never quote bot-check noise as a "summary".</summary>
    private static bool LooksLikeBotWall(string content) =>
        content.Contains("Before you continue", StringComparison.OrdinalIgnoreCase) ||
        content.Contains("consent.youtube.com", StringComparison.OrdinalIgnoreCase) ||
        content.Contains("unusual traffic", StringComparison.OrdinalIgnoreCase) ||
        content.Contains("Enter the characters you see below", StringComparison.OrdinalIgnoreCase) ||
        content.Contains("Please click here if you are not redirected", StringComparison.OrdinalIgnoreCase);

    /// <summary>Stricter check for extracted text, where "enable JavaScript" really is bot noise.</summary>
    private static bool LooksLikeExtractedWall(string content) =>
        LooksLikeBotWall(content) ||
        content.Contains("enable JavaScript", StringComparison.OrdinalIgnoreCase);

    private static int ExtractDelaySeconds(string text, out string remainder)
    {
        var m = DelayRegex().Match(text);
        if (!m.Success)
        {
            remainder = text;
            return 0;
        }
        var n = int.Parse(m.Groups[1].Value);
        var secs = m.Groups[2].Value.StartsWith("min", StringComparison.OrdinalIgnoreCase) ? n * 60 : n;
        remainder = (text[..m.Index] + " " + text[(m.Index + m.Length)..]).Trim();
        return secs;
    }

    private static string? ExtractMetaTag(string html, string property)
    {
        var m = Regex.Match(html,
            $"<meta[^>]+(?:property|name)=[\"']{Regex.Escape(property)}[\"'][^>]+content=[\"']([^\"']{{10,400}})[\"']",
            RegexOptions.IgnoreCase);
        if (m.Success) return System.Net.WebUtility.HtmlDecode(m.Groups[1].Value);
        m = Regex.Match(html,
            $"<meta[^>]+content=[\"']([^\"']{{10,400}})[\"'][^>]+(?:property|name)=[\"']{Regex.Escape(property)}[\"']",
            RegexOptions.IgnoreCase);
        return m.Success ? System.Net.WebUtility.HtmlDecode(m.Groups[1].Value) : null;
    }

    private static string? ExtractFirstVisibleLine(string html, int max)
    {
        var text = ScriptStyleRegex.Replace(html, " ");
        text = TagRegex.Replace(text, " ");
        text = System.Net.WebUtility.HtmlDecode(text);
        text = SpaceRegex.Replace(text, " ").Trim();
        return text.Length == 0 ? null : Truncate(text, max);
    }

    private static readonly Regex ScriptStyleRegex = new(
        "<script[\\s\\S]*?</script>|<style[\\s\\S]*?</style>", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static string Truncate(string s, int max) =>
        s.Length <= max ? s : s[..max].TrimEnd() + "…";

    // ------------------------------------------------------------------
    // Regexes
    // ------------------------------------------------------------------

    [GeneratedRegex(@"^type\s+(.+)$")]
    private static partial Regex TypeRegex();

    [GeneratedRegex(@"^press\s+(?:the\s+)?([a-z0-9]+(?:\s*\+\s*[a-z0-9]+)*)(?:\s+key)?\s*\.?\s*$")]
    private static partial Regex PressRegex();

    [GeneratedRegex(@"\bin\s+(\d+)\s+(seconds?|secs?|minutes?|mins?)\b")]
    private static partial Regex DelayRegex();

    [GeneratedRegex(@"^(?:play|put on|listen to)\s+(.+?)(?:\s+on\s+(?:youtube|music))?[.?]?\s*$|^find\s+(.+?)\s+on\s+youtube[.?]?\s*$")]
    private static partial Regex PlayOnRegex();

    [GeneratedRegex(@"^(?:(?:please|can you|could you)\s+)?(?:search|look up|google|find)\b(?:\s+(?:google|on google|for me))?\s+(?:for\s+)?")]
    private static partial Regex GoogleRegex();

    [GeneratedRegex(@"^(?:open|launch|start|go to|visit)\s+(.+)$")]
    private static partial Regex OpenRegex();

    [GeneratedRegex(@"\s+(?:,\s*)?(?:and then|then|and|also|after that)\s+", RegexOptions.IgnoreCase)]
    private static partial Regex SegmentSplitRegex();

    // YouTube embeds its data in a minified JSON blob inside the results HTML.
    // Verbatim strings: every backslash reaches the regex engine as-is;
    // \x22 is the regex-level hex escape for a double quote (no C# quote escapes needed).
    private static readonly Regex VideoRendererRegex = new(
        @"videoRenderer\x22:[{]\x22videoId\x22:\x22([A-Za-z0-9_-]{11})\x22.+?\x22title\x22:[{]\x22runs\x22:\s*[{]\x22text\x22:\x22(.+?)\x22",
        RegexOptions.Compiled | RegexOptions.Singleline);

    private static readonly Regex VideoChannelRegex = new(
        @"ownerText\x22:[{]\x22runs\x22:\s*[{]\x22text\x22:\x22(.+?)\x22",
        RegexOptions.Compiled | RegexOptions.Singleline);

    // DuckDuckGo result anchors and snippets (quotes via \x22).
    private static readonly Regex DdgAnchorRegex = new(
        @"class=\x22result__a\x22[^>]*href=\x22([^\x22]+)\x22[^>]*>([\S\s]*?)</a>",
        RegexOptions.Compiled);

    private static readonly Regex DdgSnippetRegex = new(
        @"class=\x22result__snippet\x22[^>]*>([\S\s]*?)</a>",
        RegexOptions.Compiled);

    private static readonly Regex WatchIdRegex = new(
        @"(?:v=|youtu\.be/)([A-Za-z0-9_-]{11})",
        RegexOptions.Compiled);
}
