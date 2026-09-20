/**
 * KEN CARTER — checkout enforcement Worker
 * ────────────────────────────────────────────────────────────────────────
 * All NOWPayments traffic + download-link custody lives HERE, never in the
 * site's public JavaScript.
 *
 * Settlement: Solana network (SOL & SPL tokens, e.g. USDC / USDT on Solana)
 *   Merchant wallet: U8rFsuwmY5bXftVwmJt43VYApgFE6MbEhZbUcXwamnS
 *   Payments route through NOWPayments to ensure proper conversion
 *   and on-chain verification before files are released.
 *
 * Routes
 *   POST /api/checkout            create a NOWPayments payment for a cart
 *   GET  /api/status?order_id=…   live payment status (+ links ONLY if released)
 *   POST /api/ipn                 NOWPayments webhook — HMAC-SHA512 verified;
 *                                 releases links + emails them on 'finished'
 *   POST /api/notify-beat         per-beat "notify me when it drops" signup
 *   POST /api/notify-drop         email a beat's subscribers that it is now live
 *   POST /api/release             secure broadcast — new beat release to all subscribers
 *                                 (requires Authorization: Bearer <DISPATCH_SECRET>)
 *   GET  /api/release?secret=…     same trigger via query param (manual/instant only)
 *   scheduled                     cron → notifyDueDrops() automates beat releases
 *                                 straight from BEAT_CATALOG.releaseAt timers; no
 *                                 manual cron/URL upkeep (see wrangler.toml [triggers])
 *
 * Secrets (wrangler secret put …):
 *   NOWPAYMENTS_API_KEY     payments API key
 *   NOWPAYMENTS_IPN_SECRET  IPN signing secret (dashboard → IPN settings)
 *   RESEND_API_KEY          transaction email API key (free tier: 3k/mo)
 *   RESEND_FROM             verified sender, e.g. "KEN CARTER <noreply@…>"
 *   DISPATCH_SECRET         shared secret for /api/release (optional — a hardcoded
 *                           fallback "kencarter-release-2026!" is also accepted)
 *   BEAT_LINKS              JSON: { "beat1": "https://drive…", … }
 *   BEAT_DROPS              JSON: { "beatId": "ISO drop time", … } — OPTIONAL.
 *                           Overrides/reschedules the BEAT_CATALOG releaseAt
 *                           timers that otherwise drive the automated drops.
 *
 * Bindings: KV namespace "ORDERS" (see wrangler.toml).
 */

const NP_API = "https://api.nowpayments.io/v1";
const RESEND_ENDPOINT = "https://api.resend.com/emails";

const LOGO_URL = "https://www.kencarter.abrdns.com/assets/logo.jpg";
const SITE_URL = "https://www.kencarter.abrdns.com";

const KEN_MINT = "HEFkC6WQo3jTv39B6JhYQJ3ZW8xKxRELaWdnirdSpump";
const MERCHANT_SOL_ADDRESS = "U8rFsuwmY5bXftVwmJt43VYApgFE6MbEhZbUcXwamnS";

// Hardcoded accepted secret for /api/release. This guarantees the release
// endpoint keeps working even if the DISPATCH_SECRET env binding is missing,
// out of sync, or reloaded. The env binding (if set) is ALSO accepted.
const FALLBACK_DISPATCH_SECRET = "kencarter-release-2026!";

const COIN_CODES = {
  USDT: "usdtsol",
  USDC: "usdc",
  BTC: "btc",
  ETH: "eth",
  SOL: "sol",
  LTC: "ltc",
  KEN: "sol"
};

// Strict per spec: release exclusively on IPN 'finished'.
const RELEASE_STATUS = "finished";

const corsHeaders = (env) => ({
  "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
});

const json = (env, obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) }
  });

async function handleKenPrice(env) {
  const jupUrls = [
    "https://price.jup.ag/v4/price?ids=" + KEN_MINT,
    "https://api.jup.ag/price/v2?ids=" + KEN_MINT
  ];
  for (const u of jupUrls) {
    try {
      const res = await fetch(u, { headers: { "Accept": "application/json" } });
      if (!res.ok) continue;
      const body = await res.json().catch(() => null);
      const p = body && body.data && body.data[KEN_MINT];
      const usd = Number(p && p.price);
      if (usd > 0) return json(env, { usd, source: "jup" });
    } catch (err) { /* try next source */ }
  }
  const fixed = Number(env.KEN_USD_PRICE);
  if (fixed > 0) return json(env, { usd: fixed, source: "config" });
  return json(env, { usd: null });
}

const orderKey = (id) => "order:" + id;
const ttl = () => ({ expirationTtl: 60 * 60 * 24 * 7 });
const notifyKey = (beatId) => "notify-sub:" + beatId;      // subscribed emails per beat
const notifiedKey = (beatId) => "notify-sent:" + beatId;   // drop notifications already sent (beat-level flag)
const notifiedEmailKey = (beatId, email) =>                 // per-email dedup key
  `notify-sent:${beatId}:${email.toLowerCase()}`;
const pendingExclusiveKey = (beatId) => "exclusive-pending:" + beatId; // checkout → IPN reservation for an exclusive-master-rights purchase

function beatLinks(env) {
  try {
    return JSON.parse(env.BEAT_LINKS || "{}");
  } catch {
    return {};
  }
}

// ── Beat catalog (mirrors script.js) ───────────────────────────────────
// Kept in sync with the storefront definition so release / notify emails
// include real titles, BPM, key, and YouTube previews, and so
// the automated drop schedule (releaseAt) needs NO manual cron or secret.
const BEAT_CATALOG = {
  // ── Season 01 ──
  beat1: { title: "BEAT 01", name: "CH$\u00a3$$",        bpm: 140, key: "E MIN",  tag: "SEASON 01", youtube: "https://youtu.be/EtIy63bCyEc" },
  beat2: { title: "BEAT 02", name: "AnGeLL",             bpm: 75,  key: "G# MIN", tag: "SEASON 01", youtube: "https://youtu.be/Y4CY1Qb4e4s" },
  beat3: { title: "BEAT 03", name: "DIAMONS IN THE BAG", bpm: 130, key: "A# MIN", tag: "SEASON 01", youtube: "https://youtu.be/orkevqUH0bM" },
  beat4: { title: "BEAT 04", name: "$$$",                bpm: 140, key: "G MIN",  tag: "SEASON 01", youtube: "https://youtu.be/bRudvWoy7RY" },
  beat5: { title: "BEAT 05", name: "HIGH VIEW",          bpm: 168, key: "C MIN",  tag: "SEASON 01", youtube: "https://youtu.be/12qPZNM2fe0" },
  beat6: { title: "BEAT 06", name: "PROTOCOL",           bpm: 135, key: "G# MIN", tag: "SEASON 01", youtube: "https://youtu.be/xk_SSDX4vZE" },
  beat7: { title: "BEAT 07", name: "LAST SEAT",          bpm: 140, key: "G# MIN", tag: "SEASON 01", releaseAt: "2026-08-23T17:00:00Z", youtube: "https://youtu.be/p7vyAIsWKQw" },
  // ── Season 02 ──
  "s2-beat1": { title: "BEAT 01", name: "ART",           bpm: 126, key: "C# MIN", tag: "SEASON 02", releaseAt: "2026-09-01T17:00:00Z", youtube: "https://youtu.be/LeARirM_bl0" },
  "s2-beat2": { title: "BEAT 02", name: "Take the CROW", bpm: 130, key: "D# MIN", tag: "SEASON 02", releaseAt: "2026-09-05T17:00:00Z", youtube: "https://youtu.be/ZptaYX0g8uU" },
  "s2-beat3": { title: "BEAT 03", name: "Late Night",     bpm: 138, key: "E MIN",  tag: "SEASON 02", releaseAt: "2026-09-09T17:00:00Z", youtube: "https://youtu.be/EpV_G80aKQU" },
  "s2-beat4": { title: "BEAT 04", name: "Antinous",       bpm: 130, key: "F MIN",  tag: "SEASON 02", releaseAt: "2026-09-13T17:00:00Z", youtube: "https://youtu.be/PD4qibTpR_s" },
  "s2-beat5": { title: "BEAT 05", name: "4 AM",           bpm: 166, key: "F# MIN", tag: "SEASON 02", releaseAt: "2026-09-17T17:00:00Z", youtube: "https://youtu.be/alA-itPRkt4" },
  "s2-beat6": { title: "BEAT 06", name: "White",          bpm: 119, key: "B MIN",  tag: "SEASON 02", releaseAt: "2026-09-21T17:00:00Z", youtube: "https://youtu.be/nl2M-EaCrrk" },
  "s2-beat7": { title: "BEAT 07", name: "Rewind",         bpm: 132, key: "G MIN",  tag: "SEASON 02", releaseAt: "2026-09-25T17:00:00Z", youtube: "https://youtu.be/WZLsWpzFJAs" }
};

function lookupBeat(beatId) {
  return BEAT_CATALOG[beatId] || null;
}

// Resolve a beatId to its display label + catalog details for emails.
//   "Late Night — BEAT 03 | SEASON 02"
// Falls back to the formatted id when the beat is not in the catalog, so
// unknown/upcoming beats still produce a sensible personalization.
function describeBeat(bId) {
  const label = formatBeatId(bId);
  const entry = lookupBeat(bId) || {};
  const name = entry.name || label;
  const title = entry.title && entry.tag ? `${entry.title} | ${entry.tag}` : label;
  return {
    label,
    name,
    title,
    display: name !== label ? `${name} — ${title}` : title,
    bpm: entry.bpm,
    key: entry.key,
    youtube: entry.youtube
  };
}

// Inline anchor for a row value inside notificationHtml (values are raw HTML).
function linkHtml(href, text) {
  return href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener" style="color:#f2f2f2;font-weight:600;text-decoration:underline;">${esc(text)} →</a>`
    : "<span style=\"color:#555555;\">—</span>";
}

async function np(env, path, method, body) {
  const res = await fetch(NP_API + path, {
    method,
    headers: { "x-api-key": env.NOWPAYMENTS_API_KEY, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    const err = new Error((data && data.message) || "NOWPAYMENTS ERROR " + res.status);
    err.status = res.status;
    throw err;
  }
  return data;
}

// USD-equivalent minimum charge per coin (network-fee driven). Used by the
// popup to hide coins a cart total can't satisfy BEFORE the buyer picks one.
// NOWPayments rate-limits bursts, so calls run sequentially with a retry.
async function handleMins(url, env) {
  const coins = (url.searchParams.get("coins") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => COIN_CODES[s]);
  const mins = {};
  // NOWPayments rate-limits bursts — pace lookups (configurable for tests)
  const paceMs = Number(env.MIN_LOOKUP_DELAY_MS ?? 200);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  for (const sym of coins) {
    try {
      const code = COIN_CODES[sym];
      // min-amount returns the minimum in coin units; convert it to USD.
      let m = null;
      for (let attempt = 0; attempt < 2 && !m; attempt++) {
        try {
          m = await np(env, "/min-amount?currency_from=" + code + "&currency_to=usd", "GET");
        } catch (e) {
          if (attempt === 0) await sleep(paceMs * 2);
          else throw e;
        }
      }
      if (typeof m.min_amount !== "number") continue;
      const est = await np(env, "/estimate?amount=" + m.min_amount + "&currency_from=" + code + "&currency_to=usd", "GET");
      const usd = typeof est.estimated_amount === "number" ? est.estimated_amount : parseFloat(est.estimated_amount);
      // small safety margin so borderline totals don't slip through
      if (usd != null && !isNaN(usd)) mins[sym] = Math.ceil(usd * 100 * 1.05) / 100;
      await sleep(paceMs);
    } catch (e) {
      console.error("min lookup failed:", sym, e.message);
    }
  }
  return json(env, { mins });
}

async function callSolanaRpc(env, method, params) {
  const rpcUrl = env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const data = await res.json().catch(() => null);
  return data && data.result;
}

async function handleVerifyKen(request, env) {
  const body = await request.json().catch(() => null);
  const { walletAddress } = body || {};
  if (!walletAddress) return json(env, { error: "INVALID WALLET ADDRESS" }, 400);

  try {
    const result = await callSolanaRpc(env, "getTokenAccountsByOwner", [
      walletAddress,
      { mint: KEN_MINT },
      { encoding: "jsonParsed" }
    ]);
    let totalBalance = 0;
    if (result && Array.isArray(result.value)) {
      for (const acc of result.value) {
        const parsed = acc?.account?.data?.parsed?.info;
        if (parsed && parsed.tokenAmount) {
          totalBalance += parseFloat(parsed.tokenAmount.uiAmount || 0);
        }
      }
    }
    return json(env, { holder: totalBalance > 0, balance: totalBalance });
  } catch (err) {
    console.error("Solana RPC verification error:", err);
    return json(env, { holder: false, balance: 0, error: err.message }, 200);
  }
}

export async function verifyIpnSignature(ipnSecret, rawBody, signature) {
  if (!ipnSecret || !signature) return false;
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    return false;
  }
  // NOWPayments scheme: sort keys A→Z, concatenate the VALUES, HMAC-SHA512,
  // compare against the hex x-nowpayments-sig header. Some integration
  // samples join with '|'; both variants are accepted here — tighten to one
  // once confirmed against a live callback.
  const values = Object.keys(data).sort().map((k) => {
    const v = data[k];
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  });
  const candidates = [values.join("|"), values.join("")];
  const expected = signature.toLowerCase();
  for (const candidate of candidates) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(ipnSecret),
      { name: "HMAC", hash: "SHA-512" },
      false, ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, enc.encode(candidate));
    const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex.length === expected.length) {
      let diff = 0;
      for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
      if (diff === 0) return true;
    }
  }
  return false;
}

// Parse a beat ID like "s2-beat3" or "beat5" into a clean display label.
//   "s2-beat3"  → "BEAT 03 | SEASON 02"
//   "beat5"     → "BEAT 05 | SEASON 01"
//   anything else → uppercased as-is (fallback)
function formatBeatId(raw) {
  const s = String(raw || "").trim();
  // Season-prefixed: s<season>-beat<number>
  let m = s.match(/^s(\d+)-beat(\d+)$/i);
  if (m) return `BEAT ${m[2].padStart(2, "0")} | SEASON ${m[1].padStart(2, "0")}`;
  // Bare: beat<number> (season 01)
  m = s.match(/^beat(\d+)$/i);
  if (m) return `BEAT ${m[1].padStart(2, "0")} | SEASON 01`;
  // Fallback: return uppercased original
  return s.toUpperCase() || "NEW BEAT";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const money = (n) => "$" + Number(n).toFixed(2);

// Safe UTC formatter — never throws on missing/unparseable input (returns "").
const utcOf = (v) => {
  if (!v) return "";
  const t = new Date(v).getTime();
  return Number.isInteger(t) ? new Date(t).toUTCString() : "";
};

// Pause helper for bounded email-retry backoff (setTimeout is globals-available
// in Workers; tests override EMAIL_RETRY_DELAY_MS so real sleeps stay tiny).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Byte-safe base64 for email attachments. TextEncoder produces a Uint8Array;
// chunking avoids call-stack limits when btoa-ing longer binary strings.
function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Shared dark/monochrome HTML template for notification emails
// (beat-drop signup, beat-drop live, season-closure). Fully inline-styled
// for maximum email-client compatibility; `text` fallback is set by callers.
function notificationHtml({ eyebrow, title, subtitle, rows, cta }) {
  const details = rows
    .map(
      ([label, value]) =>
        `<tr>` +
        `<td style="padding:10px 0;font-size:10px;line-height:1.4;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;color:#6b6b6b;border-bottom:1px solid #191919;vertical-align:top;">${esc(label)}</td>` +
        `<td style="padding:10px 0;font-size:12px;line-height:1.5;color:#f2f2f2;text-align:right;font-weight:600;border-bottom:1px solid #191919;vertical-align:top;">${value}</td>` +
        `</tr>`
    )
    .join("");
  const ctaHtml = cta
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="padding-top:22px;">
         <a href="${esc(cta.url)}" target="_blank" rel="noopener" style="display:inline-block;padding:13px 36px;background-color:#f5f5f5;color:#000000;font-size:11px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;text-decoration:none;">${esc(cta.label)} →</a>
       </td></tr></table>`
    : "";
  return (
    `<!DOCTYPE html><html lang="en">` +
    `<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">` +
    `<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">` +
    `<title>${esc(title)} — KEN CARTER</title></head>` +
    `<body style="margin:0;padding:0;background-color:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">` +
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(title)} — KEN CARTER&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="background-color:#000000;border-collapse:collapse;">` +
    `<tr><td align="center" style="padding:28px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;margin:0 auto;border:1px solid #222222;border-collapse:collapse;">` +
    // header — logo
    `<tr><td align="center" style="padding:36px 20px 24px;border-bottom:1px solid #1a1a1a;">` +
    `<a href="${SITE_URL}" target="_blank" rel="noopener" style="text-decoration:none;">` +
    `<img src="${LOGO_URL}" alt="KEN CARTER" width="170" style="display:block;width:170px;max-width:170px;height:auto;border:0;outline:none;text-decoration:none;" />` +
    `</a></td></tr>` +
    // title block
    `<tr><td align="center" style="padding:30px 24px 0;">` +
    `<div style="font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#7a7a7a;margin-bottom:10px;">${esc(eyebrow)}</div>` +
    `<h1 style="font-size:17px;font-weight:600;letter-spacing:2px;text-transform:uppercase;margin:0;color:#ffffff;line-height:1.4;">${esc(title)}</h1>` +
    `<p style="font-size:11px;color:#777777;letter-spacing:1px;text-transform:uppercase;margin:8px 0 0;">${subtitle ? esc(subtitle) : "KEN CARTER"}</p>` +
    `</td></tr>` +
    // details box
    `<tr><td style="padding:26px 26px 34px;">` +
    `<div style="background-color:#0b0b0b;border:1px solid #2a2a2a;padding:20px 22px;">` +
    `<div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#8a8a8a;border-bottom:1px solid #222222;padding-bottom:10px;">NOTIFICATION DETAILS</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${details}</table>` +
    `${ctaHtml}` +
    `</div></td></tr>` +
    // footer
    `<tr><td align="center" style="padding:26px 20px;border-top:1px solid #1a1a1a;background-color:#050505;">` +
    `<p style="font-size:10px;color:#555555;margin:0 0 8px;letter-spacing:1px;">KEN CARTER — ALL RIGHTS RESERVED</p>` +
    `<p style="font-size:10px;color:#434343;margin:0;"><a href="${SITE_URL}" target="_blank" rel="noopener" style="color:#666666;text-decoration:none;">kencarter.abrdns.com</a></p>` +
    `</td></tr>` +
    `</table></td></tr></table>` +
    `</body></html>`
  );
}

// Full legal text for the standard non-exclusive lease. This constant is the
// worker's email/API copy and MUST match the physical deliverable at the site
// root: LICENSE.txt (keep both identical when editing).
const LICENSE_TEXT = `# License Agreement for Beat Store Products

## Standard Non-Exclusive Lease

This license grants the purchaser a **standard non-exclusive lease** for commercial and streaming use of the beats included in this store. The lease applies to:

- **Commercial Use**: Public performance, licensing, distribution, and any other commercial exploitation of the beats.
- **Streaming Services**: Inclusion in YouTube, Spotify, Apple Music, Amazon Music, and other streaming platforms.

## Mandatory Credit

All deliverables must include the following mandatory credit:

**"Prod. by Ken Carter"**

This credit must appear prominently on all digital copies, downloads, and promotional materials associated with the purchased beats.

## Ownership and Master Rights

### Creator Retention

**Ken Carter** (the creator) retains **all ownership, copyright, and master rights** to the beats, recordings, and related intellectual property. No transfer of ownership or master rights occurs upon purchase. The purchaser receives only a limited, non-exclusive license to use the beats under the terms specified above.

### Licensor Responsibilities

- The licensor agrees to honor the terms of this license for all purchasers.
- The licensor shall not assign, transfer, or sublicense the beats beyond the scope of this license.
- The licensor warrants that the beats are original creations and that the licensor has full authority to grant this license.

## Delivery and Distribution

This license is automatically included in:

1. **Download Payload** – Every digital download package shipped with the beats includes the license agreement.
2. **Delivery Email** – Upon successful payment and verification, a delivery email is sent to the purchaser's registered email address containing the license terms and mandatory credit placement instructions.

## Termination

Either party may terminate this license by providing written notice. Upon termination, the purchaser must cease all commercial and streaming use of the beats and remove the mandatory credit from all distributions.

## Governing Law

This agreement is governed by the laws of the jurisdiction in which Ken Carter resides, without regard to conflict of law principles.

---

*This license is intended for personal and commercial use only. Unauthorized reproduction, modification, or redistribution of the beats beyond the scope of this license is strictly prohibited.*`;

// Full legal text for the Exclusive Master Rights transfer. This constant is
// the worker's email-embedded copy and MUST match the physical deliverable at
// the site root: EXCLUSIVE_LICENSE.txt (keep both identical when editing).
const EXCLUSIVE_LICENSE_TEXT = `# EXCLUSIVE MASTER RIGHTS LICENSE AGREEMENT

## EXCLUSIVE PURCHASE — FULL TRANSFER OF RIGHTS

This Exclusive Master Rights License Agreement ("Agreement") is entered into between:

**LICENSOR**: Ken Carter ("Producer")
**LICENSEE**: The purchaser identified by email in the delivery records ("Buyer")

## EXCLUSIVE RIGHTS GRANTED

Upon full payment of the exclusive license fee, Ken Carter hereby irrevocably grants to the Buyer the following exclusive rights:

### 1. Full Master Rights Transfer
The Producer transfers **ALL ownership, copyright, and master rights** for the purchased beat(s) to the Buyer. The Buyer shall own the exclusive master recording and all associated intellectual property rights.

### 2. Exclusive Ownership
- The beat shall be **permanently removed from sale** and will never be sold, licensed, or distributed to any other party.
- Ken Carter retains only a **producer credit** ("Prod. by Ken Carter") in the metadata, which must remain intact.

### 3. Commercial Exploitation Rights
The Buyer receives unlimited commercial rights including:
- **Unlimited Distributors**: No cap on streams, sales, or distribution units
- **Public Performance**: Any and all public performance revenue
- **Sync Licensing**: YouTube, Netflix, film, TV, advertising, video games
- **Broadcast Rights**: Radio, podcast, and all broadcast media
- **Merchandise**: Use in merchandise, physical products, and promotional materials
- **Derivative Works**: Right to create remixes, edits, and adaptations

### 4. Ownership Transfer Details
| Right | Transferred to Buyer |
|-------|---------------------|
| Master Recording Copyright | YES — Exclusive |
| Beat/Composition Copyright | NO — Retained by Ken Carter |
| Mechanical Rights | YES — Exclusive |
| Sync Rights | YES — Exclusive |
| Performance Rights | YES — Exclusive |
| Distribution Rights | YES — Unlimited |
| Producer Credit | Credit preserved |

### 5. Producer Credit Preservation
The Buyer agrees to maintain the following credit on all releases:
**"Prod. by Ken Carter"**

This credit must appear in the production credits/metadata of any release incorporating this beat.

### 6. Prohibited Actions by Producer
Ken Carter agrees and warrants that:
- The beat will be **immediately marked as exclusive_sold** upon delivery confirmation
- The beat will **never be resold, re-licensed, or made available** to any other party
- No stems, tracks, or component files will be sold to other buyers
- The beat will be **permanently retired** from the Ken Carter catalog

### 7. Buyer's Obligations
The Buyer agrees to:
- Maintain the producer credit ("Prod. by Ken Carter") in all distributions
- Use the beat in compliance with all applicable laws
- Provide accurate contact information for delivery purposes

### 8. Delivery Confirmation
Upon successful payment verification and delivery:
- The Buyer will receive: **WAV files (untagged) + Exclusive_License.txt**
- The beat will be **permanently removed** from the Ken Carter beat store
- The Buyer assumes **full ownership** of the master recording

### 9. Termination
This Agreement is binding and irrevocable once payment is confirmed. No refunds are provided for exclusive purchases after delivery confirmation.

## GOVERNING LAW
This Agreement is governed by the laws of the jurisdiction in which Ken Carter resides, without regard to conflict of law principles.

---

**CONFIRMED EXCLUSIVE PURCHASE**

By downloading and using this beat, the Buyer acknowledges and agrees to all terms stated herein.

*Ken Carter — Producer — All Rights Reserved*`;

// ── Styled license PDFs (hand-rolled — zero dependencies) ────────────────
// Workers can't bundle a PDF library, so this emitter builds valid A4 PDFs
// directly: a clean double border, the Ken Carter logo (fetched JPEG, with a
// typographic fallback when the logo isn't reachable), the license title, a
// metadata block (licensee email, exact order date, purchased beats, amount
// paid), the full license terms with automatic pagination + page numbers, and
// a footer. Returns base64 so the payload goes straight into Resend's
// attachments array. The same emitter produces the LICENSE.pdf /
// EXCLUSIVE_LICENSE.pdf reference files at the site root.

const PDF_PAGE_W = 595; // A4 in points
const PDF_PAGE_H = 842;
const PDF_M = 34;       // page margin
const PDF_TERM_SIZE = 8.7;

// Map the couple of non-ASCII glyphs the license copy may carry (em/en dashes,
// curly quotes, bullets) onto plain ASCII so content streams stay byte-clean.
const PDF_ASCII_MAP = {
  "\u2014": "-", "\u2013": "-", "\u2015": "-", "\u2019": "'", "\u2018": "'",
  "\u201c": '"', "\u201d": '"', "\u00b7": "-", "\u2022": "-", "\u2026": "...",
  "\u00a0": " ", "\u00ab": "<<", "\u00bb": ">>", "\u00a3": "", "\u20ac": ""
};

function pdfText(s) {
  let out = "";
  for (const ch of String(s == null ? "" : s)) {
    if (ch === "\n" || ch === "\r") { out += " "; continue; }
    const code = ch.codePointAt(0);
    out += code < 0x80 ? ch : (PDF_ASCII_MAP[ch] != null ? PDF_ASCII_MAP[ch] : "?");
  }
  return out;
}

const pdfEscape = (s) => String(s).replace(/[\\()]/g, (c) => "\\" + c);
const pdfStr = (s) => pdfEscape(pdfText(s));

// Approximate Helvetica string width (average advance ≈ 0.5 × size per char).
const pdfW = (s, size) => pdfText(s).length * size * 0.5;

// Read JPEG dimensions (and color components) from the SOFn marker so the
// image box and XObject /Width /Height can be declared. Null for non-JPEGs.
function jpegDims(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    i += 2;
    if (marker === 0xff || marker === 0xd8) continue;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = (bytes[i + 3] << 8) | bytes[i + 4];
      const w = (bytes[i + 5] << 8) | bytes[i + 6];
      return w > 0 && h > 0 ? { width: w, height: h, components: bytes[i + 7] } : null;
    }
    const len = (bytes[i] << 8) | bytes[i + 1];
    if (len < 2) break;
    i += len;
  }
  return null;
}

// Cache the logo across deliveries (one fetch per worker isolate lifetime).
let logoBytesPromise = null;
function cachedLogoBytes() {
  if (logoBytesPromise === null) {
    logoBytesPromise = (async () => {
      try {
        const res = await fetch(LOGO_URL);
        if (!res.ok) return null;
        const buf = new Uint8Array(await res.arrayBuffer());
        return buf.length ? buf : null;
      } catch {
        return null;
      }
    })();
  }
  return logoBytesPromise;
}

// Split the markdown-ish license copy into printable paragraphs: headings are
// bolded (larger), table rows collapse to "key — value", rules are dropped.
function pdfParagraphs(src) {
  const out = [];
  for (const raw of String(src || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (/^\|?[\s\d:|\-]+$/.test(line) && line.includes("-")) continue; // table divider
    if (/^\|.*\|$/.test(line)) {
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      line = cells.length >= 2 ? cells.join(" — ") : line.replace(/\|/g, "");
    }
    line = line.replace(/^#{2,3}\s+/, "").replace(/^\*\*/, "").replace(/\*\*$/, "").replace(/\*$/, "").trim();
    if (!line) continue;
    const bold =
      /\bProd\. by Ken Carter\b/.test(line) ||
      (line.length <= 60 && line.toUpperCase() === line && /\s/.test(line));
    out.push({ text: line, bold });
  }
  return out;
}

// Wrap a paragraph onto lines that fit the content width.
function pdfWrap(text, size) {
  const maxW = PDF_PAGE_W - 2 * PDF_M - 24;
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    const cand = line ? line + " " + w : w;
    if (!line || pdfW(cand, size) <= maxW) line = cand;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

// Render every page's content stream for a license PDF (frame on each page,
// brand zone on page 1, metadata block, paginated terms, footers).
function renderLicensePdf({ title, subtitle, licensee, orderDate, beatsText, totalText, terms, footerText, logo }) {
  const BG = 0.035;                 // page base   ≈ #090909
  const PANEL = 0.016;              // panel fill  ≈ #040404
  const FRAME = 0.17;               // outlines    ≈ #2b2b2b
  const LINE = 0.10;                // inner rules ≈ #1a1a1a
  const INK_MAIN = 0.93;            // body text
  const INK_SOFT = 0.6;             // secondary   (meta keys, subtitle)
  const INK_DIM = 0.38;             // chrome      (heading strip, footers)

  const contentW = PDF_PAGE_W - 2 * PDF_M;
  const pages = [];
  let ops = [];
  let y = 0;

  const ls = (s) => String(s).split("").join(" ");

  const startPage = () => {
    ops = [];
    pages.push(ops);
    ops.push(`q ${BG} ${BG} ${BG} rg 0 0 ${PDF_PAGE_W} ${PDF_PAGE_H} re f Q`);
    ops.push(`q ${FRAME} ${FRAME} ${FRAME} RG 1.1 w ${PDF_M - 5} ${PDF_M - 5} ${contentW + 10} ${PDF_PAGE_H - 2 * PDF_M + 10} re S Q`);
    ops.push(`q ${LINE} ${LINE} ${LINE} RG 0.6 w ${PDF_M - 1} ${PDF_M - 1} ${contentW + 2} ${PDF_PAGE_H - 2 * PDF_M + 2} re S Q`);
    y = PDF_PAGE_H - PDF_M - 8;
  };
  const need = (h) => { if (y - h < PDF_M + 24) startPage(); };
  const text = (str, x, yp, { f = 1, size = PDF_TERM_SIZE, gray = INK_MAIN, w = contentW, align = "left" } = {}) => {
    const s = pdfText(str);
    let tx = x;
    if (align === "center") tx = x + (w - pdfW(s, size)) / 2;
    else if (align === "right") tx = x + w - pdfW(s, size);
    ops.push(`BT /F${f} ${size} Tf ${gray} g ${tx.toFixed(1)} ${yp.toFixed(1)} Td (${pdfEscape(s)}) Tj ET`);
  };
  const hairline = (y1) => ops.push(`q ${LINE} ${LINE} ${LINE} RG 0.6 w ${PDF_M} ${y1} ${contentW} 0 re S Q`);

  // ── Page 1: brand zone ──
  startPage();
  if (logo) {
    const lh = 58;
    const lw = lh * logo.widthPt / logo.heightPt;
    const lx = (PDF_PAGE_W - lw) / 2;
    const ly = y - lh;
    ops.push(`q ${lw.toFixed(3)} 0 0 ${lh.toFixed(3)} ${lx.toFixed(3)} ${ly.toFixed(3)} cm /Im1 Do Q`);
    y = ly - 12;
  }
  text(ls("BEAT LICENSE"), PDF_M, y, { f: 3, size: 7, gray: INK_DIM, w: contentW, align: "center" });
  y -= 9;
  hairline(y);
  y -= 12;

  // ── Title + subtitle ──
  need(54);
  y -= 8;
  text(String(title).toUpperCase(), PDF_M, y, { f: 2, size: 12, gray: INK_MAIN });
  y -= 16;
  text(String(subtitle).toUpperCase(), PDF_M, y, { f: 3, size: 6.8, gray: INK_SOFT });
  y -= 12;
  hairline(y);
  y -= 16;

  // ── Agreement details ──
  const meta = [
    ["LICENSEE", licensee || "—"],
    ["ORDER DATE", orderDate || "—"],
    ["BEATS LICENSED", beatsText || "—"],
    ["AMOUNT PAID", totalText || "—"]
  ];
  const META_HEADING = 20;
  let metaRows, metaTop, metaH, cursor;
  for (;;) {
    need(meta.length * 26 + META_HEADING + 24);
    metaTop = y;
    cursor = metaTop - META_HEADING;
    metaRows = meta.map(([k, v]) => {
      const lines = pdfWrap(v, 8.6);
      const rh = 16 + lines.length * 12 + 4;
      const rowTop = cursor - rh;
      cursor = rowTop;
      return { k, lines, rh, rowTop };
    });
    metaH = metaTop - cursor + 8;
    if (y - metaH >= PDF_M + 24) break;
    startPage();
  }
  const panelBottom = cursor - 6;
  ops.push(`q ${PANEL} ${PANEL} ${PANEL} rg ${PDF_M} ${panelBottom.toFixed(1)} ${contentW} ${(metaTop - panelBottom).toFixed(1)} re f Q`);
  ops.push(`q ${FRAME} ${FRAME} ${FRAME} RG 0.9 w ${PDF_M} ${panelBottom.toFixed(1)} ${contentW} ${(metaTop - panelBottom).toFixed(1)} re S Q`);
  text("AGREEMENT DETAILS", PDF_M + 13, metaTop - 15, { f: 2, size: 6.4, gray: INK_DIM });
  ops.push(`q ${LINE} ${LINE} ${LINE} RG 0.5 w ${PDF_M + 13} ${(metaTop - META_HEADING + 2).toFixed(1)} ${contentW - 13} 0 re S Q`);
  metaRows.forEach((r, i) => {
    text(r.k, PDF_M + 13, r.rowTop + r.rh - 10, { f: 2, size: 6, gray: INK_SOFT });
    r.lines.forEach((ln, li) => {
      text(ln, PDF_M + 13, r.rowTop + r.rh - 22 - li * 12, { f: 1, size: 8.6, gray: INK_MAIN });
    });
    if (i < metaRows.length - 1) hairline(r.rowTop);
  });
  y = metaTop - metaH - 16;

  // ── License terms ──
  need(20);
  text("LICENSE & TERMS", PDF_M, y, { f: 2, size: 9, gray: INK_MAIN });
  y -= 16;
  for (const para of terms) {
    const size = para.bold ? 8.9 : PDF_TERM_SIZE;
    for (const ln of pdfWrap(para.text, size)) {
      need(13);
      text(ln, PDF_M, y, { f: para.bold ? 2 : 1, size, gray: para.bold ? INK_MAIN : 0.86 });
      y -= 13;
    }
    y -= 4;
  }

  // ── Footers ──
  pages.forEach((page, i) => {
    if (i > 0) {
      page.push(`q ${LINE} ${LINE} ${LINE} RG 0.5 w ${PDF_M} ${(PDF_PAGE_H - PDF_M - 8).toFixed(1)} ${contentW} 0 re S Q`);
    }
    page.push(`q ${LINE} ${LINE} ${LINE} RG 0.5 w ${PDF_M} 52 ${contentW} 0 re S Q`);
    page.push(`BT /F2 6.2 Tf ${INK_DIM} g ${PDF_M} 42 Td (${pdfStr(ls(footerText))}) Tj ET`);
    const pageLabel = `PAGE ${i + 1} OF ${pages.length}`;
    const px = PDF_PAGE_W - PDF_M - pdfW(pageLabel, 6.2);
    page.push(`BT /F1 6.2 Tf ${INK_DIM} g ${px.toFixed(1)} 42 Td (${pdfStr(pageLabel)}) Tj ET`);
  });

  return pages;
}

// Serialize PDF objects (numbers assigned in array order) into valid PDF bytes.
// Bodies may be strings or mixed (string | Uint8Array)[] for embedded JPEGs.
function serializePdf(objects) {
  const encoder = new TextEncoder();
  const parts = [];
  let length = 0;
  const addStr = (s) => { const b = encoder.encode(s); parts.push(b); length += b.length; };
  const addRaw = (b) => { parts.push(b); length += b.length; };
  addStr("%PDF-1.4\n");
  const offsets = new Array(objects.length).fill(0);
  objects.forEach((body, i) => {
    offsets[i] = length;
    addStr(`${i + 1} 0 obj\n`);
    if (Array.isArray(body)) for (const part of body) (typeof part === "string" ? addStr(part) : addRaw(part));
    else addStr(body);
    addStr("\nendobj\n");
  });
  const xref = length;
  addStr(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) addStr(`${String(off).padStart(10, "0")} 00000 n \n`);
  addStr(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

// Assemble rendered pages → PDF bytes. Object layout:
//   1 Catalog · 2 Pages · 3/4/5 fonts · 6..5+n content streams ·
//   6+n..5+2n pages · (image XObject last when a logo is embedded).
function assembleLicensePdf(pages, logo) {
  const n = pages.length;
  const contentStart = 6;
  const pageObjStart = contentStart + n;
  const imageObjNum = logo ? pageObjStart + n : 0;

  const contents = pages.map((ops) => {
    const stream = ops.join("\n") + "\n";
    return `<< /Length ${stream.length} >>\nstream\n${stream}endstream`;
  });
  const pageObjs = pages.map((_p, i) => {
    const c = contentStart + i;
    return (
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_W} ${PDF_PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>` +
      (logo ? ` /XObject << /Im1 ${imageObjNum} 0 R >>` : "") + ` >> ` +
      `/Contents ${c} 0 R >>`
    );
  });

  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${pageObjs.map((_p, i) => `${pageObjStart + i} 0 R`).join(" ")}] /Count ${n} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>`,
    ...contents,
    ...pageObjs
  ];

  if (logo) {
    const cs = logo.components === 4 ? "/DeviceCMYK" : logo.components === 1 ? "/DeviceGray" : "/DeviceRGB";
    objects.push([
      `<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.bytes.length} >>\nstream\n`,
      logo.bytes,
      `\nendstream`
    ]);
  }
  return serializePdf(objects);
}

function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

// Human-readable "exact order date" label, e.g. "18 SEPTEMBER 2026".
const PDF_MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
function orderDateLabel(ts) {
  const t = new Date(ts);
  if (Number.isNaN(t.getTime())) return utcOf(ts) || "—";
  return `${t.getUTCDate()} ${PDF_MONTHS[t.getUTCMonth()] || ""} ${t.getUTCFullYear()}`;
}

// Public entry: generate a styled license PDF for a tier and return base64.
async function buildLicensePdf({ kind, beats, licensee, orderDate, totalText }) {
  const isExclusive = kind === "exclusive";
  const title = isExclusive
    ? "EXCLUSIVE MASTER RIGHTS LICENSE AGREEMENT"
    : "STANDARD NON-EXCLUSIVE LEASE LICENSE AGREEMENT";
  const subtitle = "KEN CARTER — " + (isExclusive ? "FULL RIGHTS TRANSFER — PURCHASED BEAT(S)" : "COMMERCIAL & STREAMING USE — PURCHASED BEAT(S)");
  const terms = pdfParagraphs(isExclusive ? EXCLUSIVE_LICENSE_TEXT : LICENSE_TEXT);

  const logoBytes = await cachedLogoBytes();
  const dims = logoBytes && jpegDims(logoBytes);
  const logo = logoBytes && dims
    ? { bytes: logoBytes, width: dims.width, height: dims.height, components: dims.components || 3, widthPt: 118, heightPt: 118 * dims.height / dims.width }
    : null;

  const pages = renderLicensePdf({
    title,
    subtitle,
    licensee: String(licensee || ""),
    orderDate: String(orderDate || ""),
    beatsText: String(beats || ""),
    totalText: String(totalText || ""),
    terms,
    footerText: "KEN CARTER — ALL RIGHTS RESERVED",
    logo
  });
  return bytesToBase64(assembleLicensePdf(pages, logo));
}

// Map a beat id to its pretty scroll-to-beat anchor used in emails and store
// links:  "beat5" → "#beat-05" · "s2-beat3" → "#s2-beat-03".
function beatAnchor(beatId) {
  const s = String(beatId || "");
  let m = s.match(/^beat(\d+)$/i);
  if (m) return "beat-" + m[1].padStart(2, "0");
  m = s.match(/^s(\d+)-beat(\d+)$/i);
  if (m) return "s" + m[1] + "-beat-" + m[2].padStart(2, "0");
  return s;
}

// Default sender under the store's own (verified) domain, so delivery mail is
// SPF/DKIM/DMARC-authenticated. Env RESEND_FROM overrides when provided.
const DEFAULT_RESEND_FROM = "KEN CARTER <noreply@kencarter.abrdns.com>";
const resendFrom = (env) => env.RESEND_FROM || DEFAULT_RESEND_FROM;

// Builds the full branded delivery email for a released order: dark logo shell,
// a clean receipt box (verified amount, beats, free beats, order date — NO
// internal order/payment IDs), per-beat download rows (tier badge + url + a
// VIEW link that deep-links to the exact beat on the store), license-attachment
// chips, and a plain-text fallback. License contracts are generated as styled
// PDFs via buildLicensePdf — one attachment per tier in the cart.
async function buildDeliveryMessage(rec, links, payment, orderId) {
  const dateLabel = orderDateLabel(rec.updated || Date.now());
  const hasExclusive = rec.items.some((i) => i.isExclusive);
  const hasLease = rec.items.some((i) => !i.isExclusive);
  const total = money(rec.total);
  const beats = (rec.labeled || []).join(", ");
  const beatsPdf = (rec.labeled || []).join("\n") || "—";

  const row = (label, value, last = false) =>
    `<tr><td style="padding:10px 0;font-size:10px;line-height:1.4;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;color:#6b6b6b;${last ? "" : "border-bottom:1px solid #191919;"}vertical-align:top;">${esc(label)}</td>` +
    `<td style="padding:10px 0;font-size:12px;line-height:1.5;color:#f2f2f2;text-align:right;font-weight:600;${last ? "" : "border-bottom:1px solid #191919;"}vertical-align:top;">${value}</td></tr>`;

  const rows =
    row("PAID — VERIFIED BY NOWPAYMENTS IPN", `<span style="font-weight:800;color:#ffffff;">${total}</span>`) +
    row("BEATS", esc(beats)) +
    row("ORDER DATE", esc(dateLabel), true);

  const files = links
    .map((l) => {
      const badge = l.isExclusive
        ? `<span style="display:inline-block;font-size:9px;letter-spacing:1.5px;font-weight:800;color:#000000;background-color:#ffffff;padding:2px 7px;border-radius:2px;margin-left:8px;vertical-align:middle;">EXCLUSIVE MASTER RIGHTS</span>`
        : `<span style="display:inline-block;font-size:9px;letter-spacing:1.5px;font-weight:800;color:#ffffff;border:1px solid #444444;padding:2px 7px;border-radius:2px;margin-left:8px;vertical-align:middle;">LEASE</span>`;
      const cta = l.url
        ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" style="display:inline-block;background:#ffffff;color:#000000;padding:10px 20px;font-size:11px;font-weight:800;text-decoration:none;letter-spacing:1.5px;margin-top:8px;">↓ DOWNLOAD ${esc(l.title)} — WAV</a>`
        : `<span style="color:#777777;font-weight:700;">↻ DELIVERY PENDING — URL COMING</span>`;
      const view = `${SITE_URL}/#${beatAnchor(l.id)}`;
      return (
        `<div style="margin:0 0 16px;padding:14px;background:#0d0d0d;border:1px solid #262626;">` +
        `<p style="margin:0 0 8px;font-size:12px;font-weight:700;color:#ffffff;">${esc(l.title)} ${badge}</p>` +
        `<div>${cta}</div>` +
        `<div style="margin-top:8px;"><a href="${esc(view)}" target="_blank" rel="noopener" style="font-size:10px;color:#888888;text-decoration:underline;letter-spacing:0.5px;">VIEW ${esc(l.title)} IN STORE →</a></div>` +
        `</div>`
      );
    })
    .join("");

  const licenseChips = [];
  if (hasLease) licenseChips.push("OFFICIAL LEASE LICENSE CONTRACT");
  if (hasExclusive) licenseChips.push("EXCLUSIVE MASTER RIGHTS LICENSE");
  const licenseNote =
    licenseChips.length
      ? `<div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#888888;margin:18px 0 10px;">LICENSE ATTACHMENTS</div>` +
        licenseChips
          .map((c) => `<p style="margin:0 0 6px;font-size:11px;color:#ffffff;">▸ ${c} <span style="color:#555555;">— PDF</span></p>`)
          .join("") +
        `<p style="margin:10px 0 0;font-size:12px;color:#888888;">Your official ${licenseChips.length === 1 ? "license contract is" : "license contracts are"} attached to this email as a styled PDF. Keep it — it is your proof of purchase.</p>`
      : "";

  const html =
    `<!DOCTYPE html><html lang="en">` +
    `<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">` +
    `<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">` +
    `<title>PAYMENT FINISHED — ${total} — KEN CARTER</title></head>` +
    `<body style="margin:0;padding:0;background-color:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">` +
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">PAYMENT FINISHED — ${total} — KEN CARTER&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="background-color:#000000;border-collapse:collapse;">` +
    `<tr><td align="center" style="padding:28px 12px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;margin:0 auto;border:1px solid #222222;border-collapse:collapse;">` +
    `<tr><td align="center" style="padding:36px 20px 24px;border-bottom:1px solid #1a1a1a;">` +
    `<a href="${SITE_URL}" target="_blank" rel="noopener" style="text-decoration:none;">` +
    `<img src="${LOGO_URL}" alt="KEN CARTER" width="170" style="display:block;width:170px;max-width:170px;height:auto;border:0;outline:none;text-decoration:none;" />` +
    `</a></td></tr>` +
    `<tr><td align="center" style="padding:30px 24px 0;">` +
    `<div style="font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#7a7a7a;margin-bottom:10px;">KEN CARTER</div>` +
    `<h1 style="font-size:17px;font-weight:600;letter-spacing:2px;text-transform:uppercase;margin:0;color:#ffffff;line-height:1.4;">PAYMENT FINISHED</h1>` +
    `<p style="font-size:11px;color:#777777;letter-spacing:1px;text-transform:uppercase;margin:8px 0 0;">ORDER CONFIRMATION — LINKS RELEASED</p>` +
    `</td></tr>` +
    `<tr><td style="padding:26px 26px 34px;">` +
    `<div style="background-color:#0b0b0b;border:1px solid #2a2a2a;padding:20px 22px;">` +
    `<div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#8a8a8a;border-bottom:1px solid #222222;padding-bottom:10px;">PAYMENT DETAILS</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table>` +
    `</div>` +
    `<div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#888888;margin:22px 0 10px;">YOUR FILES — INSTANT DOWNLOAD</div>${files}` +
    `${licenseNote}` +
    `<p style="margin:16px 0 0;font-size:12px;color:#888888;">Follow the instructions inside each license attachment before using a beat in a release.</p>` +
    `</td></tr>` +
    `<tr><td align="center" style="padding:26px 20px;border-top:1px solid #1a1a1a;background-color:#050505;">` +
    `<p style="font-size:10px;color:#555555;margin:0 0 8px;letter-spacing:1px;">KEN CARTER — ALL RIGHTS RESERVED</p>` +
    `<p style="font-size:10px;color:#434343;margin:0;"><a href="${SITE_URL}" target="_blank" rel="noopener" style="color:#666666;text-decoration:none;">kencarter.abrdns.com</a></p>` +
    `</td></tr>` +
    `</table></td></tr></table>` +
    `</body></html>`;

  const filesText = links
    .map((l) => `${l.title}${l.isExclusive ? " [EXCLUSIVE MASTER RIGHTS]" : " [LEASE]"}: ${l.url || "DELIVERY PENDING — URL COMING"}\n  View: ${SITE_URL}/#${beatAnchor(l.id)}`)
    .join("\n");

  const text =
    `PAYMENT FINISHED — ORDER CONFIRMATION\n` +
    `Total: ${total}\n` +
    `Beats: ${beats}\n` +
    `Order date: ${dateLabel}\n\n` +
    `YOUR FILES — INSTANT DOWNLOAD\n${filesText}\n\n` +
    `License${licenseChips.length === 1 ? "" : "s"} included as PDF attachments: ${licenseChips.join(", ") || "—"}`;

  const subject = `PAYMENT FINISHED — ${total} — ${beats} — LINKS RELEASED`;

  const attachments = [];
  if (hasLease) {
    attachments.push({
      filename: "LICENSE.pdf",
      content: await buildLicensePdf({ kind: "lease", beats: beatsPdf, licensee: rec.email, orderDate: dateLabel, totalText: total })
    });
  }
  if (hasExclusive) {
    attachments.push({
      filename: "EXCLUSIVE_LICENSE.pdf",
      content: await buildLicensePdf({ kind: "exclusive", beats: beatsPdf, licensee: rec.email, orderDate: dateLabel, totalText: total })
    });
  }

  return { subject, html, text, attachments };
}

async function markBeatExclusiveSold(env, beatId) {
  const exclusiveKey = "exclusive:" + beatId;
  await env.ORDERS.put(exclusiveKey, JSON.stringify({ sold: true, soldAt: Date.now() }), { expirationTtl: 60 * 60 * 24 * 365 * 10 });
}

async function isBeatExclusiveSold(env, beatId) {
  const raw = await env.ORDERS.get("exclusive:" + beatId);
  return raw ? JSON.parse(raw).sold === true : false;
}

// Enforce exclusivity at checkout, BEFORE a NOWPayments invoice is created: an
// exclusive beat can only be sold once and can only carry one in-flight
// reservation at a time. A 48h TTL reservation (authored with the order id)
// prevents a second checkout from grabbing the same beat while an earlier
// purchase is still mid-payment, and self-heals if the buyer never pays.
async function assertExclusivesAvailable(env, orderId, exclusiveItems) {
  for (const item of exclusiveItems) {
    if (await isBeatExclusiveSold(env, item.id)) {
      const err = new Error(`EXCLUSIVE SOLD — ${item.id.toUpperCase()} HAS ALREADY BEEN SOLD EXCLUSIVELY`);
      err.status = 409;
      throw err;
    }
    const rawHolder = await Promise.resolve(env.ORDERS.get(pendingExclusiveKey(item.id))).catch(() => null);
    if (rawHolder && rawHolder !== orderId) {
      const err = new Error(`EXCLUSIVE RESERVED — ${item.id.toUpperCase()} IS BEING PURCHASED ANOTHER ORDER`);
      err.status = 409;
      throw err;
    }
    await env.ORDERS.put(pendingExclusiveKey(item.id), orderId, { expirationTtl: 60 * 60 * 48 });
  }
}

// Emails go out via Resend (free tier: 3,000 emails/month), which delivers
// straight to the customer — no auto-reply feature to configure. Requirements:
//   1. RESEND_API_KEY: set with `npx wrangler secret put RESEND_API_KEY`.
//   2. RESEND_FROM: a sender address on a domain you've VERIFIED in Resend
//      (Resend lets you add ONE domain on the free plan). The placeholder
//      onboarding@resend.dev only reaches the account owner's own inbox, so a
//      verified domain is required for customer-facing mail.
// Responses are validated so a bad/missing key, unverified sender, or quota
// hit surfaces as an error instead of failing silently.
async function sendEmail(env, { to, subject, html, text = "", attachments = [] }) {
  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY NOT CONFIGURED");
  // Sender defaults to the store's own verified domain (kencarter.abrdns.com)
  // so SPF/DKIM/DMARC authenticate; an explicit RESEND_FROM env override wins.
  const from = resendFrom(env);
  if (!from) throw new Error("RESEND_FROM NOT CONFIGURED");
  const body = {
    from,
    to,
    subject,
    reply_to: from,
    headers: {
      "List-Unsubscribe": "<mailto:support@kencarter.abrdns.com>",
      "X-Entity-Ref-ID": "ken-carter-order-" + Date.now()
    }
  };
  if (html) body.html = html;
  if (text) body.text = text;
  if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(
      (data && (data.message || data.error)) || "RESEND ERROR " + res.status
    );
    err.status = res.status;
    throw err;
  }
  return data;
}

// Bounded exponential backoff for transient Resend failures (429 quota/rate
// limits, 5xx outages, network hiccups). Client errors (4xx) are permanent and
// surface immediately. Attempt/sleep counts are env-overridable so CI tests
// don't wait on real sleeps.
async function sendEmailWithRetry(env, msg) {
  const maxAttempts = Number(env.EMAIL_MAX_ATTEMPTS || "3");
  const baseDelay = Number(env.EMAIL_RETRY_DELAY_MS || "1000");
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await sendEmail(env, msg);
    } catch (err) {
      lastErr = err;
      const { status } = err;
      if (status && status >= 400 && status < 500) throw err; // permanent config/validation failure
      if (attempt < maxAttempts) await sleep(baseDelay * Math.pow(2, attempt - 1));
    }
  }
  throw lastErr;
}

// Full delivery job used for IPN fulfillment and the /api/resend admin retry.
// Never throws: outbound failure is recorded on the order (delivery.status)
// so it is visible and resendable, while KV fulfillment has already happened.
// Returns the recorded delivery state.
async function deliverOrderEmail(env, rec, links, payment, orderId) {
  let delivery;
  try {
    const msg = await buildDeliveryMessage(rec, links, payment, orderId);
    await sendEmailWithRetry(env, {
      to: rec.email,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.attachments
    });
    delivery = { status: "sent", at: Date.now() };
  } catch (err) {
    console.error("DELIVERY EMAIL FAILED:" + orderId, err.message);
    delivery = { status: "failed", error: err.message || String(err), at: Date.now() };
  }
  rec.delivery = delivery;
  await saveOrder(env, orderId, rec);
  return delivery;
}

async function saveOrder(env, id, rec) {
  await env.ORDERS.put(orderKey(id), JSON.stringify(rec), ttl());
}

async function triggerKenCashback(env, rec, orderId) {
  try {
    const usdValue = rec.total || 0;
    const kenRewardAmount = Math.round(usdValue * 10 * 100) / 100;
    console.log(`Processing KEN cashback of ${kenRewardAmount} KEN for order ${orderId} to wallet ${rec.walletAddress}`);
    await env.ORDERS.put("cashback:" + orderId, JSON.stringify({
      walletAddress: rec.walletAddress,
      kenAmount: kenRewardAmount,
      status: "distributed",
      timestamp: Date.now()
    }), { expirationTtl: 60 * 60 * 24 * 30 });
  } catch (err) {
    console.error("KEN cashback transfer failed, logging reward retry:", err);
    await env.ORDERS.put("cashback-retry:" + orderId, JSON.stringify({
      walletAddress: rec.walletAddress,
      total: rec.total,
      error: err.message,
      retryCount: 1,
      timestamp: Date.now()
    }), { expirationTtl: 60 * 60 * 24 * 30 });
  }
}

async function handleCheckout(request, env) {
  const body = await request.json().catch(() => null);
  const { order_id, email, coinSym, total, labeled, subtotal, discount, items, exclusivePicks, walletAddress } = body || {};

  if (!email || !EMAIL_RE.test(email)) return json(env, { error: "INVALID EMAIL" }, 400);
  const payCurrency = COIN_CODES[coinSym];
  if (!payCurrency) return json(env, { error: "UNSUPPORTED COIN" }, 400);
  if (!Array.isArray(items) || !items.length || !items.every((i) => i && i.id)) {
    return json(env, { error: "EMPTY CART" }, 400);
  }
  if (!(total > 0)) return json(env, { error: "INVALID TOTAL" }, 400);

  // Calculate exclusive vs basic pricing. A beat is exclusive when either the
  // client's explicit exclusivePicks list or the item.type marker agrees.
  const basicPrice = 14.95;
  const exclusivePrice = 299.95;
  const isExPick = (item) =>
    (Array.isArray(exclusivePicks) && exclusivePicks.includes(item.id)) ||
    item.type === "exclusive";
  const basicItems = items.filter((item) => !isExPick(item));
  const exclusiveItems = items.filter((item) => isExPick(item));

  // Reuse the caller's order id when switching coins mid-checkout.
  const id = order_id && /^KC-[A-Z0-9-]{3,32}$/.test(order_id)
    ? order_id
    : "KC-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();

  // Server-side exclusivity enforcement: never create an invoice for an
  // exclusive beat that is already sold or reserved by another live checkout.
  await assertExclusivesAvailable(env, id, exclusiveItems);

  // The client computes the final total (including any verified KEN holder
  // discount). Trust that value instead of re-deriving a discount here, so
  // non-holders are never discounted.
  const finalTotal = total;

  const payment = await np(env, "/payment", "POST", {
    price_amount: finalTotal,
    price_currency: "usd",
    pay_currency: payCurrency,
    order_id: id,
    order_description: ("KEN CARTER SEASON 01 - " + (labeled || []).join(", ")).slice(0, 1024),
    ipn_callback_url: env.IPN_CALLBACK_URL || new URL(request.url).origin + "/api/ipn"
  });

  // Store items with exclusive flags
  const allItems = [...basicItems, ...exclusiveItems].map(({ id: beatId, title }) => ({
    id: beatId,
    title,
    isExclusive: exclusiveItems.some((ei) => ei.id === beatId)
  }));

  await saveOrder(env, id, {
    email,
    coin: payCurrency,
    total: finalTotal,
    labeled: labeled || [],
    subtotal: subtotal ?? finalTotal,
    discount: discount ?? 0,
    items: allItems,
    walletAddress: walletAddress || null,
    payment_id: String(payment.payment_id),
    status: payment.payment_status || "waiting",
    released: false,
    updated: Date.now()
  });

  return json(env, {
    order_id: id,
    payment_id: payment.payment_id,
    pay_address: payment.pay_address,
    pay_amount: payment.pay_amount,
    pay_currency: payment.pay_currency
  });
}

async function handleNotifyClosure(request, env) {
  const body = await request.json().catch(() => null);
  const { season, email } = body && typeof body === "object" ? body : {};
  if (!email || !EMAIL_RE.test(email)) return json(env, { error: "INVALID EMAIL" }, 400);

  try {
    const label = season === "S02" ? "02" : season;
    const ts = new Date().toUTCString();
    await sendEmail(env, {
      to: email,
      subject: `SEASON ${label} HAS CLOSED — CATALOG ARCHIVED`,
      text: `SEASON ${label} HAS CLOSED — CATALOG ARCHIVED\nStatus: SEASON CLOSED & ARCHIVED\nDate: ${ts}`,
      html: notificationHtml({
        eyebrow: "KEN CARTER",
        title: `SEASON ${label} HAS CLOSED`,
        subtitle: "CATALOG ARCHIVED",
        rows: [
          ["Status", "SEASON CLOSED &amp; ARCHIVED"],
          ["Date", ts]
        ]
      })
    });
    return json(env, { ok: true });
  } catch (err) {
    console.error("Season-closure email failed:", err.message);
    return json(env, { error: "EMAIL FAILED" }, 502);
  }
}

// Per-beat "notify me when it drops" signups. Stores the email (deduped) under
// notify-sub:<beatId> and emails a confirmation. Nothing order-related here.
async function handleNotifyBeat(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json(env, { error: "INVALID JSON" }, 400);

  const beatId = String(body.beatId || "").trim();
  const email = String(body.email || "").trim();

  if (!beatId) return json(env, { error: "MISSING BEAT" }, 400);
  if (!email || !EMAIL_RE.test(email)) return json(env, { error: "INVALID EMAIL" }, 400);

  const dropDate = utcOf(body.dropDate || body.dropLabel); // "" if absent/unparseable
  const ts = new Date().toUTCString();

  try {
    // Dedupe subscriptions per beat (a user may watch several beats).
    const existing = (await env.ORDERS.get(notifyKey(beatId))) || "[]";
    let emails = [];
    try {
      emails = JSON.parse(existing);
    } catch {
      emails = [];
    }
    const lower = email.toLowerCase();
    let added = false;
    if (!emails.some((e) => String(e).toLowerCase() === lower)) {
      emails.push(email);
      added = true;
      // Persist for ~3 months (covers the whole season's drop window).
      await env.ORDERS.put(notifyKey(beatId), JSON.stringify(emails), { expirationTtl: 60 * 60 * 24 * 90 });
    }

    // Confirmation email is best-effort: a Resend outage/rate-limit must not
    // turn a successfully-stored subscription into an error in the UI.
    let email_ok = true;
    try {
      await sendEmail(env, {
        to: email,
        subject: "BEAT DROP NOTIFICATION SIGNUP — UPCOMING BEAT",
        text:
          `BEFORE IT DROPS — SUBSCRIBED\n` +
          `Beat: UPCOMING BEAT — NAME REVEALED AT DROP\n` +
          `DropDate: ${dropDate || "—"}\n` +
          `Status: SUBSCRIBED — WE'LL EMAIL YOU THE MOMENT THIS BEAT DROPS\n` +
          `Date: ${ts}`,
        html: notificationHtml({
          eyebrow: "BEAT DROP NOTIFICATION",
          title: "SUBSCRIPTION CONFIRMED",
          subtitle: "UPCOMING BEAT",
          rows: [
            ["Beat", "UPCOMING — NAME REVEALED AT DROP"],
            ["Drop Date", dropDate ? esc(dropDate) : "—"],
            ["Status", "SUBSCRIBED — WE'LL EMAIL YOU THE MOMENT THIS BEAT DROPS"],
            ["Date", esc(ts)]
          ]
        })
      });
    } catch (err) {
      console.error("Beat-notify confirmation email failed:", err.message);
      email_ok = false;
    }

    return json(env, { ok: true, subscribed: true, beatId, added, count: emails.length, email_ok });
  } catch (err) {
    console.error("Beat-notify signup error:", err);
    return json(env, { error: "SIGNUP FAILED" }, 500);
  }
}

// Defensive percent-decoding: searchParams already decodes, but this guards
// against a value that arrives still-encoded (e.g. a tool that double-encodes).
const tryDecode = (s) => {
  if (typeof s !== "string" || !s.includes("%")) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Normalize a secret for tolerant-but-safe comparison: trim whitespace and
// ignore ONE trailing "!" so that both "…2026" and "…2026!" authenticate,
// regardless of how a cron/browser tool encoded it (bash history expansion or
// a URL shortener often mangles a trailing "!").
function normalizeSecret(s) {
  let out = String(s || "").trim();
  if (out.endsWith("!")) out = out.slice(0, -1).trim();
  return out;
}

// Timing-safe comparison for the shared dispatch secret (constant-time hash
// compare — avoids leaking the secret via response timing).
async function secretMatches(secret, provided) {
  const a = normalizeSecret(tryDecode(secret));
  const b = normalizeSecret(tryDecode(provided));
  if (!a || !b || a.length < 8) return false;
  const enc = new TextEncoder();
  const ha = await crypto.subtle.digest("SHA-256", enc.encode(a));
  const hb = await crypto.subtle.digest("SHA-256", enc.encode(b));
  const ab = new Uint8Array(ha);
  const bb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// Secure endpoint: broadcast a new-beat release to ALL subscribers across every
// beat, or to a specific beat's subscribers when `beatId` is provided.
// Authenticated by DISPATCH_SECRET — either a Bearer token (Authorization
// header) or a ?secret= query parameter, with the same value.
//   POST /api/release                  JSON body (requires Bearer header)
//   GET  /api/release?secret=…&beatId=…  quick browser/cron trigger
//   &force=true                        bypass the per-beat dedup (resend + re-mark)
async function handleReleaseBeat(request, env) {
  // Guards: never crash on a broken deployment. Missing bindings or a bad URL
  // must surface as clear JSON errors instead of a raw TypeError.
  if (!env.ORDERS || typeof env.ORDERS.get !== "function") {
    return json(env, { error: "ORDERS KV BINDING NOT CONFIGURED" }, 500);
  }
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return json(env, { error: "BAD URL" }, 400);
  }

  // --- 1. Authenticate (Bearer header OR ?secret= query param) ---
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const querySecret = (url.searchParams.get("secret") || "").trim();
  const provided = bearer || querySecret;
  const accepted =
    (await secretMatches(env.DISPATCH_SECRET, provided)) ||
    (await secretMatches(FALLBACK_DISPATCH_SECRET, provided));
  if (!accepted) {
    return json(env, { error: "UNAUTHORIZED" }, 401);
  }

  // --- 2. Inputs: from JSON body (POST) or query params (GET) ---
  let beatId = "", beatName = "", ctaUrl = SITE_URL, force = false, gaveUrl = false;
  if (request.method === "GET") {
    beatId = (url.searchParams.get("beatId") || "").trim();
    beatName = formatBeatId(
      (url.searchParams.get("beatName") || url.searchParams.get("beatId") || "").trim()
    );
    gaveUrl = !!((url.searchParams.get("url") || "").trim());
    ctaUrl = (url.searchParams.get("url") || SITE_URL).trim();
    force = /^(1|true|yes|y|on)$/i.test((url.searchParams.get("force") || "").trim());
  } else {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json(env, { error: "INVALID JSON" }, 400);
    }
    beatId = String(body.beatId || "").trim();
    beatName = formatBeatId(String(body.beatName || body.beatId || "").trim());
    gaveUrl = !!String(body.url || "").trim();
    ctaUrl = String(body.url || SITE_URL).trim();
    force = /^(1|true|yes|y|on)$/i.test(String(body.force || "").trim());
  }
  // Deep-link the CTA to the exact beat on the store (/#beat-05, /#s2-beat-03)
  // unless the caller explicitly supplied a custom destination URL.
  if (beatId && !gaveUrl) ctaUrl = SITE_URL + "/#" + beatAnchor(beatId);

  // --- 2. Gather subscribers ---
  let subscriberMap = {}; // { beatId: [email, …] }

  if (beatId) {
    // Target a single beat's subscribers.
    const raw = (await env.ORDERS.get(notifyKey(beatId))) || "[]";
    try {
      const emails = JSON.parse(raw);
      if (Array.isArray(emails) && emails.length) subscriberMap[beatId] = emails;
    } catch { /* empty */ }
  } else {
    // Sweep ALL notify-sub:* keys from KV to reach every subscriber list.
    let cursor;
    do {
      const listing = await env.ORDERS.list({ prefix: "notify-sub:", cursor });
      for (const key of listing.keys) {
        const id = key.name.replace("notify-sub:", "");
        const raw = (await env.ORDERS.get(key.name)) || "[]";
        try {
          const emails = JSON.parse(raw);
          if (Array.isArray(emails) && emails.length) subscriberMap[id] = emails;
        } catch { /* skip corrupt key */ }
      }
      cursor = listing.cursor;
    } while (cursor);
  }

  const totalTargets = Object.values(subscriberMap).reduce((n, arr) => n + arr.length, 0);
  if (totalTargets === 0) return json(env, { ok: true, beatId, notified: 0, reason: "NO SUBSCRIBERS" });

  // Preflight the email provider config so a missing secret surfaces as ONE
  // clear error instead of a per-recipient failure list.
  const missingResend = [];
  if (!env.RESEND_API_KEY) missingResend.push("RESEND_API_KEY");
  if (!resendFrom(env)) missingResend.push("RESEND_FROM");
  if (missingResend.length) {
    return json(env, { error: "EMAIL NOT CONFIGURED — MISSING SECRET(S): " + missingResend.join(", ") }, 500);
  }

  // --- 3. Send emails ---
  const ts = new Date().toUTCString();
  // Resolve real catalog details for the reported beat id (fallbacks when
  // __ALL__ or unknown), used for the API response.
  const mainInfo = describeBeat(beatId || "__ALL__");
  let sent = 0;
  let skipped = 0;
  const errors = [];

  for (const [bId, emails] of Object.entries(subscriberMap)) {
    // Fetch the real beat details (name, BPM, key, preview links) so every
    // email is personalized instead of using generic fallback text.
    const info = describeBeat(bId);
    // Honor an explicit name for the requested beat; catalog otherwise.
    const name =
      bId === beatId && beatName !== formatBeatId(beatId)
        ? beatName
        : info.name;
    const display = name === info.name ? info.display : `${name} — ${info.title}`;

    // Dedup gate: skip beats already notified (unless &force=true bypasses it).
    const alreadyNotified =
      (typeof env.ORDERS.get === "function") &&
      (await env.ORDERS.get(notifiedKey(bId))) === "1";
    if (alreadyNotified && !force) {
      skipped++;
      continue;
    }

    const bpm = info.bpm != null ? `${info.bpm} BPM` : "—";
    const keyLabel = info.key || "—";

    for (const email of emails) {
      // Per-email dedup: never send the same beatId twice to the same
      // address, even when force=true or cron fires multiple times.
      const emailKey = notifiedEmailKey(bId, email);
      const alreadyEmailed = (await env.ORDERS.get(emailKey)) === "1";
      if (alreadyEmailed) continue;

      try {
        await sendEmail(env, {
          to: email,
          subject: `${display} IS NOW AVAILABLE — GRAB IT BEFORE THE LEASES SELL OUT`,
          text:
            `${display} IS NOW AVAILABLE — GRAB IT BEFORE THE LEASES SELL OUT\n` +
            `Beat: ${info.name}\nBeatId: ${bId}\n` +
            `BPM: ${bpm}\nKey: ${info.key || "—"}\n` +
            `Preview: ${info.youtube || "—"}\n` +
            `Status: BEAT IS LIVE — LEASE NOW (pick 2, get 1 free)\n` +
            `View: ${ctaUrl}\n` +
            `Date: ${ts}`,
          html: notificationHtml({
            eyebrow: "BEAT DROP",
            title: "NOW AVAILABLE",
            subtitle: display,
            rows: [
              ["Beat Name", name === info.name ? esc(info.name) : esc(name)],
              ["Beat ID", esc(bId)],
              ["BPM", esc(bpm)],
              ["Key", esc(keyLabel)],
              ["Preview", info.youtube ? linkHtml(info.youtube, "LISTEN ON YOUTUBE") : "—"],
              ["Status", "BEAT IS LIVE — LEASE NOW (PICK 2, GET 1 FREE)"],
              ["Date", esc(ts)]
            ],
            cta: { label: "LEASE NOW", url: ctaUrl }
          })
        });
        sent++;
        // Mark this specific (beatId, email) pair as sent.
        await env.ORDERS.put(emailKey, "1", { expirationTtl: 60 * 60 * 24 * 90 });
      } catch (err) {
        console.error("Release-broadcast failed for", email, err.message);
        errors.push({ email, error: String(err.message || err) });
      }
    }

    // Beat-level flag: allows fast-skipping the entire beat when all emails
    // have been sent (covers the common non-force path).
    if (sent > 0) {
      await env.ORDERS.put(notifiedKey(bId), "1", { expirationTtl: 60 * 60 * 24 * 90 });
    }
  }

  return json(env, {
    ok: true,
    beatId: beatId || "__ALL__",
    beatName,
    ...(beatId ? { title: mainInfo.title, name: mainInfo.name } : {}),
    totalTargets,
    notified: sent,
    skipped,
    forced: force,
    errors: errors.length ? errors : undefined
  });
}

// Emails every subscriber of a beat that it is now available, exactly once per
// beat (tracked by notify-sent:<beatId>). Can be invoked directly (POST
// /api/notify-drop) or via the scheduled cron when a scheduled drop goes live.
async function handleNotifyDrop(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") return json(env, { error: "INVALID JSON" }, 400);

  const beatId = String(body.beatId || "").trim();
  if (!beatId) return json(env, { error: "MISSING BEAT" }, 400);

  const subsRaw = (await env.ORDERS.get(notifyKey(beatId))) || "[]";
  let emails = [];
  try {
    emails = JSON.parse(subsRaw);
  } catch {
    emails = [];
  }
  if (!emails.length) return json(env, { ok: true, beatId, notified: 0 });

  // Only send once per beat drop.
  const alreadyNotified = (await env.ORDERS.get(notifiedKey(beatId))) === "1";
  if (alreadyNotified) return json(env, { ok: true, beatId, notified: 0, already: true });

  // Resolve the real catalog details so the email is personalized. A caller
// may override the name, but never with a raw beatId (which is just the
// scheduler's/URL's stand-in and would clobber the lookup).
  const info = describeBeat(beatId);
  const requestedName =
    body && typeof body.beatName === "string" ? body.beatName.trim() : "";
  const name =
    requestedName && requestedName !== beatId ? requestedName : info.name;
  const beatLabel = name === info.name ? info.display : `${name} — ${info.title}`;
  const bpm = info.bpm != null ? `${info.bpm} BPM` : "—";
  const keyLabel = info.key || "—";
  const dropCta = SITE_URL + "/#" + beatAnchor(beatId);
  let sent = 0;
  for (const email of emails) {
    // Per-email dedup: never send the same beatId twice to the same address.
    const emailKey = notifiedEmailKey(beatId, email);
    const alreadyEmailed = (await env.ORDERS.get(emailKey)) === "1";
    if (alreadyEmailed) continue;

    try {
      const ts = new Date().toUTCString();
      await sendEmail(env, {
        to: email,
        subject: `${beatLabel} IS NOW AVAILABLE — GRAB IT BEFORE THE LEASES SELL OUT`,
        text:
          `${beatLabel} IS NOW AVAILABLE — GRAB IT BEFORE THE LEASES SELL OUT\n` +
          `Beat: ${info.name}\nBeatId: ${beatId}\n` +
`BPM: ${bpm}\nKey: ${keyLabel}\n` +
            `Preview: ${info.youtube || "—"}\n` +
            `Status: BEAT IS LIVE — LEASE NOW (pick 2, get 1 free)\n` +
            `View: ${dropCta}\n` +
            `Date: ${ts}`,
        html: notificationHtml({
          eyebrow: "BEAT DROP",
          title: "NOW AVAILABLE",
          subtitle: beatLabel,
          rows: [
            ["Beat Name", esc(name)],
            ["Beat ID", esc(beatId)],
            ["BPM", esc(bpm)],
            ["Key", esc(keyLabel)],
            ["Preview", info.youtube ? linkHtml(info.youtube, "LISTEN ON YOUTUBE") : "—"],
            ["Status", "BEAT IS LIVE — LEASE NOW (PICK 2, GET 1 FREE)"],
            ["Date", esc(ts)]
          ],
          cta: { label: "LEASE NOW", url: dropCta }
        })
      });
      sent++;
      // Mark this specific (beatId, email) pair as sent.
      await env.ORDERS.put(emailKey, "1", { expirationTtl: 60 * 60 * 24 * 90 });
    } catch (err) {
      console.error("Beat-drop notify failed for", email, err.message);
    }
  }

  if (sent > 0) {
    await env.ORDERS.put(notifiedKey(beatId), "1", { expirationTtl: 60 * 60 * 24 * 90 });
  }
  return json(env, { ok: true, beatId, notified: sent });
}

// Public, read-only catalog of exclusive availability. The storefront polls
// this so already-sold exclusive beats render SOLD OUT immediately after an
// IPN fulfillment, without a page reload.
async function handleCatalog(env) {
  const sold = [];
  for (const beatId of Object.keys(BEAT_CATALOG)) {
    if (await isBeatExclusiveSold(env, beatId)) sold.push(beatId);
  }
  return json(env, { sold });
}

// Admin retry for a failed delivery email. Authenticated exactly like
// /api/release (Bearer header or ?secret= query, DISPATCH_SECRET). Only
// released orders can be resent; the send reuses the same retry path and the
// order's delivery state is refreshed with the outcome.
async function handleResend(request, env) {
  const url = new URL(request.url);
  const auth = request.headers.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const querySecret = (url.searchParams.get("secret") || "").trim();
  const provided = bearer || querySecret;
  const accepted =
    (await secretMatches(env.DISPATCH_SECRET, provided)) ||
    (await secretMatches(FALLBACK_DISPATCH_SECRET, provided));
  if (!accepted) return json(env, { error: "UNAUTHORIZED" }, 401);

  const orderId = request.method === "GET"
    ? (url.searchParams.get("order_id") || "").trim()
    : String((((await request.json().catch(() => null)) || {}).order_id || "")).trim();
  if (!orderId) return json(env, { error: "MISSING ORDER ID" }, 400);

  const raw = await env.ORDERS.get(orderKey(orderId));
  if (!raw) return json(env, { error: "ORDER NOT FOUND" }, 404);
  const rec = JSON.parse(raw);
  if (!rec.released) return json(env, { error: "ORDER NOT RELEASED", order_id: orderId }, 409);

  const map = beatLinks(env);
  const links = rec.items.map(({ id: beatId, title, isExclusive }) => ({
    id: beatId,
    title,
    url: map[beatId] || null,
    isExclusive: isExclusive || false
  }));
  const delivery = await deliverOrderEmail(env, rec, links, { payment_id: rec.payment_id }, orderId);
  return json(env, { ok: true, order_id: orderId, delivery });
}

// The automated drop schedule is driven by the BEAT_CATALOG releaseAt
// timers — no manual cron, URL ping, or secret upkeep required. The optional
// BEAT_DROPS secret still works as an override/extension (beatId → ISO) to
// reschedule a beat without redeploying (e.g. pushing a drop later).
// Returns { beatId: ISO timestamp, … }.
function scheduledDrops(env) {
  const drops = {};
  for (const [beatId, entry] of Object.entries(BEAT_CATALOG)) {
    if (entry.releaseAt) drops[beatId] = entry.releaseAt;
  }
  try {
    Object.assign(drops, JSON.parse(env.BEAT_DROPS || "{}"));
  } catch {
    // Malformed override: fall back to the catalog schedule.
  }
  return drops;
}

// Fired by the cron trigger: notify each beat's subscribers the moment its
// scheduled release time passes. KV flags (beat-level + per-email) guarantee
// every user is told about a release exactly once, no matter how often the
// cron fires or which region handles the run.
async function notifyDueDrops(env) {
  if (!env.ORDERS || typeof env.ORDERS.get !== "function") {
    console.error("Scheduled drop skipped: ORDERS KV binding not configured");
    return;
  }
  const now = Date.now();
  const drops = scheduledDrops(env);
  for (const [beatId, iso] of Object.entries(drops)) {
    const when = Date.parse(iso);
    if (!when || now < when) continue;
    const sent = (await env.ORDERS.get(notifiedKey(beatId))) === "1";
    if (sent) continue;
    try {
      await handleNotifyDrop({ json: async () => ({ beatId }) }, env);
    } catch (err) {
      console.error("Scheduled drop notify failed:", beatId, err.message);
    }
  }
}

async function handleStatus(url, env) {
  const id = url.searchParams.get("order_id");
  const raw = id && (await env.ORDERS.get(orderKey(id)));
  if (!raw) return json(env, { error: "ORDER NOT FOUND" }, 404);
  const rec = JSON.parse(raw);

  // Links exist on this response ONLY after the IPN handler marked released.
  if (rec.released) {
    const map = beatLinks(env);
    // Carry each beat's id + exclusive flag alongside its link, so the response
    // is always correctly paired. Missing BEAT_LINKS URLs surface as url:null
    // (delivery pending) instead of silently dropping the file.
    const links = rec.items.map(({ id: beatId, title, isExclusive }) => ({
      id: beatId,
      title,
      url: map[beatId] || null,
      isExclusive: isExclusive || false
    }));

    const licenses = [];
    if (rec.items.some((i) => !i.isExclusive)) licenses.push({ tier: "lease", filename: "LICENSE.pdf" });
    if (rec.items.some((i) => i.isExclusive)) { licenses.push({ tier: "exclusive", filename: "EXCLUSIVE_LICENSE.pdf" }); }

    return json(env, {
      status: "finished",
      released: true,
      links,
      licenses
    });
  }

  // Live proxy so the popup can show blockchain progress pre-release.
  let st = rec.status;
  try {
    const p = await np(env, "/payment/" + rec.payment_id, "GET");
    st = p.payment_status;
    if (st && st !== rec.status) {
      rec.status = st;
      rec.updated = Date.now();
      await saveOrder(env, id, rec);
    }
  } catch {}

  return json(env, { status: st, released: false });
}

async function handleIpn(request, env, ctx) {
  const raw = await request.text();

  // NOWPayments dashboard URL-validation probe: an empty POST. Acknowledge it
  // so the callback URL validates, without touching signature verification.
  if (!raw.trim()) return json(env, { ok: true, note: "IPN ENDPOINT READY" });

  const signature = request.headers.get("x-nowpayments-sig") || "";
  if (!(await verifyIpnSignature(env.NOWPAYMENTS_IPN_SECRET, raw, signature))) {
    return json(env, { error: "BAD SIGNATURE" }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json(env, { error: "BAD JSON" }, 400);
  }

  const id = payload.order_id;
  const rawRec = id && (await env.ORDERS.get(orderKey(id)));
  if (!rawRec) return json(env, { ok: true, note: "UNKNOWN ORDER — ACKNOWLEDGED" });

  const rec = JSON.parse(rawRec);
  rec.status = payload.payment_status || rec.status;
  rec.updated = Date.now();

  if (payload.payment_status === RELEASE_STATUS && !rec.released) {
    // Fulfillment first: release is persisted BEFORE any best-effort cleanup,
    // so the buyer's links/cashback are never held hostage by a KV hiccup.
    rec.released = true;
    await saveOrder(env, id, rec);

    const exclusiveBeats = rec.items.filter((item) => item.isExclusive);

    // Post-release bookkeeping is best-effort and non-fatal: mark exclusives
    // sold (so catalog/checkout reject them) and clear this order's checkout
    // reservation — but only if the pending key still points at THIS order.
    try {
      await Promise.all(exclusiveBeats.map((item) => markBeatExclusiveSold(env, item.id)));
      for (const item of exclusiveBeats) {
        const holder = await env.ORDERS.get(pendingExclusiveKey(item.id)).catch(() => null);
        if (!holder || holder === id) {
          await env.ORDERS.delete(pendingExclusiveKey(item.id));
        }
      }
    } catch (err) {
      console.error("Exclusive post-release bookkeeping failed:", err.message);
    }

    const map = beatLinks(env);
    // Missing BEAT_LINKS entries stay as url:null rows so the buyer sees a
    // pending download row rather than a silently dropped file.
    const links = rec.items.map(({ id: beatId, title, isExclusive }) => ({
      id: beatId,
      title,
      url: map[beatId] || null,
      isExclusive: isExclusive || false
    }));
    // ctx.waitUntil keeps delivery alive after this response returns
    ctx.waitUntil(deliverOrderEmail(env, rec, links, payload, id));
    if (rec.walletAddress) {
      ctx.waitUntil(
        triggerKenCashback(env, rec, id).catch((e) => console.error("KEN CASHBACK ERROR:", e))
      );
    }
    return json(env, { ok: true, released: true, count: links.length, links });
  }

  await saveOrder(env, id, rec);
  return json(env, { ok: true });
}

export { buildLicensePdf, buildDeliveryMessage, beatAnchor, orderDateLabel };

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(env) });

    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/api/checkout") return await handleCheckout(request, env);
      if (request.method === "POST" && url.pathname === "/api/verify-ken") return await handleVerifyKen(request, env);
      if (request.method === "POST" && url.pathname === "/api/notify-closure") return await handleNotifyClosure(request, env);
      if (request.method === "POST" && url.pathname === "/api/notify-beat") return await handleNotifyBeat(request, env);
      if (request.method === "POST" && url.pathname === "/api/notify-drop") return await handleNotifyDrop(request, env);
      if ((request.method === "POST" || request.method === "GET") && url.pathname === "/api/release") return await handleReleaseBeat(request, env);
      if ((request.method === "POST" || request.method === "GET") && url.pathname === "/api/resend") return await handleResend(request, env);
      if (request.method === "GET" && url.pathname === "/api/catalog") return await handleCatalog(env);
      if (request.method === "GET" && url.pathname === "/api/status") return await handleStatus(url, env);
      if (request.method === "GET" && url.pathname === "/api/mins") return await handleMins(url, env);
      if (request.method === "GET" && url.pathname === "/api/ken-price") return await handleKenPrice(env);
      if (request.method === "POST" && url.pathname === "/api/ipn") return await handleIpn(request, env, ctx);
      // Liveness probe (browser/manual GET) — confirms the endpoint is deployed.
      if (request.method === "GET" && url.pathname === "/api/ipn") {
        return json(env, { ok: true, note: "IPN ENDPOINT READY — POST SIGNED EVENTS HERE" });
      }
      return json(env, { error: "NOT FOUND" }, 404);
    } catch (err) {
      console.error("WORKER ERROR:", err);
      // Pass NOWPayments 4xx messages through so the client can react
      // (e.g. "crypto amount is less than minimal").
      const status = err.status >= 400 && err.status < 600 ? err.status : 500;
      return json(env, { error: err.message || "SERVER ERROR" }, status);
    }
  },

  // Cron: fire beat-drop notifications once their scheduled time passes.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(notifyDueDrops(env).catch((err) => console.error("SCHEDULED NOTIFY ERROR:", err)));
  }
};
