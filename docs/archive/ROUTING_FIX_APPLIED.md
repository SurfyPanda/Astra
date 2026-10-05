# AgentRouter Command Intent Fix - October 5, 2026

## Issue Resolved

**Problem:** AgentRouter was too eager to treat any mention of "search" as a web command.

**Example failure:**
- Input: `"search what is the value of pi"`
- Old behavior: Opened Google search ❌
- Expected: Normal chat conversation ✅

## Root Cause

The old Google search detection was:
1. Too loose in the regex pattern
2. Didn't distinguish between questions and commands
3. Triggered on "search" appearing anywhere in the input

## Solution Applied

### Strict Two-Layer Filtering

**Layer 1: Regex Pattern**
- Requires explicit web context: "google", "the web", "online"
- OR clear imperative: "look up", "search for", "search the"

**Layer 2: Question Word Filter**
- If extracted query starts with question words (what, how, why, when, where, who, which, is, are, does, do, can, will, should)
- → Return `null` (treat as normal chat)

### New Logic

```csharp
// Match pattern with explicit web context
var googleMatch = Regex.Match(lower, 
    @"^(?:(?:please|can you|could you)\s+)?" +
    @"(?:search|look\s*up|google|find)" +
    @"(?:\s+(?:google|the\s+web|online|on\s+google))?" +
    @"\s+(?:for\s+)?" +
    @"(.+?)(?:\s+(?:on|using)\s+(?:google|the\s+web|online))?[.?]?\s*$",
    RegexOptions.IgnoreCase);

if (googleMatch.Success)
{
    var query = googleMatch.Groups[1].Value.Trim();
    
    // Reject if query is actually a question
    var questionWords = new[] { "what", "how", "why", "when", "where", "who", "which", 
                               "is ", "are ", "does ", "do ", "can ", "will ", "should " };
    var looksLikeQuestion = questionWords.Any(qw => query.ToLowerInvariant().StartsWith(qw));
    
    if (looksLikeQuestion)
    {
        return null; // Normal chat
    }
    
    // Must have explicit web context
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
```

## Test Results

All test cases pass:

### ✅ Normal Chat (NO browser action)

| Input | Result |
|-------|--------|
| `"What is the value of pi?"` | ✅ Normal chat |
| `"What is Google?"` | ✅ Normal chat |
| `"How does Google search work?"` | ✅ Normal chat |
| `"Explain search algorithms."` | ✅ Normal chat |
| `"What is YouTube?"` | ✅ Normal chat |
| `"Can you explain how browsers search the web?"` | ✅ Normal chat |
| `"Search what is the value of pi."` | ✅ Normal chat (ambiguous, treated as question) |

### ✅ Web Commands (SHOULD open browser/search)

| Input | Result |
|-------|--------|
| `"Search Google for the value of pi."` | ✅ Google search executed |
| `"Search the web for the latest SpaceX news."` | ✅ Google search executed |
| `"Look up the current weather online."` | ✅ Google search executed |
| `"Open google.com."` | ✅ Browser opened |

## What Changed

### File Modified
- `backend/Services/AgentRouter.cs`

### Specific Section
- Lines ~147-195 (Google search detection and routing)

### Change Summary
- **Old:** Simple regex match, no question filtering
- **New:** Two-layer filtering (explicit web context + question word rejection)

## Architecture

The router now properly distinguishes:

1. **NORMAL_CHAT** → Questions, explanations, casual mentions
   - "What is X?"
   - "How does search work?"
   - "Explain YouTube"
   - "Search what is..." (ambiguous)

2. **WEB_SEARCH** → Explicit search commands with web context
   - "Search Google for X"
   - "Look up X online"
   - "Search the web for X"

3. **OPEN_URL** → Direct browser commands
   - "Open google.com"
   - "Go to youtube"

4. **APP_LAUNCH** → Application commands
   - "Open calculator"
   - "Launch Spotify"

5. **TYPE/KEYPRESS** → Keyboard automation
   - "Type hello world"
   - "Press cmd+t"

## Future Considerations

When ASTRA has its own local language model:

```
USER INPUT
    ↓
ASTRA LOCAL MODEL
    ↓
Intent Classification
    ↓
├─ NORMAL_CHAT → Answer locally
├─ WEB_SEARCH → AgentRouter.HandleGoogleAsync()
├─ OPEN_URL → AgentRouter.HandleOpen()
├─ APP_LAUNCH → AgentRouter.HandleOpen()
└─ AUTOMATION → AgentRouter keyboard/typing methods
```

The deterministic router will remain responsible for **executing** actions, while the model determines **intent**.

## Verification

Compiled and tested:
```bash
✅ Backend builds successfully
✅ All "normal chat" cases stay in chat
✅ All "web command" cases execute commands
✅ No false positives
✅ No false negatives
```

## Status

**Issue:** ✅ RESOLVED  
**Testing:** ✅ VERIFIED  
**Deployment:** ✅ READY

The routing logic now correctly distinguishes normal questions from explicit web actions.
