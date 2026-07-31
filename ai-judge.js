// ============================================================================
// DERAIL — ai-judge.js
// Replaces (or falls back from) peer voting: asks Gemini to read the finished
// story and rule on whether each player actually landed their secret goal.
// One call per game (all players judged together, not one call per player)
// to keep token usage sane when a lot of rooms are running at once.
//
// Needs GEMINI_API_KEY set as an environment variable. Never hardcode a key
// here — see README section on AI-judged voting for setup.
// ============================================================================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || null;

// Tried in order; first one that returns a usable result wins. Mixing
// generations/tiers spreads load across separate quota buckets, which
// matters if a lot of games finish around the same time. If Google renames
// or retires one of these, judging just falls through to the next model —
// and if all of them fail, the caller falls back to human voting, so this
// list going stale never breaks the game, only degrades this one feature.
// Check https://ai.google.dev/gemini-api/docs/models for current names if
// judging stops working entirely.
const GEMINI_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-flash-latest",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

const REQUEST_TIMEOUT_MS = 12000;

function isConfigured() {
  return !!GEMINI_API_KEY;
}

function buildPrompt({ scenario, story, players, language }) {
  const langNote = { en: "English", el: "Greek", es: "Spanish" }[language] || "English";
  const storyText = [scenario, ...story.map((s) => `${s.name}: ${s.text}`)].join("\n");
  const playerList = players.map((p) => `- id "${p.id}": secret goal — ${p.goalText}`).join("\n");

  return `You are judging a party game called Derail. A group wrote one shared story together, one sentence at a time. Each player secretly had a different, often absurd goal they were trying to steer the story toward WITHOUT it being obvious. Nobody else could see anyone else's goal while writing.

The finished story (written in ${langNote}):
"""
${storyText}
"""

Each player's secret goal:
${playerList}

For each player, decide whether their secret goal was genuinely fulfilled by how the story actually turned out — be a fair but not overly lenient judge. A goal counts as fulfilled if the story's events clearly satisfy it, even loosely or humorously; it does NOT need to be the literal focus of the ending. A goal that never happened, or only sort-of almost happened, should be marked false.

Respond with ONLY a JSON array, no other text, in this exact shape:
[{"id": "<player id>", "success": true or false, "reason": "<one short, punchy sentence explaining the verdict, written like a detective's case note>"}]

Include exactly one entry per player id listed above. The "reason" must be in ${langNote}.`;
}

function extractJsonArray(text) {
  if (!text) return null;
  const trimmed = text.trim().replace(/^```json\s*|^```\s*|```$/g, "");
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to a looser attempt below
  }
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* give up */
    }
  }
  return null;
}

async function callModel(model, prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 1024,
            responseMimeType: "application/json",
          },
        }),
      }
    );
    if (!res.ok) {
      // 429 (quota) or 5xx — signal the caller to try the next model.
      return { ok: false, retryable: res.status === 429 || res.status >= 500 };
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    const parsed = extractJsonArray(text);
    if (!parsed) return { ok: false, retryable: true };
    return { ok: true, verdicts: parsed };
  } catch {
    return { ok: false, retryable: true };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Judges every unbusted player's goal against the finished story in a
 * single Gemini call, trying each model in GEMINI_MODELS until one works.
 *
 * @param {{scenario:string, story:Array<{name:string,text:string}>, players:Array<{id:string,goalText:string}>, language:string}} input
 * @returns {Promise<Map<string,{success:boolean, reason:string}>|null>} null means "AI judging unavailable — fall back to voting"
 */
async function judgeStory(input) {
  if (!isConfigured() || !input.players || input.players.length === 0) return null;

  const prompt = buildPrompt(input);

  for (const model of GEMINI_MODELS) {
    const result = await callModel(model, prompt);
    if (result.ok) {
      const map = new Map();
      for (const v of result.verdicts) {
        if (v && typeof v.id === "string") {
          map.set(v.id, { success: !!v.success, reason: String(v.reason || "").slice(0, 240) });
        }
      }
      // Make sure every requested player got a verdict; if the model
      // dropped someone, treat the whole response as unusable and let the
      // loop try the next model rather than silently under-scoring a player.
      const coversEveryone = input.players.every((p) => map.has(p.id));
      if (coversEveryone) return map;
    }
    if (!result.retryable) break;
  }
  return null; // every model failed or returned something unusable
}

module.exports = { judgeStory, isConfigured, GEMINI_MODELS };
