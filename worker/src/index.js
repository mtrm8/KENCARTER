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
- The Buyer will receive: **WAV/MP3 files (untagged) + Exclusive_License.txt**
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

// Builds the full branded delivery email for a released order: dark logo shell,
// payment-details box, per-beat download rows (tier badge + url), license
// attachment chips, and a plain-text fallback. Returns everything sendEmail
// needs — subject/html/text plus base64 attachments for every license tier in
// the cart (lease + exclusive), so real license .txt files ride along with the
// email instead of being inlined as unstyled <pre> blocks.
function buildDeliveryMessage(rec, links, payment, orderId) {
  const ts = new Date().toUTCString();
  const pid = String(payment.payment_id || "");
  const hasExclusive = rec.items.some((i) => i.isExclusive);
  const hasLease = rec.items.some((i) => !i.isExclusive);
  const total = money(rec.total);
  const beats = (rec.labeled || []).join(", ");
  const free = rec.freeTitles && rec.freeTitles.length ? rec.freeTitles.join(", ") : "—";

  const row = (label, value, last = false) =>
    `<tr><td style="padding:10px 0;font-size:10px;line-height:1.4;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;color:#6b6b6b;${last ? "" : "border-bottom:1px solid #191919;"}vertical-align:top;">${esc(label)}</td>` +
    `<td style="padding:10px 0;font-size:12px;line-height:1.5;color:#f2f2f2;text-align:right;font-weight:600;${last ? "" : "border-bottom:1px solid #191919;"}vertical-align:top;">${value}</td></tr>`;

  const rows =
    row("ORDER ID", esc(orderId)) +
    row("PAYMENT ID", esc(pid)) +
    row("PAID — VERIFIED BY NOWPAYMENTS IPN", `<span style="font-weight:800;color:#ffffff;">${total}</span>`) +
    row("BEATS", esc(beats)) +
    row("FREE BEATS", esc(free)) +
    row("DATE", esc(ts), true);

  const files = links
    .map((l) => {
      const badge = l.isExclusive
        ? `<span style="display:inline-block;font-size:9px;letter-spacing:1.5px;font-weight:800;color:#000000;background-color:#f5f5f5;padding:2px 7px;border-radius:2px;margin-left:8px;vertical-align:middle;">EXCLUSIVE MASTER RIGHTS</span>`
        : `<span style="display:inline-block;font-size:9px;letter-spacing:1.5px;font-weight:800;color:#8a8a8a;border:1px solid #2a2a2a;padding:2px 7px;border-radius:2px;margin-left:8px;vertical-align:middle;">LEASE</span>`;
      const cta = l.url
        ? `<a href="${esc(l.url)}" target="_blank" rel="noopener" style="color:#ffffff;font-weight:700;text-decoration:underline;">→ DOWNLOAD</a>`
        : `<span style="color:#777777;font-weight:700;">↻ DELIVERY PENDING — URL COMING</span>`;
      return (
        `<p style="margin:0 0 10px;font-size:12px;color:#ffffff;">${esc(l.title)} ${badge}<br/>` +
        `<span style="font-size:11px;color:#888888;">${cta}</span></p>`
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
          .map((c) => `<p style="margin:0 0 6px;font-size:11px;color:#ffffff;">▸ ${c}</p>`)
          .join("") +
        `<p style="margin:10px 0 0;font-size:12px;color:#888888;">Your official ${licenseChips.length === 1 ? "license contract is" : "license contracts are"} attached to this email. Keep it — it is your proof of purchase.</p>`
      : "";

  const html =
    `<!DOCTYPE html><html lang="en">` +
    `<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">` +
    `<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">` +
    `<title>PAYMENT FINISHED — ${total} — KEN CARTER</title></head>` +
    `<body style="margin:0;padding:0;background-color:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#ffffff;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">` +
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">PAYMENT FINISHED — ${total} — KEN CARTER&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>` +
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
    .map((l) => `${l.title}${l.isExclusive ? " [EXCLUSIVE MASTER RIGHTS]" : " [LEASE]"}: ${l.url || "DELIVERY PENDING — URL COMING"}`)
    .join("\n");

  const text =
    `PAYMENT FINISHED — ORDER CONFIRMATION\n` +
    `Order ID: ${orderId}\n` +
    `Payment ID: ${pid}\n` +
    `Total: ${total}\n` +
    `Beats: ${beats}\n` +
    `Free: ${free}\n` +
    `Date: ${ts}\n\n` +
    `YOUR FILES — INSTANT DOWNLOAD\n${filesText}\n\n` +
    `License${licenseChips.length === 1 ? "" : "s"} included as attachments: ${licenseChips.join(", ") || "—"}`;

  const subject = `PAYMENT FINISHED — ${total} — ${beats} — LINKS RELEASED`;

  const attachments = [];
  if (hasLease) attachments.push({ filename: "LICENSE.txt", content: base64Encode(LICENSE_TEXT) });
  if (hasExclusive) attachments.push({ filename: "EXCLUSIVE_LICENSE.txt", content: base64Encode(EXCLUSIVE_LICENSE_TEXT) });

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
  const from = env.RESEND_FROM;
  if (!from) throw new Error("RESEND_FROM NOT CONFIGURED");
  const body = { from, to, subject, reply_to: to };
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
    const msg = buildDeliveryMessage(rec, links, payment, orderId);
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
  const { order_id, email, coinSym, total, labeled, freeTitles, subtotal, discount, items, exclusivePicks, walletAddress } = body || {};

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
    freeTitles: freeTitles || [],
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
  let beatId = "", beatName = "", ctaUrl = SITE_URL, force = false;
  if (request.method === "GET") {
    beatId = (url.searchParams.get("beatId") || "").trim();
    beatName = formatBeatId(
      (url.searchParams.get("beatName") || url.searchParams.get("beatId") || "").trim()
    );
    ctaUrl = (url.searchParams.get("url") || SITE_URL).trim();
    force = /^(1|true|yes|y|on)$/i.test((url.searchParams.get("force") || "").trim());
  } else {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json(env, { error: "INVALID JSON" }, 400);
    }
    beatId = String(body.beatId || "").trim();
    beatName = formatBeatId(String(body.beatName || body.beatId || "").trim());
    ctaUrl = String(body.url || SITE_URL).trim();
    force = /^(1|true|yes|y|on)$/i.test(String(body.force || "").trim());
  }

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
  if (!env.RESEND_FROM) missingResend.push("RESEND_FROM");
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
          cta: { label: "LEASE NOW", url: SITE_URL }
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
    if (rec.items.some((i) => !i.isExclusive)) licenses.push({ tier: "lease", filename: "LICENSE.txt" });
    if (rec.items.some((i) => i.isExclusive)) { licenses.push({ tier: "exclusive", filename: "EXCLUSIVE_LICENSE.txt" }); }

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
