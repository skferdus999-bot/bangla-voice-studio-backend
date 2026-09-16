const express = require("express");
const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;
const KEY = process.env.ELEVENLABS_API_KEY;
const MODEL = "eleven_v3";
const CACHE_MS = 5 * 60 * 1000;

const LANGS = {
  bn: { name: "Bengali", codes: ["bn", "ben"], locales: ["bn-BD", "bn-IN"] },
  hi: { name: "Hindi", codes: ["hi", "hin"], locales: ["hi-IN"] },
  en: { name: "English", codes: ["en", "eng"], locales: ["en-US", "en-GB"] },
  ur: { name: "Urdu", codes: ["ur", "urd"], locales: ["ur-IN", "ur-PK"] }
};

const voiceCache = { time: 0, voices: [] };

function normalizeGender(g) {
  return String(g || "FEMALE").toLowerCase() === "male" ? "male" : "female";
}
function normalizeLang(l) {
  const x = String(l || "bn").toLowerCase();
  if (!LANGS[x]) throw new Error("Unsupported language. Use bn, hi, en or ur.");
  return x;
}

// IMPORTANT: Do not use Voice Library voices on the Free plan.
// Keep only account-owned/generated/cloned voices and ElevenLabs premade voices.
function freePlanSafe(v) {
  const category = String(v?.category || "").toLowerCase();
  const owner = v?.is_owner === true;
  const tiers = Array.isArray(v?.available_for_tiers)
    ? v.available_for_tiers.map(x => String(x).toLowerCase()) : [];

  // Premade voices are first-party, not community Voice Library voices.
  if (category === "premade") return true;
  // User-owned voices are allowed (subject to the account's own plan/limits).
  if (owner) return true;
  // Some API responses explicitly mark a voice as free-user accessible.
  if (v?.sharing?.free_users_allowed === true) return true;
  if (tiers.includes("free")) return true;
  return false;
}

async function getAllVoices() {
  if (voiceCache.voices.length && Date.now() - voiceCache.time < CACHE_MS) return voiceCache.voices;

  const r = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": KEY }
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.detail?.message || data?.detail || `ElevenLabs voices HTTP ${r.status}`);

  voiceCache.time = Date.now();
  voiceCache.voices = Array.isArray(data.voices) ? data.voices : [];
  return voiceCache.voices;
}

function verifiedInfo(voice, lang) {
  const wanted = LANGS[lang];
  const list = Array.isArray(voice?.verified_languages) ? voice.verified_languages : [];
  return list.find(x => {
    const code = String(x?.language || "").toLowerCase();
    const locale = String(x?.locale || "").toLowerCase();
    return wanted.codes.includes(code) || wanted.locales.map(v => v.toLowerCase()).includes(locale);
  }) || null;
}
function labelLanguageMatches(voice, lang) {
  const wanted = LANGS[lang];
  const label = String(voice?.labels?.language || "").toLowerCase();
  return wanted.codes.includes(label) || wanted.name.toLowerCase() === label;
}
function genderMatches(voice, gender) {
  return String(voice?.labels?.gender || "").toLowerCase() === gender;
}

function scoreVoice(v, lang, gender) {
  let score = 0;
  const verified = verifiedInfo(v, lang);
  const category = String(v?.category || "").toLowerCase();
  if (genderMatches(v, gender)) score += 1000;
  if (verified) score += 500;
  if (labelLanguageMatches(v, lang)) score += 150;
  if (category === "premade") score += 300;
  if (v?.is_owner === true) score += 250;
  if (v?.sharing?.free_users_allowed === true) score += 200;
  if (verified && String(verified.model_id || "").toLowerCase() === MODEL) score += 100;
  return score;
}

function chooseVoice(voices, lang, gender) {
  const wantedGender = normalizeGender(gender);
  const safe = voices.filter(freePlanSafe);
  if (!safe.length) return null;

  // Prefer a requested-gender voice, then a language-matched safe voice,
  // then any safe premade voice. This deliberately never selects Voice Library voices.
  const ranked = safe.map(v => ({ v, score: scoreVoice(v, lang, wantedGender) }))
    .sort((a, b) => b.score - a.score);
  const sameGender = ranked.filter(x => genderMatches(x.v, wantedGender));
  const langMatch = ranked.filter(x => verifiedInfo(x.v, lang) || labelLanguageMatches(x.v, lang));
  const premade = ranked.filter(x => String(x.v.category || "").toLowerCase() === "premade");
  return (sameGender[0] || langMatch[0] || premade[0] || ranked[0])?.v || null;
}

function publicVoice(v, lang) {
  const verified = verifiedInfo(v, lang);
  return {
    voiceId: v.voice_id,
    name: v.name,
    category: v.category || null,
    gender: v?.labels?.gender || null,
    accent: v?.labels?.accent || verified?.accent || null,
    locale: verified?.locale || null,
    verifiedLanguage: verified?.language || null,
    verifiedModel: verified?.model_id || null,
    previewUrl: v.preview_url || null,
    freePlanSafe: freePlanSafe(v)
  };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "Bangla Voice Studio — Eleven v3 Free-safe", model: MODEL, voiceLibraryDisabled: true });
});

app.get("/voices", async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "ELEVENLABS_API_KEY is not configured" });
    const lang = normalizeLang(req.query.language || "bn");
    const gender = normalizeGender(req.query.gender || "female");
    const voices = await getAllVoices();
    const safe = voices.filter(freePlanSafe)
      .filter(v => genderMatches(v, gender))
      .sort((a, b) => scoreVoice(b, lang, gender) - scoreVoice(a, lang, gender));
    res.json({ model: MODEL, language: lang, gender, voiceLibraryDisabled: true, voices: safe.map(v => publicVoice(v, lang)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/tts", async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "ELEVENLABS_API_KEY is not configured" });
    const { text, language = "bn", voiceGender = "FEMALE" } = req.body || {};
    const lang = normalizeLang(language);
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text is required" });
    if (String(text).length > 5000) return res.status(400).json({ error: "Eleven v3 supports up to 5,000 characters per request." });

    const voices = await getAllVoices();
    const voice = chooseVoice(voices, lang, voiceGender);
    if (!voice) {
      return res.status(400).json({
        error: `No Free-plan-safe voice is available for ${lang}/${normalizeGender(voiceGender)}. Create or add an account voice, or use a first-party premade voice.`
      });
    }

    const u = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice.voice_id)}?output_format=mp3_44100_128`;
    const body = {
      text: String(text),
      model_id: MODEL,
      language_code: lang
    };

    const r = await fetch(u, {
      method: "POST",
      headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const raw = await r.arrayBuffer();
    if (!r.ok) return res.status(r.status).send(Buffer.from(raw).toString("utf8"));

    res.json({
      audioContent: Buffer.from(raw).toString("base64"),
      voiceId: voice.voice_id,
      voiceName: voice.name,
      voiceGender: voice?.labels?.gender || null,
      voiceCategory: voice?.category || null,
      model: MODEL,
      language: lang,
      voiceLibraryDisabled: true,
      note: "Free-safe voice selection only. Eleven v3 speed control is not sent; use v3 audio tags such as [whispers], [shouts], [laughs] in text when desired."
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Bangla Voice Studio Eleven v3 Free-safe backend listening on ${PORT}`));
