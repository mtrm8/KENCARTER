/**
 * KEN CARTER — checkout enforcement Worker
 * ────────────────────────────────────────────────────────────────────────
 * All NOWPayments traffic + download-link custody lives HERE, never in the
 * site's public JavaScript.
 *
 * Settlement: Solana network (SOL & SPL tokens, e.g. USDC / USDT on Solana)
 *   Merchant wallet: 2P2m2u46hg7a7eK6YSjtogSv4QnExEdfsjAKkGz719aX
 *   Payments route through NOWPayments to ensure proper conversion
 *   and on-chain verification before files are released.
 *
 * Routes
 *   POST /api/checkout            create a NOWPayments payment for a cart
 *   GET  /api/status?order_id=…   live payment status (+ links ONLY if released)
 *   POST /api/ipn                 NOWPayments webhook — HMAC-SHA512 verified;
 *                                 releases links + emails them on 'finished'
 *
 * Secrets (wrangler secret put …):
 *   NOWPAYMENTS_API_KEY     payments API key
 *   NOWPAYMENTS_IPN_SECRET  IPN signing secret (dashboard → IPN settings)
 *   STATICFORMS_API_KEY     form backend used to email delivery
 *   BEAT_LINKS              JSON: { "beat1": "https://drive…", … }
 *
 * Bindings: KV namespace "ORDERS" (see wrangler.toml).
 */

const NP_API = "https://api.nowpayments.io/v1";
const STATICFORMS_ENDPOINT = "https://api.staticforms.dev/submit";

const KEN_MINT = "HEFkC6WQo3jTv39B6JhYQJ3ZW8xKxRELaWdnirdSpump";
const MERCHANT_SOL_ADDRESS = "2P2m2u46hg7a7eK6YSjtogSv4QnExEdfsjAKkGz719aX";

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

function beatLinks(env) {
  try {
    return JSON.parse(env.BEAT_LINKS || "{}");
  } catch {
    return {};
  }
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function artistNameFromEmail(email) {
  const tokens = (email.split("@")[0] || "")
    .split(/[^a-zA-Z]+/)
    .filter((t) => /[a-zA-Z]/.test(t))
    .slice(0, 3);
  return tokens.map((t) => t.toUpperCase()).join(" ").slice(0, 28) || "ARTIST";
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const money = (n) => "$" + Number(n).toFixed(2);

function deliveryHtml(rec, links) {
  const rows =
    `<tr><td style="padding:7px 0;font-size:11px;color:#888888;">ITEMS</td>` +
    `<td align="right" style="padding:7px 0;font-size:12px;color:#ffffff;">${rec.items.length} × LIMITED LEASE</td></tr>` +
    `<tr><td style="padding:7px 0;font-size:11px;color:#888888;">BEATS</td>` +
    `<td align="right" style="padding:7px 0;font-size:12px;color:#ffffff;">${esc(rec.labeled.join(", "))}</td></tr>` +
    `<tr><td style="padding:7px 0;font-size:11px;color:#888888;">FREE BEATS</td>` +
    `<td align="right" style="padding:7px 0;font-size:12px;color:#ffffff;">${rec.freeTitles.length ? esc(rec.freeTitles.join(", ")) : "—"}</td></tr>` +
    `<tr><td style="padding:7px 0;font-size:11px;color:#888888;">TOTAL PAID</td>` +
    `<td align="right" style="padding:14px 0 7px;font-size:15px;font-weight:800;color:#ffffff;">${money(rec.total)}</td></tr>`;
  const files = links
    .map(
      (l) =>
        `<p style="margin:0 0 10px;"><a href="${esc(l.url)}" target="_blank" rel="noopener" style="color:#ffffff;font-weight:700;text-decoration:underline;">${esc(l.title)} → DOWNLOAD</a></p>`
    )
    .join("");
  return (
    `<table width="100%" style="border-collapse:collapse;">${rows}</table>` +
    `<div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#888888;margin:18px 0 10px;">YOUR FILES — INSTANT DOWNLOAD</div>${files}` +
    `<p style="margin:14px 0 0;font-size:12px;color:#888888;">Your official lease license contract accompanies this email.</p>`
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

function licenseHtml() {
  const isExclusive = arguments[0]?.isExclusive || false;
  const text = isExclusive ? EXCLUSIVE_LICENSE_TEXT : LICENSE_TEXT;
  const label = isExclusive ? "EXCLUSIVE MASTER RIGHTS LICENSE — FULL TRANSFER" : "OFFICIAL LEASE LICENSE CONTRACT";
  return (
    `<div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#888888;margin:18px 0 10px;">${label}</div>` +
    `<pre style="white-space:pre-wrap;font-size:11px;color:#ffffff;line-height:1.5;margin:0 0 14px;">${text}</pre>`
  );
}

function exclusiveLicenseHtml() {
  return (
    `<div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#888888;margin:18px 0 10px;">EXCLUSIVE MASTER RIGHTS LICENSE — FULL TRANSFER</div>` +
    `<pre style="white-space:pre-wrap;font-size:11px;color:#ffffff;line-height:1.5;margin:0 0 14px;">${EXCLUSIVE_LICENSE_TEXT}</pre>`
  );
}

async function markBeatExclusiveSold(env, beatId) {
  const exclusiveKey = "exclusive:" + beatId;
  await env.ORDERS.put(exclusiveKey, JSON.stringify({ sold: true, soldAt: Date.now() }), { expirationTtl: 60 * 60 * 24 * 365 * 10 });
}

async function isBeatExclusiveSold(env, beatId) {
  const raw = await env.ORDERS.get("exclusive:" + beatId);
  return raw ? JSON.parse(raw).sold === true : false;
}

async function sendDeliveryEmail(env, rec, links, payment, isExclusive = false) {
  const payload = {
    apiKey: env.STATICFORMS_API_KEY,
    email: rec.email,
    message: `PAYMENT FINISHED — ${money(rec.total)} — ${(rec.labeled || []).join(", ")} — LINKS RELEASED`,
    Beats: (rec.labeled || []).join(", "),
    Free: rec.freeTitles && rec.freeTitles.length ? rec.freeTitles.join(", ") : "—",
    PaymentStatus: "PAID — VERIFIED BY NOWPAYMENTS IPN (finished)",
    NPPaymentId: String(payment.payment_id || ""),
    Total: money(rec.total),
    ArtistName: artistNameFromEmail(rec.email),
    PaymentDetailsHtml: deliveryHtml(rec, links) + (isExclusive ? exclusiveLicenseHtml() : licenseHtml(isExclusive)),
    LicenseText: isExclusive ? EXCLUSIVE_LICENSE_TEXT : LICENSE_TEXT,
    Date: new Date().toUTCString()
  };
  await fetch(STATICFORMS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload)
  });
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

  let finalTotal = total;
  if (coinSym === "KEN") {
    finalTotal = Math.max(0, total * 0.85);
  }

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
  const { season, email } = body || {};
  if (!email || !EMAIL_RE.test(email)) return json(env, { error: "INVALID EMAIL" }, 400);

  const payload = {
    apiKey: env.STATICFORMS_API_KEY,
    email,
    message: `SEASON ${season === "S02" ? "02" : season} HAS CLOSED — CATALOG ARCHIVED`,
    Season: season,
    Status: "SEASON CLOSED & ARCHIVED",
    Date: new Date().toUTCString()
  };
  await fetch(STATICFORMS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload)
  });
  return json(env, { ok: true });
}

async function handleStatus(url, env) {
  const id = url.searchParams.get("order_id");
  const raw = id && (await env.ORDERS.get(orderKey(id)));
  if (!raw) return json(env, { error: "ORDER NOT FOUND" }, 404);
  const rec = JSON.parse(raw);

  // Links exist on this response ONLY after the IPN handler marked released.
  if (rec.released) {
    const map = beatLinks(env);
    // Carry each beat's exclusive flag alongside its link so the response is
    // always correctly paired even when a beat has no configured URL.
    const enrichedLinks = rec.items
      .map(({ id: beatId, title, isExclusive }) => {
        const url = map[beatId];
        return url ? { title, url, isExclusive: isExclusive || false } : null;
      })
      .filter(Boolean);

    const license = enrichedLinks.some((l) => l.isExclusive)
      ? EXCLUSIVE_LICENSE_TEXT
      : LICENSE_TEXT;

    return json(env, {
      status: "finished",
      released: true,
      links: enrichedLinks,
      license
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
    rec.released = true;
    await saveOrder(env, id, rec);

    // Mark exclusive beats as sold in KV
    const exclusiveBeats = rec.items.filter((item) => item.isExclusive);
    const exclusivePromises = exclusiveBeats.map((item) => markBeatExclusiveSold(env, item.id));
    await Promise.all(exclusivePromises);

    const map = beatLinks(env);
    const links = rec.items.map(({ id: beatId, title, isExclusive }) => ({ title, url: map[beatId], isExclusive })).filter((l) => l.url);
    // ctx.waitUntil keeps delivery alive after this response returns
    ctx.waitUntil(
      sendDeliveryEmail(env, rec, links, payload, exclusiveBeats.length > 0).catch((e) => console.error("DELIVERY EMAIL FAILED:", e))
    );
    if (rec.walletAddress) {
      ctx.waitUntil(
        triggerKenCashback(env, rec, id).catch((e) => console.error("KEN CASHBACK ERROR:", e))
      );
    }
    return json(env, { ok: true, released: true, count: links.length });
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
  }
};
