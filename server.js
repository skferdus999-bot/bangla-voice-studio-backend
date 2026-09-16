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

async function getAllVoices() {
  if (voiceCache.voices.length && Date.now() - voiceCache.time < CACHE_MS) {
    return voiceCache.voices;
  }

  let all = [];
  let token = null;
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({ page_size: "100", include_total_count: "false" });
    if (token) params.set("next_page_token", token);

    const r = await fetch(`https://api.elevenlabs.io/v2/voices?${params}`, {
      headers: { "xi-api-key": KEY }
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.detail?.message || data?.detail || `ElevenLabs voices HTTP ${r.status}`);

    all = all.concat(Array.isArray(data.voices) ? data.voices : []);
    if (!data.has_more || !data.next_page_token) break;
    token = data.next_page_token;
  }

  voiceCache.time = Date.now();
  voiceCache.voices = all;
  return all;
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

function freeAccessible(voice) {
  const tiers = Array.isArray(voice?.available_for_tiers) ? voice.available_for_tiers.map(x => String(x).toLowerCase()) : [];
  if (tiers.includes("free")) return true;
  if (voice?.sharing?.free_users_allowed === true) return true;
  return false;
}

function scoreVoice(voice, lang, gender) {
  const v = verifiedInfo(voice, lang);
  const g = genderMatches(voice, gender);
  const labelLang = labelLanguageMatches(voice, lang);
  let score = 0;
  if (g) score += 1000;
  if (v) score += 800;
  if (v && String(v.model_id || "").toLowerCase() === MODEL) score += 250;
  if (v && LANGS[lang].locales.map(x => x.toLowerCase()).includes(String(v.locale || "").toLowerCase())) score += 120;
  if (labelLang) score += 80;
  if (freeAccessible(voice)) score += 40;
  if (voice?.recording_quality === "studio") score += 20;
  return score;
}

async function chooseVoice(lang, gender) {
  const voices = await getAllVoices();
  const wantedGender = normalizeGender(gender);
  const ranked = voices
    .map(v => ({ v, score: scoreVoice(v, lang, wantedGender) }))
    .sort((a, b) => b.score - a.score);

  // Prefer the requested gender. If none is labelled, allow a language-matched voice.
  const genderPool = ranked.filter(x => genderMatches(x.v, wantedGender));
  const languagePool = ranked.filter(x => verifiedInfo(x.v, lang) || labelLanguageMatches(x.v, lang));

  if (genderPool.length) return genderPool[0].v;
  if (languagePool.length) return languagePool[0].v;
  if (ranked.length) return ranked[0].v;
  return null;
}

function publicVoice(v, lang) {
  const verified = verifiedInfo(v, lang);
  return {
    voiceId: v.voice_id,
    name: v.name,
    gender: v?.labels?.gender || null,
    accent: v?.labels?.accent || verified?.accent || null,
    locale: verified?.locale || null,
    verifiedLanguage: verified?.language || null,
    verifiedModel: verified?.model_id || null,
    previewUrl: v.preview_url || verified?.preview_url || null,
    freeAccessible: freeAccessible(v)
  };
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "Bangla Voice Studio — Eleven v3", model: MODEL, dynamicVoices: true });
});

app.get("/voices", async (req, res) => {
  try {
    if (!KEY) return res.status(500).json({ error: "ELEVENLABS_API_KEY is not configured" });
    const lang = normalizeLang(req.query.language || "bn");
    const gender = normalizeGender(req.query.gender || "female");
    const voices = await getAllVoices();
    const filtered = voices
      .filter(v => genderMatches(v, gender) && (verifiedInfo(v, lang) || labelLanguageMatches(v, lang)))
      .sort((a, b) => scoreVoice(b, lang, gender) - scoreVoice(a, lang, gender));
    res.json({ model: MODEL, language: lang, gender, voices: filtered.map(v => publicVoice(v, lang)) });
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

    const voice = await chooseVoice(lang, voiceGender);
    if (!voice) return res.status(400).json({ error: `No usable ElevenLabs voice found for ${lang}/${normalizeGender(voiceGender)}` });

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

    const b = Buffer.from(await r.arrayBuffer());
    if (!r.ok) return res.status(r.status).send(b.toString("utf8"));

    res.json({
      audioContent: b.toString("base64"),
      voiceId: voice.voice_id,
      voiceName: voice.name,
      voiceGender: voice?.labels?.gender || null,
      model: MODEL,
      language: lang,
      note: "Eleven v3 is expressive; speed slider is not sent because v3 does not expose API speed control. Use v3 audio tags such as [whispers], [shouts], [laughs] in the text when desired."
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Bangla Voice Studio Eleven v3 backend listening on ${PORT}`));
