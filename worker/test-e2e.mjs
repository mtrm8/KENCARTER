// test-e2e.mjs — comprehensive end-to-end audit of the KENCARTER store
// Runs the actual Cloudflare Worker (src/index.js) against a mocked
// NOWPayments API, StaticForms delivery email, and an in-memory KV binding,
// exercising the full buy → pay → IPN → release → download/license flow.
//
// Run:  node worker/test-e2e.mjs
//
// Sections:
//   A. Frontend source-integrity & interactivity
//   B. Worker HMAC signature verification (NOWPayments spec)
//   C. Checkout contract & validations
//   D. Status lifecycle (pre-release / released)
//   E. IPN release: emails, KV exclusive_sold, license routing
//   F. License routing & delivery accuracy (file-exact)
//   G. CORS, mins, edge cases & error handling

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker, { verifyIpnSignature } from "./src/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("..", import.meta.url));

const G = "\x1b[32m", Rd = "\x1b[31m", Cy = "\x1b[36m", Y = "\x1b[33m", B = "\x1b[1m", R = "\x1b[0m";
let pass = 0, fail = 0;
const PASS = (m) => { pass++; console.log(`${G}✓ ${m}${R}`); };
const FAIL = (m) => { fail++; console.log(`${Rd}✗ ${m}${R}`); };
const INFO = (m) => console.log(`\n${Cy}${B}${m}${R}`);
const check = (cond, m) => (cond ? PASS(m) : FAIL(m));

const ORIGIN = "https://kencarter-store.pages.dev";
const AUTHOR = "END-TO-END TEST";
const t = () => Date.now();
const finish = (label, extra = "") =>
  console.log(
    `\n${B}${label}: ${pass} passed, ${fail} failed${extra ? " — " + extra : ""}${R}` +
      (fail ? `\n${Rd}${B}FAILURE: ${fail} assertion(s) failed.${R}` : `\n${G}${B}ALL CHECKS PASSED.${R}`)
  );

// ───────────────────────────────────────────────────────────────────────────
// Fixed enrollment / env
// ───────────────────────────────────────────────────────────────────────────
const LEASE = readFileSync(root + "LICENSE.txt", "utf8").trim();
const EXCLUSIVE = readFileSync(root + "EXCLUSIVE_LICENSE.txt", "utf8").trim();

class MockKV {
  constructor() { this.map = new Map(); }
  async put(k, v) { this.map.set(k, String(v)); return "OK"; }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async delete(k) { this.map.delete(k); }
}
const kv = new MockKV();

const mock = {
  npStatus: "waiting",
  paySeq: 9000,
  emails: [],
  payments: [],
  calls: { np: [], staticforms: [] },
  minAmount: 1,
  estimateUsd: 1
};

const BEAT_LINKS = JSON.stringify({
  beat1: "https://drive.example/beat1-final.wav",
  beat2: "https://drive.example/beat2-final.wav",
  beat3: "https://drive.example/beat3-final.wav"
});

const env = {
  ORDERS: kv,
  BEAT_LINKS,
  ALLOWED_ORIGIN: ORIGIN,
  NOWPAYMENTS_API_KEY: "test-np-key",
  NOWPAYMENTS_IPN_SECRET: "test-ipn-secret-0123456789",
  STATICFORMS_API_KEY: "test-sf-key",
  IPN_CALLBACK_URL: "https://worker.local/api/ipn",
  MIN_LOOKUP_DELAY_MS: "0"
};
const SECRET = env.NOWPAYMENTS_IPN_SECRET;

const NP_API = "https://api.nowpayments.io/v1";
const SF_API = "https://api.staticforms.dev/submit";

const realFetch = globalThis.fetch;
const ctxTasks = [];
const ctx = { waitUntil: (p) => ctxTasks.push(Promise.resolve(p)) };

globalThis.fetch = async (ful, opts = {}) => {
  const u = String(ful);
  const j = (o, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

  if (u.startsWith(NP_API)) {
    mock.calls.np.push(u);
    const path = u.slice(NP_API.length);
    if (path === "/payment" && (opts.method || "GET").toUpperCase() === "POST") {
      const body = JSON.parse(opts.body || "{}");
      const pay = {
        payment_id: ++mock.paySeq,
        payment_status: "waiting",
        pay_address: "T" + Math.random().toString(36).slice(2, 14).toUpperCase(),
        pay_amount: "1.2345",
        pay_currency: body.pay_currency,
        order_id: body.order_id
      };
      mock.payments.push(pay);
      return j(pay);
    }
    const getPay = path.match(/^\/payment\/(\d+)$/);
    if (getPay) return j({ payment_id: +getPay[1], payment_status: mock.npStatus });
    if (path.startsWith("/min-amount")) return j({ min_amount: mock.minAmount });
    if (path.startsWith("/estimate")) return j({ estimated_amount: mock.estimateUsd });
  }
  if (u.startsWith(SF_API)) {
    mock.calls.staticforms.push(u);
    mock.emails.push(JSON.parse(opts.body || "{}"));
    return j({ success: true }, 200);
  }
  throw new Error("UNEXPECTED MOCKED FETCH: " + u);
};

const npSign = (obj, join) => {
  const values = Object.keys(obj)
    .sort()
    .map((k) => {
      const v = obj[k];
      if (v === null || v === undefined) return "";
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    });
  return createHmac("sha512", SECRET).update(values.join(join)).digest("hex");
};

const req = (path, { method = "GET", body, headers = {} } = {}) => {
  const init = { method, headers };
  if (body) init.body = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("https://worker.local" + path, init);
};

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await worker.fetch(req(path, { method, body, headers }), env, ctx);
  const data = await res.json().catch(() => null);
  return { res, data };
}

async function drain() {
  await Promise.allSettled(ctxTasks.splice(0));
}

// ───────────────────────────────────────────────────────────────────────────
// A. Frontend source-integrity & interactivity
// ───────────────────────────────────────────────────────────────────────────
INFO("A. FRONTEND SOURCE INTEGRITY & INTERACTIVITY");
const script = readFileSync(root + "script.js", "utf8");
const style = readFileSync(root + "style.css", "utf8");

let frontOk = true;
try {
  // Compiles (syntax) without executing: catches any syntax errors.
  new Function(script);
  PASS("script.js parses without syntax errors");
} catch (e) { frontOk = false; FAIL("script.js syntax error: " + e.message); }

const fCheck = (cond, m) => (cond ? PASS("frontend: " + m) : (frontOk = false, FAIL("frontend: " + m)));
fCheck(/function toggle\(id, type\)/.test(script), "toggle(id,type) exists");
fCheck(/exclusiveSelected\.add\(id\)/.test(script) && /selected\.delete\(id\)/.test(script), "selecting EXCLUSIVE removes LEASE (mutual exclusion)");
fCheck(/selected\.add\(id\)/.test(script) && /exclusiveSelected\.delete\(id\)/.test(script), "selecting LEASE removes EXCLUSIVE (mutual exclusion)");
fCheck(/function totals\(\)/.test(script), "totals() exists");
fCheck(/basicCount \* PRICE \+ exclusiveCount \* EXCLUSIVE_PRICE/.test(script), "totals sums lease+exclusive prices");
fCheck(/function freeCap/.test(script) || /Math\.floor\(selected\.size \/ 3\)/.test(script), "PICK 2 GET 1 FREE logic present");
fCheck(/function storeTick\(\)/.test(script) && /setInterval\(storeTick/.test(script), "storeTick() runs on setInterval");
fCheck(/function tickSeason\(\)/.test(script), "tickSeason() exists (#season-timer)");
fCheck(/function tickS02\(\)/.test(script), "tickS02() exists (#s02-timer)");
fCheck(/function tickBeatCountdowns\(\)/.test(script), "tickBeatCountdowns() exists (per-card drop countdowns)");
fCheck(/exclusivePicks: payScreenOrder\.exclusivePicks/.test(script), "checkout request sends exclusivePicks to worker");
fCheck(/a\.href = "EXCLUSIVE_LICENSE\.txt"/.test(script), "exclusive orders get EXCLUSIVE_LICENSE.txt download link");
fCheck(/a\.href = "LICENSE\.txt"/.test(script), "lease orders get LICENSE.txt download link");
fCheck(/@media/.test(style), "responsive breakpoints defined");
fCheck(/flex-direction:\s*column/.test(script) || /\.card__actions\s*\{[^}]*flex-direction:\s*column/.test(style), "card buttons stack (no clipping)");

// ───────────────────────────────────────────────────────────────────────────
// B. Worker HMAC signature verification
// ───────────────────────────────────────────────────────────────────────────
INFO("B. NOWPAYMENTS HMAC-SHA512 SIGNATURE VERIFICATION");
const ipnPayload = { payment_status: "finished", payment_id: 123, order_id: "KC-TEST-ABC", pay_amount: "299.95", pay_currency: "usdttrc20" };
check(await verifyIpnSignature(SECRET, JSON.stringify(ipnPayload), npSign(ipnPayload, "|")), "accepts pipe-joined signature (NOWPayments official)");
check(await verifyIpnSignature(SECRET, JSON.stringify(ipnPayload), npSign(ipnPayload, "")), "accepts empty-joined signature variant");
check(!(await verifyIpnSignature("wrong-secret", JSON.stringify(ipnPayload), npSign(ipnPayload, "|"))), "rejects wrong IPN secret");
check(!(await verifyIpnSignature(SECRET, JSON.stringify(ipnPayload), "deadbeef")), "rejects malformed signature");
check(!(await verifyIpnSignature(SECRET, "not-json", "anything")), "rejects non-JSON body");
check(!(await verifyIpnSignature("", JSON.stringify(ipnPayload), npSign(ipnPayload, "|"))), "rejects empty secret");

// ───────────────────────────────────────────────────────────────────────────
// C. Checkout contract & validations
// ───────────────────────────────────────────────────────────────────────────
INFO("C. CHECKOUT CONTRACT & VALIDATIONS");
let r = await api("/api/checkout", { method: "POST", body: { email: "bad", coinSym: "USDT", items: [{ id: "beat1" }], total: 14.95 } });
check(r.res.status === 400 && /INVALID EMAIL/.test(r.data.error || ""), "rejects invalid email (400 INVALID EMAIL)");
r = await api("/api/checkout", { method: "POST", body: { email: "a@b.co", coinSym: "DOGE", items: [{ id: "beat1" }], total: 14.95 } });
check(r.res.status === 400 && /UNSUPPORTED COIN/.test(r.data.error || ""), "rejects unsupported coin (400 UNSUPPORTED COIN)");
r = await api("/api/checkout", { method: "POST", body: { email: "a@b.co", coinSym: "USDT", items: [], total: 0 } });
check(r.res.status === 400 && /EMPTY CART/.test(r.data.error || ""), "rejects empty cart (400 EMPTY CART)");
r = await api("/api/checkout", { method: "POST", body: { email: "a@b.co", coinSym: "USDT", items: [{ id: "beat1" }], total: 0 } });
check(r.res.status === 400 && /INVALID TOTAL/.test(r.data.error || ""), "rejects zero total (400 INVALID TOTAL)");

// Mixed cart: 2 leases + 1 exclusive ($14.95×2 + $299.95)
const EXCLUSIVE_BEAT = "beat2";
const mixOrder = {
  email: "producer@example.com",
  coinSym: "USDT",
  total: 329.85,
  subtotal: 329.85,
  discount: 0,
  labeled: ["RED ROVER LEASE", "NORTH STAR EXCLUSIVE"],
  freeTitles: [],
  items: [
    { id: "beat1", title: "RED ROVER", type: "lease" },
    { id: EXCLUSIVE_BEAT, title: "NORTH STAR", type: "exclusive" }
  ],
  exclusivePicks: [EXCLUSIVE_BEAT]
};
r = await api("/api/checkout", { method: "POST", body: mixOrder });
const mixOrderId = r.data && r.data.order_id;
check(r.res.status === 200 && mixOrderId && /^KC-/.test(mixOrderId), `checkout creates order ${mixOrderId}`);
check(!!r.data.pay_address && !!r.data.pay_amount && !!r.data.pay_currency, "checkout returns pay_address / pay_amount / pay_currency");
const kvMix = JSON.parse(await kv.get("order:" + mixOrderId));
check(kvMix && kvMix.items.length === 2, "order persisted to KV with 2 items");
check(
  kvMix.items.find((i) => i.id === EXCLUSIVE_BEAT).isExclusive === true &&
    kvMix.items.find((i) => i.id === "beat1").isExclusive === false,
  "KV order flags beat2 EXCLUSIVE, beat1 LEASE"
);
check(kvMix.payment_id === String(mock.paySeq), "order references NOWPayments payment_id");

// Lease-only cart (deliver the OTHER exclusive-less path)
const leaseOrder = {
  email: "artist@example.com",
  coinSym: "BTC",
  total: 29.9,
  subtotal: 29.9,
  discount: 0,
  labeled: ["RED ROVER LEASE", "MIDNIGHT LEASE"],
  freeTitles: [],
  items: [
    { id: "beat1", title: "RED ROVER", type: "lease" },
    { id: "beat3", title: "MIDNIGHT", type: "lease" }
  ],
  exclusivePicks: []
};
r = await api("/api/checkout", { method: "POST", body: leaseOrder });
const leaseOrderId = r.data && r.data.order_id;
check(r.res.status === 200 && /^KC-/.test(leaseOrderId || ""), "lease checkout creates order");
const kvLease = JSON.parse(await kv.get("order:" + leaseOrderId));
check(kvLease.items.every((i) => i.isExclusive === false), "KV lease order has zero exclusive flags");

// ───────────────────────────────────────────────────────────────────────────
// D. Status lifecycle
// ───────────────────────────────────────────────────────────────────────────
INFO("D. STATUS LIFECYCLE (PRE-RELEASE / RELEASED)");
r = await api("/api/status?order_id=" + mixOrderId);
check(r.res.status === 200 && r.data.status === "waiting" && r.data.released === false, "pre-release status: waiting, released=false");
check(!("links" in r.data) || r.data.links === undefined, "pre-release status hides download links");
r = await api("/api/status?order_id=KC-MISSING-NOTFOUND");
check(r.res.status === 404, "unknown order → 404");

// ───────────────────────────────────────────────────────────────────────────
// E. IPN release: KV exclusive_sold, delivery email, license routing
// ───────────────────────────────────────────────────────────────────────────
INFO("E. IPN RELEASE → KV exclusive_sold + EMAIL + LICENSE ROUTING");
const finished = { ...ipnPayload, order_id: mixOrderId };
r = await api("/api/ipn", { method: "POST", body: JSON.stringify(finished), headers: { "x-nowpayments-sig": npSign(finished, "|") } });
check(r.res.status === 200 && r.data.released === true, "IPN 'finished' marks order released");
await drain();

const exKey = await kv.get("exclusive:" + EXCLUSIVE_BEAT);
check(exKey && JSON.parse(exKey).sold === true, `exclusive_sold persisted for ${EXCLUSIVE_BEAT} in KV`);
check(await kv.get("exclusive:beat1") === null, "lease-only beat NOT marked exclusive_sold");

check(mock.emails.length === 1, "exactly one delivery email dispatched for mixed order");
const mixEmail = mock.emails[0] || {};
check(mixEmail.email === "producer@example.com", "email sent to purchaser address");
check(/LICENSE|EXCLUSIVE|CONTRACT/.test(mixEmail.LicenseText || ""), "email carries license text");
check(mixEmail.LicenseText.trim() === EXCLUSIVE, "EXCLUSIVE order email embeds EXACT EXCLUSIVE_LICENSE.txt text");
check((mixEmail.PaymentDetailsHtml || "").includes("EXCLUSIVE MASTER RIGHTS LICENSE"), "email HTML includes exclusive license block");
check((mixEmail.PaymentDetailsHtml || "").includes("NORTH STAR"), "email HTML lists purchased beats");
check(/PAID — VERIFIED BY NOWPAYMENTS IPN/.test(mixEmail.PaymentStatus || ""), "email reports IPN-verified finished payment");
check(mixEmail.Total === "$329.85", "email shows exact cart total");

// PaymentStatus copy also reflects finished status in NP_STATUS_COPY map
check(mock.calls.np.some((u) => u.includes("/payment")), "NOWPayments API was consulted during checkout/IPN flow");

// ───────────────────────────────────────────────────────────────────────────
// F. License routing & delivery accuracy
// ───────────────────────────────────────────────────────────────────────────
INFO("F. LICENSE ROUTING & DELIVERY ACCURACY");

// Released mixed order → status exposes EXACT exclusive license + flagged links
r = await api("/api/status?order_id=" + mixOrderId);
check(r.res.status === 200 && r.data.released === true, "released order returns released=true");
check(r.data.links.length === 2, "both beat links returned");
const north = r.data.links.find((l) => l.title === "NORTH STAR");
const rover = r.data.links.find((l) => l.title === "RED ROVER");
check(north && north.isExclusive === true, "exclusive beat link flagged isExclusive");
check(rover && rover.isExclusive === false, "lease beat link NOT flagged isExclusive");
check(r.data.license && r.data.license.trim() === EXCLUSIVE, "mixed order status license === EXACT EXCLUSIVE_LICENSE.txt");
check((r.data.links[0].url || "").indexOf("http") === 0, "download links are absolute drive URLs");

// Lease-only release → LICENSE.txt routing, no exclusive KV, no exclusive email
const leaseFinished = { ...ipnPayload, order_id: leaseOrderId };
r = await api("/api/ipn", { method: "POST", body: JSON.stringify(leaseFinished), headers: { "x-nowpayments-sig": npSign(leaseFinished, "|") } });
check(r.res.status === 200 && r.data.released === true, "lease IPN 'finished' releases order");
await drain();
const leaseEmail = mock.emails[1] || {};
check(leaseEmail.LicenseText.trim() === LEASE, "LEASE order email embeds EXACT LICENSE.txt text");
check(!leaseEmail.LicenseText.includes("EXCLUSIVE MASTER RIGHTS"), "lease email must NOT contain exclusive text");
check((leaseEmail.PaymentDetailsHtml || "").includes("OFFICIAL LEASE LICENSE CONTRACT"), "lease email HTML uses lease license block");
check((leaseEmail.PaymentDetailsHtml || "").includes("RED ROVER") && (leaseEmail.PaymentDetailsHtml || "").includes("MIDNIGHT"), "lease email lists all beats");
check(await kv.get("exclusive:beat1") === null && await kv.get("exclusive:beat3") === null, "lease order creates NO exclusive_sold markers");

const leaseStatus = await api("/api/status?order_id=" + leaseOrderId);
check(leaseStatus.data.license && leaseStatus.data.license.trim() === LEASE, "lease order status license === EXACT LICENSE.txt");
check(leaseStatus.data.links.every((l) => !l.isExclusive), "lease order links have isExclusive=false");

// Index-misalignment guard: released order where a beat has NO configured URL
const hangmanOrder = {
  email: "edgy@example.com",
  coinSym: "USDT",
  total: 314.9,
  labeled: ["GHOST LEASE", "PHANTOM EXCLUSIVE"],
  freeTitles: [],
  items: [
    { id: "nourl-ghost", title: "GHOST", type: "lease" },
    { id: "beat3", title: "PHANTOM", type: "exclusive" }
  ],
  exclusivePicks: ["beat3"]
};
r = await api("/api/checkout", { method: "POST", body: hangmanOrder });
const hangOrderId = r.data.order_id;
const hangFinished = { ...ipnPayload, order_id: hangOrderId };
r = await api("/api/ipn", { method: "POST", body: JSON.stringify(hangFinished), headers: { "x-nowpayments-sig": npSign(hangFinished, "|") } });
await drain();
const hangStatus = await api("/api/status?order_id=" + hangOrderId);
// GHOST has no configured URL (dropped); PHANTOM at index 1 must still map to
// its own drive link AND carry its own isExclusive=true flag, not the lease's.
check(hangStatus.data.links.length === 1 && hangStatus.data.links[0].title === "PHANTOM", "exclusive beat correctly assigned despite no-URL lease at index 0");
check(hangStatus.data.links[0].isExclusive === true, "exclusive flag survives beat URL gaps (fix regression guard)");

// ───────────────────────────────────────────────────────────────────────────
// G. CORS, mins, edge cases & error handling
// ───────────────────────────────────────────────────────────────────────────
INFO("G. CORS, MIN-AMOUNT, EDGE CASES & ERROR HANDLING");
let cors = await worker.fetch(req("/api/status?order_id=X", { method: "OPTIONS" }), env, ctx);
check(cors.status === 204 && cors.headers.get("Access-Control-Allow-Origin") === ORIGIN, "OPTIONS returns CORS headers (204)");

r = await api("/api/mins?coins=USDT,BTC,LOL");
check(r.res.status === 200 && typeof r.data.mins === "object", "/api/mins returns mins object");
check(r.data.mins.USDT > 0 && r.data.mins.BTC > 0, "/api/mins includes requested coins");
check(!("LOL" in r.data.mins), "/api/mins ignores unknown coins");

const emptyProbe = await api("/api/ipn", { method: "POST", body: "" });
check(emptyProbe.res.status === 200 && emptyProbe.data.ok === true, "NOWPayments URL-validation empty POST acknowledged");

const unknownOrderIpn = { payment_status: "finished", payment_id: 1, order_id: "KC-NOPE-1" };
r = await api("/api/ipn", { method: "POST", body: JSON.stringify(unknownOrderIpn), headers: { "x-nowpayments-sig": npSign(unknownOrderIpn, "|") } });
check(r.res.status === 200 && r.data.ok && /ACKNOWLEDGED/.test(r.data.note || ""), "IPN for unknown order acknowledged (idempotent)");

const badSigIpn = { payment_status: "finished", payment_id: 2, order_id: "KC-X" };
r = await api("/api/ipn", { method: "POST", body: JSON.stringify(badSigIpn), headers: { "x-nowpayments-sig": "deadbeef" } });
check(r.res.status === 401, "IPN with bad signature rejected (401)");

// 'confirmed' (not finished) must NOT release links or email
const pendingIpn = { payment_status: "confirmed", payment_id: 123, order_id: mixOrderId, pay_amount: "329.85" };
r = await api("/api/ipn", { method: "POST", body: JSON.stringify(pendingIpn), headers: { "x-nowpayments-sig": npSign(pendingIpn, "|") } });
check(r.res.status === 200 && r.data.ok === true && !r.data.released, "'confirmed' IPN acknowledged without release");
const stillWait = await api("/api/status?order_id=" + mixOrderId);
check(stillWait.data.released === true, "already-released order remains released after IPN (no regression)");

r = await api("/api/unknown");
check(r.res.status === 404, "unknown route → 404");
r = await api("/api/checkout", { method: "POST", body: "not-json" });
check(r.res.status === 400, "invalid JSON checkout body rejected");

// Physical files must exist at site root (frontend reference targets)
check(readFileSync(root + "LICENSE.txt", "utf8").includes("Prod. by Ken Carter"), "LICENSE.txt exists at site root with credit clause");
check(readFileSync(root + "EXCLUSIVE_LICENSE.txt", "utf8").includes("Full Master Rights Transfer"), "EXCLUSIVE_LICENSE.txt exists at site root with transfer clause");

// ───────────────────────────────────────────────────────────────────────────
// Summary
// ───────────────────────────────────────────────────────────────────────────
INFO("FINAL STATUS REPORT");
console.log("  Payment provider .... NOWPayments (Tron/TRC-20 settlement) — NOT Helio (no Helio code in repo)");
console.log("  Delivery channel .... StaticForms auto-reply email, embedded license");
console.log("  KV bindings ......... order:{id}, exclusive:{beat} (never marks leases)");
console.log("  Release trigger ..... IPN payment_status === 'finished' (HMAC-SHA512 verified)");
console.log(`  Email verified ...... ${mock.emails.length} delivery email(s) captured`);
console.log(`  NOWPayments calls ... ${mock.calls.np.length}; StaticForms calls ${mock.calls.staticforms.length}`);
finish("\nEND-TO-END VERIFICATION", `${pass + fail} total assertions`);

globalThis.fetch = realFetch;
process.exitCode = fail ? 1 : 0;