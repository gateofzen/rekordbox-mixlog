// rekordbox-mixlog Worker
// - Verifies the caller's Google access token (must belong to ALLOWED_EMAILS and to our OAuth client)
// - GET  /photo?u=<baseUrl>&w=<px>  : proxies a Google Photos Picker image (avoids browser CORS)
// - POST /read {baseUrl} | {image, mediaType} : asks Claude to read the rekordbox screen
//
// Env:
//   ANTHROPIC_API_KEY (secret)   GOOGLE_CLIENT_ID   ALLOWED_EMAILS (comma separated)
//   ALLOWED_ORIGIN (e.g. https://gateofzen.github.io)   MODEL (optional)

const PROMPT = `This is a phone photo of a laptop screen running rekordbox (Pioneer DJ software) in 2-deck PERFORMANCE mode. The DJ took it right AFTER finishing a successful transition from one track to the other.

Read both decks:
- Deck 1 is the LEFT deck, deck 2 the RIGHT deck. Each deck header shows the track title on the first line, the artist under it (often truncated with "..."), then the track's original BPM and musical key (e.g. "128.86 Abm").
- If a title or artist is truncated, check the track list below the decks: a highlighted row may show more of it. Copy text as displayed; never invent missing words. Keep "..." only if you truly cannot see the rest.
- The large number in each jog circle (e.g. 148.00) is the current playing tempo.

Decide the order from the CHANNEL FADERS: the two vertical faders in the center mixer strip, just below the CUE buttons under the EQ knobs (left = deck 1, right = deck 2). Estimate each fader cap position from 0 (bottom) to 1 (top).
- The deck whose fader is UP is the track the DJ mixed INTO (the "to" track, played second).
- The deck whose fader is DOWN is the track mixed OUT of (the "from" track, played first).
- If both faders look equally up, use the horizontal crossfader and which deck is MASTER as secondary clues, and lower your confidence.

Reply in the required JSON format. Use empty strings for anything unreadable. "reason" is one short sentence in Japanese explaining the fader judgement.`;

const deckSchema = {
  type: "object",
  properties: {
    title: { type: "string" }, artist: { type: "string" },
    bpm: { type: "string", description: "track's original BPM as displayed, e.g. 128.86" },
    key: { type: "string", description: "musical key as displayed, e.g. Abm" },
    fader: { type: "number", description: "channel fader cap position, 0 = bottom, 1 = top" },
  },
  required: ["title", "artist", "bpm", "key", "fader"],
  additionalProperties: false,
};
const READ_SCHEMA = {
    type: "object",
    properties: {
      deck1: deckSchema,
      deck2: deckSchema,
      playing_bpm: { type: "string", description: "current playing tempo shown in the jog circle" },
      from_deck: { type: "integer", enum: [1, 2], description: "deck whose fader is DOWN (mixed out of)" },
      to_deck: { type: "integer", enum: [1, 2], description: "deck whose fader is UP (mixed into)" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      reason: { type: "string" },
    },
    required: ["deck1", "deck2", "playing_bpm", "from_deck", "to_deck", "confidence", "reason"],
    additionalProperties: false,
};

const tokenCache = new Map(); // token -> expiry ms (verified)

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0] || "",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    try {
      if (!allowed.includes(origin)) return json({ error: "origin_not_allowed" }, 403);
      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const auth = await verifyGoogleToken(token, env);
      if (!auth.ok) return json({ error: auth.error }, 401);

      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/photo") {
        const base = checkBaseUrl(url.searchParams.get("u"));
        if (!base) return json({ error: "bad_url" }, 400);
        const w = Math.max(64, Math.min(2048, parseInt(url.searchParams.get("w") || "320", 10) || 320));
        const r = await fetch(`${base}=w${w}-h${w}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return json({ error: "photo_fetch_failed", status: r.status }, 502);
        return new Response(r.body, {
          headers: { ...cors, "Content-Type": r.headers.get("Content-Type") || "image/jpeg", "Cache-Control": "private, max-age=3000" },
        });
      }

      if (request.method === "POST" && url.pathname === "/read") {
        const body = await request.json().catch(() => ({}));
        let data, mediaType;
        if (body.baseUrl) {
          const base = checkBaseUrl(body.baseUrl);
          if (!base) return json({ error: "bad_url" }, 400);
          const r = await fetch(`${base}=w1600-h1600`, { headers: { Authorization: `Bearer ${token}` } });
          if (!r.ok) return json({ error: "photo_fetch_failed", status: r.status }, 502);
          data = toBase64(await r.arrayBuffer());
          mediaType = (r.headers.get("Content-Type") || "image/jpeg").split(";")[0];
        } else if (typeof body.image === "string") {
          data = body.image;
          mediaType = body.mediaType || "image/jpeg";
        } else return json({ error: "no_image" }, 400);
        if (!/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) mediaType = "image/jpeg";
        if (data.length > 7_000_000) return json({ error: "image_too_large" }, 413);

        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: env.MODEL || "claude-sonnet-5-5",
            max_tokens: 2048,
            output_config: { format: { type: "json_schema", schema: READ_SCHEMA } },
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data } },
                { type: "text", text: PROMPT },
              ],
            }],
          }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) return json({ error: "claude_error", status: res.status, detail: out?.error?.message || "" }, 502);
        const text = (out.content || []).filter(c => c.type === "text").map(c => c.text).join("");
        const parsed = parseJson(text);
        if (!parsed || !parsed.deck1 || !parsed.deck2)
          return json({ error: "invalid_json", detail: `stop_reason=${out.stop_reason || "?"}`, raw: text.slice(0, 2000) }, 502);
        return json({ ok: true, result: parsed });
      }

      return json({ error: "not_found" }, 404);
    } catch (e) {
      return json({ error: "server_error", detail: String(e?.message || e) }, 500);
    }
  },
};

async function verifyGoogleToken(token, env) {
  if (!token) return { ok: false, error: "no_token" };
  const now = Date.now();
  const hit = tokenCache.get(token);
  if (hit && hit > now) return { ok: true };
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(token));
  if (!r.ok) return { ok: false, error: "invalid_token" };
  const info = await r.json();
  const emails = (env.ALLOWED_EMAILS || "").toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
  const aud = info.aud || info.azp || info.issued_to;
  if (env.GOOGLE_CLIENT_ID && aud !== env.GOOGLE_CLIENT_ID) return { ok: false, error: "wrong_client" };
  if (String(info.email_verified) !== "true" || !emails.includes(String(info.email || "").toLowerCase()))
    return { ok: false, error: "email_not_allowed" };
  const exp = now + Math.min(Number(info.expires_in || 0) * 1000, 30 * 60e3);
  if (tokenCache.size > 200) tokenCache.clear();
  tokenCache.set(token, exp);
  return { ok: true };
}

function checkBaseUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".googleusercontent.com")) return null;
    return u; // Picker baseUrls come without size params; we append them
  } catch { return null; }
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function parseJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}
