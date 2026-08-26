/**
 * KEN CARTER — checkout enforcement Worker
 * ────────────────────────────────────────────────────────────────────────
 * All NOWPayments traffic + download-link custody lives HERE, never in the
 * site's public JavaScript.
 *
 * Settlement: TRON network (TRX & TRC-20 tokens, e.g. USDT)
 *   Merchant wallet: TDPB13TMNjRMf3VoCy561CPVhbMqizkEdJ
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

const COIN_CODES = {
  USDT: "usdttrc20",
  USDC: "usdc",
  BTC: "btc",
  ETH: "eth",
  SOL: "sol",
  LTC: "ltc"
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

async function sendDeliveryEmail(env, rec, links, payment) {
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
    PaymentDetailsHtml: deliveryHtml(rec, links),
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

async function handleCheckout(request, env) {
  const body = await request.json().catch(() => null);
  const { order_id, email, coinSym, total, labeled, freeTitles, subtotal, discount, items } = body || {};

  if (!email || !EMAIL_RE.test(email)) return json(env, { error: "INVALID EMAIL" }, 400);
  const payCurrency = COIN_CODES[coinSym];
  if (!payCurrency) return json(env, { error: "UNSUPPORTED COIN" }, 400);
  if (!Array.isArray(items) || !items.length || !items.every((i) => i && i.id)) {
    return json(env, { error: "EMPTY CART" }, 400);
  }
  if (!(total > 0)) return json(env, { error: "INVALID TOTAL" }, 400);

  // Reuse the caller's order id when switching coins mid-checkout.
  const id = order_id && /^KC-[A-Z0-9-]{3,32}$/.test(order_id)
    ? order_id
    : "KC-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();

  const payment = await np(env, "/payment", "POST", {
    price_amount: total,
    price_currency: "usd",
    pay_currency: payCurrency,
    order_id: id,
    order_description: ("KEN CARTER SEASON 01 - " + (labeled || []).join(", ")).slice(0, 1024),
    ipn_callback_url: env.IPN_CALLBACK_URL || new URL(request.url).origin + "/api/ipn"
  });

  await saveOrder(env, id, {
    email,
    coin: payCurrency,
    total,
    labeled: labeled || [],
    freeTitles: freeTitles || [],
    subtotal: subtotal ?? total,
    discount: discount ?? 0,
    items: items.map(({ id: beatId, title }) => ({ id: beatId, title })),
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

async function handleStatus(url, env) {
  const id = url.searchParams.get("order_id");
  const raw = id && (await env.ORDERS.get(orderKey(id)));
  if (!raw) return json(env, { error: "ORDER NOT FOUND" }, 404);
  const rec = JSON.parse(raw);

  // Links exist on this response ONLY after the IPN handler marked released.
  if (rec.released) {
    const map = beatLinks(env);
    return json(env, {
      status: "finished",
      released: true,
      links: rec.items.map(({ id: beatId, title }) => ({ title, url: map[beatId] })).filter((l) => l.url)
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

    const map = beatLinks(env);
    const links = rec.items.map(({ id: beatId, title }) => ({ title, url: map[beatId] })).filter((l) => l.url);
    // ctx.waitUntil keeps delivery alive after this response returns
    ctx.waitUntil(
      sendDeliveryEmail(env, rec, links, payload).catch((e) => console.error("DELIVERY EMAIL FAILED:", e))
    );
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
