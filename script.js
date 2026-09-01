// Cloudflare Worker backend — performs every NOWPayments call, holds the
// download URLs, and dispatches the delivery email after an HMAC-verified
// 'finished' IPN. Nothing order-related is submitted from this file.
const WORKER_URL = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://localhost:8787"
  : "https://kencarter-checkout.kencarter-store.workers.dev";

const PRICE = 14.95;
const EXCLUSIVE_PRICE = 299.95;
const LOW_STOCK_AT = 3;

const LEASES_PER_BEAT = 10;

const BEATS = [
  { id: "beat1", title: "BEAT 01", name: "CH\u00a3$$",          img: "assets/beat1.jpg?v=2", bpm: 140, key: "E MIN",  tag: "SEASON 01", leases: LEASES_PER_BEAT, youtube: "https://youtu.be/EtIy63bCyEc" },
  { id: "beat2", title: "BEAT 02", name: "AnGeLL",             img: "assets/beat2.jpg?v=2", bpm: 75,  key: "G# MIN", tag: "SEASON 01", leases: LEASES_PER_BEAT, youtube: "https://youtu.be/Y4CY1Qb4e4s" },
  { id: "beat3", title: "BEAT 03", name: "DIAMONS IN THE BAG", img: "assets/beat3.jpg?v=2", bpm: 130, key: "A# MIN", tag: "SEASON 01", leases: LEASES_PER_BEAT, youtube: "https://youtu.be/orkevqUH0bM" },
  { id: "beat4", title: "BEAT 04", name: "$$$",                img: "assets/beat4.jpg?v=2", bpm: 140, key: "G MIN",  tag: "SEASON 01", leases: LEASES_PER_BEAT, youtube: "https://youtu.be/bRudvWoy7RY" },
  { id: "beat5", title: "BEAT 05", name: "HIGH VIEW",          img: "assets/beat5.jpg?v=2", bpm: 168, key: "C MIN",  tag: "SEASON 01", leases: LEASES_PER_BEAT, youtube: "https://youtu.be/12qPZNM2fe0" },
  { id: "beat6", title: "BEAT 06", name: "PROTOCOL",           img: "assets/beat6.jpg?v=2", bpm: 135, key: "G# MIN", tag: "SEASON 01", leases: LEASES_PER_BEAT, youtube: "https://youtu.be/xk_SSDX4vZE" },
  { id: "beat7", title: "BEAT 07", name: "LAST SEAT",          img: "assets/beat7.jpg?v=2", bpm: 140, key: "G# MIN", tag: "SEASON 01", releaseAt: "2026-08-23T20:00:00Z", leases: LEASES_PER_BEAT, youtube: "https://youtu.be/p7vyAIsWKQw" }
].map((b) => ({ ...b, left: b.left ?? b.leases }));

const SEASON2_BEATS = [
  { id: "s2-beat1", title: "BEAT 01", name: "ART",                  img: "BEAT COVERS/beat-01.png", bpm: 126, key: "C# MIN", tag: "SEASON 02", releaseAt: "2026-09-01T20:00:00Z", leases: LEASES_PER_BEAT, drive: "https://drive.google.com/file/d/1zovFkuAsJJ68fIP7hzn8x9PWHecWy8It/view?usp=share_link", youtube: "https://youtu.be/LeARirM_bl0" },
  { id: "s2-beat2", title: "BEAT 02", name: "Take the CROW",       img: "BEAT COVERS/beat-02.png", bpm: 130, key: "D# MIN", tag: "SEASON 02", releaseAt: "2026-09-05T20:00:00Z", leases: LEASES_PER_BEAT, drive: "https://drive.google.com/file/d/1am79D70Miq3_XeVme7Hlc5NlVh5I0v9a/view?usp=share_link", youtube: "https://youtu.be/ZptaYX0g8uU" },
  { id: "s2-beat3", title: "BEAT 03", name: "Late Night",           img: "BEAT COVERS/beat-03.png", bpm: 138, key: "E MIN",  tag: "SEASON 02", releaseAt: "2026-09-09T20:00:00Z", leases: LEASES_PER_BEAT, drive: "https://drive.google.com/file/d/1RK8s9G-RgIbVYXkKqWoP05h9uxNZM_Xp/view?usp=share_link", youtube: "https://youtu.be/EpV_G80aKQU" },
  { id: "s2-beat4", title: "BEAT 04", name: "Antinous",             img: "BEAT COVERS/beat-04.png", bpm: 130, key: "F MIN",  tag: "SEASON 02", releaseAt: "2026-09-13T20:00:00Z", leases: LEASES_PER_BEAT, drive: "https://drive.google.com/file/d/1Lhy1DvxSo3wOiHRbsj_2wVF1EKzPsNbS/view?usp=share_link", youtube: "https://youtu.be/PD4qibTpR_s" },
  { id: "s2-beat5", title: "BEAT 05", name: "4 AM",                 img: "BEAT COVERS/beat-05.png", bpm: 166, key: "F# MIN", tag: "SEASON 02", releaseAt: "2026-09-17T20:00:00Z", leases: LEASES_PER_BEAT, drive: "https://drive.google.com/file/d/1xGzuj_3YdWKsrM5XYopRBAhxCCIGle3A/view?usp=share_link", youtube: "https://youtu.be/alA-itPRkt4" },
  { id: "s2-beat6", title: "BEAT 06", name: "White",                img: "BEAT COVERS/beat-06.png", bpm: 119, key: "B MIN",  tag: "SEASON 02", releaseAt: "2026-09-21T20:00:00Z", leases: LEASES_PER_BEAT, drive: "https://drive.google.com/file/d/14MsnfvOpanbMSjAtbSVB3m3qA8VaR6Ro/view?usp=share_link", youtube: "https://youtu.be/nl2M-EaCrrk" },
  { id: "s2-beat7", title: "BEAT 07", name: "Rewind",               img: "BEAT COVERS/beat-07.png", bpm: 132, key: "G MIN",  tag: "SEASON 02", releaseAt: "2026-09-25T20:00:00Z", leases: LEASES_PER_BEAT, drive: "https://drive.google.com/file/d/1sbJakmKZIwhd5iDud8X_5BtRLNoVdnQc/view?usp=share_link", youtube: "https://youtu.be/WZLsWpzFJAs" }
].map((b) => ({ ...b, left: b.left ?? b.leases }));

let CATALOG = BEATS;
let selectedSeason = null;

function catalogFor(season) {
  if (season === "S01") return BEATS;
  if (season === "S02") return SEASON2_BEATS;
  return [];
}

// A season is only viewable once it is no longer "upcoming" (i.e. it has
// launched, or it is an ended archive). Upcoming seasons stay hidden/locked.
function isSeasonViewable(s, now = Date.now()) {
  return seasonState(s, now) !== "upcoming";
}

function defaultSeason() {
  const viewable = SEASONS.filter((s) => isSeasonViewable(s));
  return viewable.length ? viewable[viewable.length - 1].id : null;
}

// Season registry for announced seasons (Season 1 and Season 2).
const SEASONS = [
  { id: "S01", label: "SEASON 1", closeAt: "2026-08-29T20:00:00Z" },
  { id: "S02", label: "SEASON 2", launchAt: S02_OPEN_AT, closeAt: "2026-09-30T20:00:00Z" }
];

function seasonLaunchAt(s) {
  return s.launchAt ? Date.parse(s.launchAt) : null;
}

function seasonState(s, now = Date.now()) {
  if (s.closed) return "ended";
  if (s.closeAt && now >= Date.parse(s.closeAt)) return "ended";
  const la = seasonLaunchAt(s);
  if (la == null) return "live";
  return now >= la ? "live" : "upcoming";
}

function seasonBadge(s) {
  const state = seasonState(s);
  if (state === "live") return "ACTIVE";
  if (state === "ended") return "ENDED";
  const d = new Date(seasonLaunchAt(s));
  return `UPCOMING \u00b7 ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

const TICKER_TEXT = "KEN CARTER \u2014 SEASON 01 IS LIVE \u2014 STRICTLY LIMITED LEASES \u2014 ALL BEATS $14.95 \u2014 PICK 2, GET 1 FREE \u2014 ";

const S01_CLOSE_AT = "2026-08-29T20:00:00Z";
const S02_OPEN_AT  = "2026-09-01T20:00:00Z";
const S02_FINAL_DROP_AT = "2026-09-25T20:00:00Z";
const S02_CLOSE_AT = "2026-09-30T20:00:00Z";
const DAY_MS       = 24 * 60 * 60 * 1000;
let storeTimer     = null;

function s02UnlockedCount(now = Date.now()) {
  if (!CATALOG.length) return 0;
  const openDay = Math.floor(Date.parse(S02_OPEN_AT) / DAY_MS);
  const today = Math.floor(now / DAY_MS);
  return Math.max(1, Math.min(CATALOG.length, today - openDay + 1));
}

const money = (n) => "$" + n.toFixed(2);

function storePhase(now = Date.now()) {
  const t = typeof now === "number" ? now : Date.now();
  if (t < Date.parse(S01_CLOSE_AT)) return "S01";
  if (t < Date.parse(S02_OPEN_AT)) return "GAP";
  if (t < Date.parse(S02_CLOSE_AT)) return "S02";
  return "POST";
}

function setKicker(text) {
  const k = document.querySelector(".season__kicker");
  if (k) k.textContent = text;
}

function tickSeason(now = Date.now()) {
  const timerEl = $("season-timer") || $("s02-timer");
  if (!timerEl) return;
  const statusEl = $("season-status");
  const s1 = SEASONS.find(s => s.id === "S01");
  const s2 = SEASONS.find(s => s.id === "S02");

  if (s1 && seasonState(s1, now) === "live") {
    setKicker("SEASON 01 CLOSES IN");
    if (statusEl) statusEl.textContent = "SEASON 01 LOCKS WHEN TIMER EXPIRES OR LEASES SELL OUT.";
    const remaining = Date.parse(S01_CLOSE_AT) - now;
    timerEl.textContent = remaining <= 0 ? "EXPIRED" : formatRemaining(remaining);
    return;
  }

  if (now < Date.parse(S02_OPEN_AT)) {
    setKicker("SEASON 01 HAS CLOSED");
    if (statusEl) statusEl.textContent = "SEASON 02 OPENS SEP 1, 2026 \u00b7 20:00 UTC.";
    const remaining = Date.parse(S02_OPEN_AT) - now;
    timerEl.textContent = remaining <= 0 ? "OPENING\u2026" : formatRemaining(remaining);
    return;
  }

  if (s2 && seasonState(s2, now) === "live") {
    const afterFinalDrop = now >= Date.parse(S02_FINAL_DROP_AT);
    if (afterFinalDrop) {
      setKicker("SEASON 02 CLOSES IN");
      if (statusEl) statusEl.textContent = "SEASON 02 LOCKS WHEN TIMER EXPIRES OR LEASES SELL OUT.";
      const remaining = Date.parse(S02_CLOSE_AT) - now;
      timerEl.textContent = remaining <= 0 ? "EXPIRED" : formatRemaining(remaining);
    } else {
      setKicker("SEASON 02 IS LIVE");
      if (statusEl) statusEl.textContent = "SEASON 02 CATALOG IS ACTIVE WITH SCHEDULED DROP DATES.";
      timerEl.textContent = "LIVE NOW";
    }
    return;
  }

  setKicker("SEASON 02 HAS CLOSED");
  if (statusEl) statusEl.textContent = "SEASON 02 IS NOW ARCHIVED \u00b7 VIEW ONLY.";
  timerEl.textContent = "EXPIRED";
}

function tickS02(now = Date.now()) {
  const el = $("s02-timer") || $("season-timer");
  if (!el) return;
  const kicker = $("s02-kicker");

  if (now < Date.parse(S02_OPEN_AT)) {
    if (kicker) kicker.textContent = "SEASON 02 \u2014 NEXT DROP IN";
    const remaining = Date.parse(S02_OPEN_AT) - now;
    el.textContent = remaining <= 0 ? "OPENING\u2026" : formatRemaining(remaining);
    return;
  }

  if (now < Date.parse(S02_FINAL_DROP_AT)) {
    if (kicker) kicker.textContent = "SEASON 02 \u2014 FINAL DROP IN";
    const remaining = Date.parse(S02_FINAL_DROP_AT) - now;
    el.textContent = remaining <= 0 ? "FINAL DROP READY" : formatRemaining(remaining);
    return;
  }

  if (now < Date.parse(S02_CLOSE_AT)) {
    if (kicker) kicker.textContent = "SEASON 02 \u2014 CLOSES IN";
    const remaining = Date.parse(S02_CLOSE_AT) - now;
    el.textContent = remaining <= 0 ? "EXPIRED" : formatRemaining(remaining);
    return;
  }

  if (kicker) kicker.textContent = "SEASON 02 HAS CLOSED";
  el.textContent = "ARCHIVED";
}

function tickBeatCountdowns() {
  let changed = false;
  CATALOG.forEach((beat) => {
    if (!beat.releaseAt) return;
    const timerEl = $("countdown-" + beat.id);
    if (!timerEl) return;
    const rem = releaseDate(beat).getTime() - Date.now();
    if (rem <= 0) {
      changed = true;
    } else {
      timerEl.textContent = formatRemaining(rem);
    }
  });
  if (changed) {
    buildGrid();
    render();
  }
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const releaseDate = (b) => (b.releaseAt ? new Date(b.releaseAt) : null);
const isReleased = (b) => {
  if (isKenHolder && b.tag === "SEASON 02") return true;
  return !b.releaseAt || Date.now() >= releaseDate(b).getTime();
};
const isSoldOut = (b) => b.soldOut || b.left <= 0;

const byNewest = (a, b) => BEATS.indexOf(b) - BEATS.indexOf(a);
function renderOrder(list) {
  return [
    ...list.filter((b) => !isSoldOut(b)).sort(byNewest),
    ...list.filter((b) => isSoldOut(b)).sort(byNewest)
  ];
}
const pad = (n) => String(n).padStart(2, "0");

function dropLabel(d) {
  const h24 = d.getHours();
  const h12 = h24 % 12 || 12;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} \u2014 ${h12}:${pad(d.getMinutes())} ${h24 >= 12 ? "PM" : "AM"}`;
}

function formatRemaining(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86400);
  const h = pad(Math.floor((s % 86400) / 3600));
  const m = pad(Math.floor((s % 3600) / 60));
  const sec = pad(s % 60);
  return (days > 0 ? days + "D " : "") + `${h}:${m}:${sec}`;
}

const selected = new Set();
const freePicks = new Set();
const exclusiveSelected = new Set();

const freeCap = () => Math.floor(selected.size / 3);

function normalizeFreePicks() {
  const cap = freeCap();
  [...freePicks].forEach((id) => !selected.has(id) && freePicks.delete(id));
  while (freePicks.size > cap) freePicks.delete([...freePicks][0]);
}

function toggleFreePick(id) {
  if (!selected.has(id) || freeCap() === 0) return;
  if (freePicks.has(id)) {
    freePicks.delete(id);
  } else {
    if (freePicks.size >= freeCap()) freePicks.delete([...freePicks][0]);
    freePicks.add(id);
  }
  render();
}

const $ = (id) => document.getElementById(id) || document.getElementById(id === "season-timer" ? "s02-timer" : (id === "s02-timer" ? "season-timer" : id));

const grid = $("grid");
const cartbar = $("cartbar");
const drawer = $("drawer");
const backdrop = $("backdrop");

const BTC_ENDPOINT =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,tether,usd-coin&vs_currencies=usd";

const KEN_MINT = "HEFkC6WQo3jTv39B6JhYQJ3ZW8xKxRELaWdnirdSpump";
const MERCHANT_SOL_ADDRESS = "2P2m2u46hg7a7eK6YSjtogSv4QnExEdfsjAKkGz719aX";
let connectedWalletAddress = null;
let isKenHolder = false;

const ASSETS = {
  USDT: {
    sym: "USDT", name: "TETHER", id: "tether", np: "usdtsol",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="currentColor" fill-rule="evenodd" d="M6.7 6.9h10.6v2.8h-4.2v1.4c2.75.2 4.8.95 4.8 1.85 0 1.05-2.7 1.9-6 1.9s-6-.85-6-1.9c0-.9 2.05-1.65 4.8-1.85V9.7H6.7Zm5.3 6.15c2.95 0 5.35-.6 5.35-1.15 0-.5-1.75-.95-3.65-1.07v1.1c0 .26-.76.47-1.7.47s-1.7-.21-1.7-.47v-1.1c-1.9.12-3.65.57-3.65 1.07 0 .55 2.4 1.15 5.35 1.15Z"/></svg>`
  },
  USDC: {
    sym: "USDC", name: "USD COIN", id: "usd-coin", np: "usdc",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8"/><text x="12" y="16.6" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="12.5" font-weight="700" fill="currentColor">$</text></svg>`
  },
  BTC: {
    sym: "BTC", name: "BITCOIN", id: "bitcoin", np: "btc",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10" stroke-width="1.8"/><path stroke-width="1.6" stroke-linecap="round" d="M9.6 7.2h3.5a2.4 2.4 0 0 1 0 4.8H9.6m4 0a2.55 2.55 0 0 1 0 5.1H9.6m0-9.9v9.9m1.6-11.7v1.8m2.2-1.8v1.8m-2.2 9.9v1.8m2.2-1.8v1.8"/></svg>`
  },
  ETH: {
    sym: "ETH", name: "ETHEREUM", id: "ethereum", np: "eth",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 1.8 5.4 12.2 12 16l6.6-3.8Z"/><path fill="currentColor" d="M12 17.7 5.4 13.9 12 22.6l6.6-8.7Z"/></svg>`
  },
  SOL: {
    sym: "SOL", name: "SOLANA", id: "solana", np: "sol",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.2 4.4h13.2l-2.7 3.2H4.5zM16.8 10.4H3.6l2.7 3.2h13.2zM7.2 16.4h13.2l-2.7 3.2H4.5z"/></svg>`
  },
  LTC: {
    sym: "LTC", name: "LITECOIN", id: null, np: "ltc",
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8"/><text x="12" y="16.6" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="12.5" font-weight="700" fill="currentColor">\u0141</text></svg>`
  },
  KEN: {
    sym: "KEN", name: "KEN TOKEN", id: "ken", np: "sol", mint: KEN_MINT, discount: 0.15,
    icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8"/><text x="12" y="16.6" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="11" font-weight="700" fill="currentColor">K</text></svg>`
  }
};

const FALLBACK_SYMS = ["USDT", "USDC", "LTC"];

const PAYMENT_GROUPS = [
  {
    value: "Stablecoins (USDT/USDC)",
    label: "USDT / USDC",
    sub: "STABLE \u00b7 RECOMMENDED",
    assets: ["USDT", "USDC"],
    icon: ASSETS.USDT.icon
  },
  {
    value: "Bitcoin (BTC)",
    label: "BTC",
    sub: "BITCOIN",
    assets: ["BTC"],
    icon: ASSETS.BTC.icon
  },
  {
    value: "Ethereum / Solana (ETH/SOL)",
    label: "ETH / SOL",
    sub: "ETH OR SOLANA",
    assets: ["ETH", "SOL"],
    icon: ASSETS.ETH.icon
  },
  {
    value: "KEN Token (KEN)",
    label: "KEN",
    sub: "COMMUNITY TOKEN \u00b7 15% OFF",
    assets: ["KEN"],
    icon: ASSETS.KEN.icon
  }
];

let payGroup = null;
let payAssetSym = null;

const CRYPTO_PRICES = {};

function renderBtc(usd) {
  const label = `\u2248 ${(PRICE / usd).toFixed(6)} BTC`;
  document.querySelectorAll(".btc-price").forEach((el) => (el.textContent = label));
}

function activeAsset() {
  return payAssetSym ? ASSETS[payAssetSym] : null;
}

function renderCryptoTotal() {
  const chip = $("t-crypto");
  if (!chip) return;
  const asset = activeAsset();
  if (!asset) {
    chip.hidden = true;
    return;
  }
  const { total } = totals();
  const usd = CRYPTO_PRICES[asset.id];
  chip.innerHTML =
    asset.icon +
    (usd ? `<span>(\u2248 ${(total / usd).toFixed(usd < 5 ? 2 : 6)} ${asset.sym})</span>` : "");
  chip.hidden = false;
}

function selectPayment(value) {
  const group = PAYMENT_GROUPS.find((g) => g.value === value) || null;
  if (group && isGroupBelowMin(group)) {
    const alt = firstAffordableGroup(value);
    if (!alt) return;
    return selectPayment(alt.value);
  }
  payGroup = group;
  payAssetSym = group ? group.assets[0] : null;
  $("payment").value = group ? group.value : "";
  $("paygrid").classList.remove("invalid");
  document.querySelectorAll(".paygrid__opt").forEach((b) => {
    const on = b.dataset.value === value;
    b.classList.toggle("paygrid__opt--on", on);
    b.setAttribute("aria-checked", String(on));
  });
  renderCryptoTotal();
}

function buildPaygrid() {
  const grid = $("paygrid");
  PAYMENT_GROUPS.forEach((group) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "paygrid__opt";
    btn.dataset.value = group.value;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", "false");
    btn.innerHTML = `${group.icon}<span>${group.label}</span><span class="paygrid__opt-sub">${group.sub}</span>`;
    grid.appendChild(btn);
  });
  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".paygrid__opt");
    if (btn) selectPayment(btn.dataset.value);
  });
}

function startBtc() {
  const update = () =>
    fetch(BTC_ENDPOINT)
      .then((r) => r.json())
      .then((d) => {
        if (!d) return;
        if (d.bitcoin && d.bitcoin.usd) renderBtc(d.bitcoin.usd);
        Object.keys(d).forEach((id) => {
          if (d[id] && d[id].usd) CRYPTO_PRICES[id] = d[id].usd;
        });
        renderCryptoTotal();
      })
      .catch(() => {});
  update();
  setInterval(update, 60000);
}

function buildTicker() {
  const line = TICKER_TEXT.repeat(6);
  document.querySelectorAll(".ticker__track span").forEach((s) => (s.textContent = line));
}

function beatNum(beat) {
  return pad(CATALOG.indexOf(beat) + 1);
}

function specLine(beat) {
  return beat.bpm
    ? `${beat.bpm} BPM // ${beat.key}`
    : "FULL DETAILS DROP WITH THE BEAT";
}

function stockLine(beat) {
  if (isSoldOut(beat)) return `ALL ${beat.leases} LEASES SOLD`;
  if (beat.left <= LOW_STOCK_AT) return `ONLY ${beat.left} OF ${beat.leases} LEASES LEFT`;
  return `${beat.left} OF ${beat.leases} LEASES LEFT`;
}

function stockHTML(beat) {
  const low = !isSoldOut(beat) && beat.left <= LOW_STOCK_AT;
  const pips = Array.from({ length: beat.leases }, (_, i) =>
    `<i${i < beat.left ? ` class="${i === beat.left - 1 && low ? "on last" : "on"}"` : ""}></i>`
  ).join("");
  return `
    <div class="card__stockrow">
      <span class="card__stock${low ? " card__stock--low" : ""}">${stockLine(beat)}</span>
      <span class="card__stockbar" aria-hidden="true">${pips}</span>
    </div>`;
}

function youtubeHTML(beat, show) {
  if (!show || !beat.youtube) return "";
  return `<a href="${beat.youtube}" target="_blank" rel="noopener noreferrer" class="card__youtube-link" aria-label="Watch on YouTube" title="Watch on YouTube" onclick="event.stopPropagation()"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>`;
}

function cardInner(beat, opts = {}, index = 0) {
  const { locked = false, archive = false } = opts;

  // ARCHIVE — Season 1 view-only (simplified: name + BPM/key only, no stock/price)
  if (archive) {
    return `
      <div class="card__media">
        <img src="${beat.img}" alt="${beat.title}" decoding="async" loading="lazy">
        <span class="card__num">${pad(index + 1)} OF ${pad(CATALOG.length)}</span>
        <span class="card__tag card__tag--ended">ENDED \u00b7 ARCHIVE</span>
      </div>
      <div class="card__info">
        <div class="card__meta">
          <div class="card__name">
            <span>${beat.title}${beat.name ? ` <span class="card__name-alt">\u2014 ${beat.name}</span>` : ""}</span>
            ${youtubeHTML(beat, true)}
          </div>
          <div class="card__specs">${specLine(beat)}</div>
        </div>
        <button class="card__btn card__btn--ended" disabled>VIEW ONLY</button>
      </div>`;
  }

  // LOCKED — Season 2 unreleased (blur cover + countdown + redacted details)
  if (locked) {
    const unlockDay = releaseDate(beat);
    const label = unlockDay
      ? `${MONTHS[unlockDay.getUTCMonth()]} ${unlockDay.getUTCDate()}`
      : "";
    return `
      <div class="card__media">
        <img src="${beat.img}" alt="LOCKED" decoding="async" loading="lazy">
        <span class="card__num">${pad(index + 1)} OF ${pad(CATALOG.length)}</span>
        <span class="card__tag card__tag--soon">DROPS SOON</span>
        <div class="card__countdown">
          <span class="card__countdown-label">DROPS ${label} \u00b7 20:00 UTC</span>
          <span class="card__countdown-timer" id="countdown-${beat.id}">${formatRemaining(releaseDate(beat) - Date.now())}</span>
        </div>
      </div>
      <div class="card__info">
        <div class="card__meta">
          <div class="card__name"><span class="redact-bar" style="width:72%"></span></div>
          <div class="card__specs"><span class="redact-bar redact-bar--thin" style="width:48%"></span></div>
          <div class="card__price">$${PRICE.toFixed(2)}</div>
          <div class="btc-price"></div>
        </div>
        <button class="card__btn" disabled>SOON</button>
      </div>`;
  }

  const released = isReleased(beat);
  const sold = isSoldOut(beat);
  const mediaTag = sold
    ? `<span class="card__tag card__tag--sold">SOLD OUT</span>`
    : released
      ? beat.tag
        ? `<span class="card__tag">${beat.tag}</span>`
        : ""
      : `<div class="card__countdown">
           <span class="card__countdown-label">DROPS ${dropLabel(releaseDate(beat))}</span>
           <span class="card__countdown-timer" id="countdown-${beat.id}">${formatRemaining(releaseDate(beat) - Date.now())}</span>
         </div>`;

  const isLeaseOn = selected.has(beat.id);
  const isExclusiveOn = exclusiveSelected.has(beat.id);

  const action = sold
    ? `<button class="card__btn card__btn--sold" disabled>SOLD OUT</button>`
    : released
      ? `<div class="card__actions">
           <button class="card__btn card__btn--lease${isLeaseOn ? " card__btn--active" : ""}" data-id="${beat.id}" data-type="lease" aria-pressed="${isLeaseOn}">
             LEASE ($${PRICE.toFixed(2)})${isLeaseOn ? ' <span class="card__btn-check">&check;</span>' : ""}
           </button>
           ${beat.left > 0 ? `
             <button class="card__btn card__btn--exclusive${isExclusiveOn ? " card__btn--active" : ""}" data-id="${beat.id}" data-type="exclusive" aria-pressed="${isExclusiveOn}">
               EXCLUSIVE ($${EXCLUSIVE_PRICE.toFixed(2)})${isExclusiveOn ? ' <span class="card__btn-check">&check;</span>' : ""}
             </button>
           ` : ""}
         </div>`
      : `<button class="card__btn" disabled>SOON</button>`;

  return `
    <div class="card__media">
      <img src="${beat.img}" alt="${beat.title}" decoding="async" fetchpriority="high">
      <span class="card__num">${beatNum(beat)} OF ${pad(CATALOG.length)}</span>
      ${mediaTag}
    </div>
    <div class="card__info">
      <div class="card__meta">
        <div class="card__name">
          <span>${beat.title} <span class="card__name-alt">\u2014 ${beat.name}</span></span>
          ${youtubeHTML(beat, released)}
        </div>
        <div class="card__specs">${specLine(beat)}</div>
        <div class="btc-price"></div>
        ${stockHTML(beat)}
      </div>
      ${action}
    </div>`;
}

function buildGrid() {
  grid.innerHTML = "";
  const list = renderOrder(CATALOG);

  if (!list.length) {
    const panel = document.createElement("article");
    panel.className = "grid-closed";
    const s = SEASONS.find((x) => x.id === selectedSeason);
    let title = "STORE CLOSED";
    let sub = "NEXT DROP TO BE ANNOUNCED.";
    if (s && !isSeasonViewable(s)) {
      title = `${s.label} \u2014 COMING SOON`;
      sub = `UNLOCKS WHEN ITS LAUNCH TIMER EXPIRES.`;
    } else if (selectedSeason === "S01") {
      title = "SEASON 01 HAS ENDED";
      sub = "SEASON 01 IS NOW ARCHIVED \u00b7 VIEW ONLY.";
    }
    panel.innerHTML =
      `<div class="grid-closed__box"><div class="grid-closed__title">${title}</div><p>${sub}</p></div>`;
    grid.appendChild(panel);
    return;
  }

  const s01 = SEASONS.find((x) => x.id === "S01");
  const s01Ended = s01 && seasonState(s01) === "ended";
  const archive = selectedSeason === "S01" && s01Ended;

  list.forEach((beat, i) => {
    const locked = !archive && !isReleased(beat);
    const card = document.createElement("article");
    const isSel = selected.has(beat.id) || exclusiveSelected.has(beat.id);
    card.className =
      "card" +
      (isReleased(beat) ? "" : " card--locked") +
      (isSoldOut(beat) ? " card--sold" : "") +
      (locked ? " card--censored" : "") +
      (archive ? " card--archive" : "") +
      (isSel ? " card--selected" : "");
    card.id = "card-" + beat.id;
    card.innerHTML = cardInner(beat, { locked, archive }, i);
    grid.appendChild(card);
  });
}

function toggle(id, type) {
  const beat = CATALOG.find((b) => b.id === id);
  if (!beat || !isReleased(beat)) return;
  const s = SEASONS.find((x) => x.id === selectedSeason);
  if (s && seasonState(s) === "ended") {
    alert("This season has ended. Catalog is view-only.");
    return;
  }

  if (isSoldOut(beat)) {
    if (type === "exclusive") {
      alert("This beat has already been sold exclusively.");
    } else {
      alert("All leases for this beat have been sold.");
    }
    return;
  }

  if (type === "exclusive") {
    if (exclusiveSelected.has(id)) {
      exclusiveSelected.delete(id);
    } else {
      exclusiveSelected.add(id);
      selected.delete(id);
    }
  } else {
    if (selected.has(id)) {
      selected.delete(id);
    } else {
      selected.add(id);
      exclusiveSelected.delete(id);
    }
  }
  render();
}

function totals() {
  const basicCount = selected.size;
  const exclusiveCount = exclusiveSelected.size;
  const n = basicCount + exclusiveCount;
  const subtotal = basicCount * PRICE + exclusiveCount * EXCLUSIVE_PRICE;
  const freeCount = [...freePicks].filter((id) => selected.has(id)).length;
  const discount = freeCount * PRICE;
  let total = Math.max(0, subtotal - discount);
  if (payAssetSym === "KEN") {
    total = Math.max(0, total * 0.85); // 15% discount modifier for $KEN payments
  }
  return { n, exclusiveN: exclusiveCount, basicCount, exclusiveCount, subtotal, freeCount, discount, total };
}

function render() {
  const { n, subtotal, discount, total } = totals();

  updatePaygridLocks();
  if (n > 0 && payGroup && isGroupBelowMin(payGroup)) {
    const alt = firstAffordableGroup();
    if (alt) selectPayment(alt.value);
    else {
      payGroup = null;
      payAssetSym = null;
      $("payment").value = "";
      document.querySelectorAll(".paygrid__opt").forEach((b) => b.classList.remove("paygrid__opt--on"));
    }
  }

  CATALOG.forEach((b) => {
    if (!isReleased(b) || isSoldOut(b)) return;
    const card = $("card-" + b.id);
    if (!card) return;
    const isLeaseOn = selected.has(b.id);
    const isExclusiveOn = exclusiveSelected.has(b.id);

    card.classList.toggle("card--selected", isLeaseOn || isExclusiveOn);

    const leaseBtn = card.querySelector(".card__btn--lease");
    if (leaseBtn) {
      leaseBtn.classList.toggle("card__btn--active", isLeaseOn);
      leaseBtn.setAttribute("aria-pressed", isLeaseOn ? "true" : "false");
      leaseBtn.innerHTML = isLeaseOn
        ? `LEASE ($${PRICE.toFixed(2)}) <span class="card__btn-check">&check;</span>`
        : `LEASE ($${PRICE.toFixed(2)})`;
    }

    const exclusiveBtn = card.querySelector(".card__btn--exclusive");
    if (exclusiveBtn) {
      exclusiveBtn.classList.toggle("card__btn--active", isExclusiveOn);
      exclusiveBtn.setAttribute("aria-pressed", isExclusiveOn ? "true" : "false");
      exclusiveBtn.innerHTML = isExclusiveOn
        ? `EXCLUSIVE ($${EXCLUSIVE_PRICE.toFixed(2)}) <span class="card__btn-check">&check;</span>`
        : `EXCLUSIVE ($${EXCLUSIVE_PRICE.toFixed(2)})`;
    }
  });

  cartbar.disabled = n === 0;
  $("cartbar-label").textContent =
    n === 0 ? "CART (0)" : `CART (${n}) \u2014 ${money(total)}`;

  $("drawer-count").textContent = n;
  $("t-subtotal").textContent = money(subtotal);
  $("t-discount-row").hidden = discount === 0;
  $("t-discount").textContent = "\u2212" + money(discount);
  $("t-total-usd").textContent = money(total);

  normalizeFreePicks();
  const hint = $("free-hint");
  const cap = freeCap();
  const missing = cap - freePicks.size;
  if (n === 0) {
    hint.hidden = true;
  } else if (selected.size % 3 === 2) {
    hint.hidden = false;
    hint.textContent = "ONE MORE \u2014 YOUR NEXT BEAT COMES FREE.";
  } else if (missing > 0) {
    hint.hidden = false;
    hint.textContent =
      `TAP \u201cMAKE FREE\u201d ON ${missing === 1 ? "THE BEAT" : missing + " BEATS"} YOU WANT \u2014 ${missing === 1 ? "IT'S" : "THEY'RE"} ON US.`;
  } else if (freePicks.size > 0) {
    hint.hidden = false;
    hint.textContent = `FREE BEAT${cap > 1 ? "S" : ""} APPLIED.`;
  } else {
    hint.hidden = true;
  }

  const list = $("cart-items");
  list.innerHTML = "";

  // Basic lease items
  CATALOG.filter((b) => selected.has(b.id)).forEach((b) => {
    const picked = freePicks.has(b.id);
    const li = document.createElement("li");
    if (picked) li.className = "cart-item--free";
    li.innerHTML = `
      <img src="${b.img}" alt="">
      <span class="cart-items__name">${b.title} <span class="cart-items__name-alt">\u2014 ${b.name} (LEASE)</span><span class="cart-items__specs">${specLine(b)} \u2014 ${stockLine(b)}</span></span>
      <span class="cart-items__price${picked ? " cart-items__price--free" : ""}">${picked ? "FREE" : money(PRICE)}</span>
      ${picked ? `<button class="cart-items__free" data-free="${b.id}">REMOVE FREE</button>` : cap > freePicks.size ? `<button class="cart-items__free" data-free="${b.id}">MAKE FREE</button>` : ""}
      <button class="cart-items__remove" data-id="${b.id}" data-type="lease">REMOVE</button>`;
    list.appendChild(li);
  });

  // Exclusive items
  CATALOG.filter((b) => exclusiveSelected.has(b.id)).forEach((b) => {
    const li = document.createElement("li");
    li.className = "cart-item--exclusive";
    li.innerHTML = `
      <img src="${b.img}" alt="">
      <span class="cart-items__name">${b.title} <span class="cart-items__name-alt">\u2014 ${b.name} (EXCLUSIVE)</span><span class="cart-items__specs">${specLine(b)} \u2014 EXCLUSIVE LICENSE</span></span>
      <span class="cart-items__price">${money(EXCLUSIVE_PRICE)}</span>
      <button class="cart-items__remove" data-id="${b.id}" data-type="exclusive">REMOVE</button>`;
    list.appendChild(li);
  });

  $("cart-empty").hidden = n !== 0;

  renderCryptoTotal();
}

function openDrawer() {
  drawer.classList.add("drawer--open");
  drawer.setAttribute("aria-hidden", "false");
  backdrop.hidden = false;
  document.body.style.overflow = "hidden";
  loadMins();
}

const seasonDrawer = $("season-drawer");
const seasonClose = $("season-close");

function openSeasonDrawer() {
  if (!seasonDrawer) return;
  renderSeasonDrawerList();
  seasonDrawer.classList.add("drawer--open");
  seasonDrawer.setAttribute("aria-hidden", "false");
  backdrop.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeSeasonDrawer() {
  if (!seasonDrawer) return;
  seasonDrawer.classList.remove("drawer--open");
  seasonDrawer.setAttribute("aria-hidden", "true");
  if (drawer.getAttribute("aria-hidden") === "true" && seasonDrawer.getAttribute("aria-hidden") === "true") {
    backdrop.hidden = true;
    document.body.style.overflow = "";
  }
}

function closeDrawer() {
  drawer.classList.remove("drawer--open");
  drawer.setAttribute("aria-hidden", "true");
  if (drawer.getAttribute("aria-hidden") === "true" && (!seasonDrawer || seasonDrawer.getAttribute("aria-hidden") === "true")) {
    backdrop.hidden = true;
    document.body.style.overflow = "";
  }
}

function renderSeasonDrawerList() {
  const container = $("season-drawer-list");
  if (!container) return;
  container.innerHTML = "";

  SEASONS.slice().reverse().forEach((s) => {
    const state = seasonState(s);
    const viewable = isSeasonViewable(s);
    const active = s.id === selectedSeason;

    const itemEl = document.createElement("div");
    itemEl.className = "season-drawer-card" + (active ? " season-drawer-card--active" : "");

    let statusText = "LIVE";
    if (state === "ended") statusText = "ENDED (ARCHIVE)";
    else if (state === "upcoming") statusText = `UPCOMING \u00b7 ${seasonBadge(s)}`;

    const isUpcoming = state === "upcoming";
    let savedEmail = "";
    try {
      savedEmail = localStorage.getItem("kencarter_alert_" + s.id) || "";
    } catch (err) {}
    const isSubscribed = !!savedEmail;

    itemEl.innerHTML = `
      <div class="season-drawer-card__header">
        <span class="season-drawer-card__title">${s.label}</span>
        <span class="season-drawer-card__badge season-drawer-card__badge--${state}">${statusText}</span>
      </div>
      <p class="season-drawer-card__desc">
        ${s.id === "S01" ? "Season 01 \u2014 7 Limited Leases ($14.95 each, pick 2 get 1 free). Active until countdown expires." : "Season 02 \u2014 7 Exclusive Beats premiering September 1, 2026."}
      </p>
      ${isUpcoming ? (
        isSubscribed ? `
          <div class="season-alert-subscribed-wrap">
            <button class="season-alert-subscribed-btn" disabled>SUBSCRIBED</button>
            <span class="season-alert-email">${savedEmail}</span>
          </div>
        ` : `
          <form class="season-alert-form" data-season-id="${s.id}">
            <input type="email" class="season-alert-input" placeholder="YOUR@EMAIL.COM" required>
            <button type="submit" class="season-alert-btn">NOTIFY ME</button>
          </form>
        `
      ) : ""}
      <div class="season-drawer-card__actions">
        <button class="btn btn--solid season-drawer-card__btn" data-season="${s.id}" ${!viewable ? "disabled" : ""}>
          ${active ? "CURRENTLY VIEWING" : viewable ? "VIEW SEASON" : "LOCKED / SOON"}
        </button>
      </div>
    `;
    container.appendChild(itemEl);
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let lastOrder = null;

function submitOrder(e) {
  e.preventDefault();

  const emailInput = $("email");
  const errorEl = $("form-error");
  const email = emailInput.value.trim();
  const { n, subtotal, discount, total } = totals();

  errorEl.hidden = true;
  emailInput.classList.remove("invalid");

  if (!EMAIL_RE.test(email)) {
    emailInput.classList.add("invalid");
    errorEl.textContent = "ENTER A VALID EMAIL ADDRESS.";
    errorEl.hidden = false;
    return;
  }

  if (payGroup && isGroupBelowMin(payGroup)) {
    const alt = firstAffordableGroup();
    if (alt) {
      selectPayment(alt.value);
    } else {
      errorEl.textContent = "CART TOTAL IS BELOW THE MINIMUM FOR EVERY SUPPORTED COIN.";
      errorEl.hidden = false;
      return;
    }
  }

  if (!CATALOG.length) {
    errorEl.textContent = "THE STORE IS CURRENTLY CLOSED \u2014 NEXT DROP TO BE ANNOUNCED.";
    errorEl.hidden = false;
    return;
  }

  const chosen = CATALOG.filter((b) => selected.has(b.id));
  const exclusiveChosen = CATALOG.filter((b) => exclusiveSelected.has(b.id));

  const items = [
    ...chosen.map((b) => ({ id: b.id, title: b.title, type: "lease" })),
    ...exclusiveChosen.map((b) => ({ id: b.id, title: b.title, type: "exclusive" }))
  ];

  const labeled = [
    ...chosen.map((b) => `${b.title} LEASE${freePicks.has(b.id) ? " (FREE)" : ""}`),
    ...exclusiveChosen.map((b) => `${b.title} EXCLUSIVE`)
  ];

  lastOrder = {
    email,
    group: payGroup,
    labeled,
    freeTitles: chosen.filter((b) => freePicks.has(b.id)).map((b) => b.title),
    subtotal,
    discount,
    total,
    items,
    exclusivePicks: exclusiveChosen.map((b) => b.id),
    exclusiveTitles: exclusiveChosen.map((b) => b.title),
    walletAddress: connectedWalletAddress || null
  };

  finishOrder();
}

function finishOrder() {
  selected.clear();
  exclusiveSelected.clear();
  freePicks.clear();
  render();
  closeDrawer();
  showPayscreen(lastOrder);
}

const payscreen = $("payscreen");

let payScreenOrder = null;
let payScreenSym = null;

let npPayment = null;
let npPollTimer = null;

const NP_STATUS_COPY = {
  waiting: "WAITING FOR YOUR PAYMENT",
  confirming: "CONFIRMING ON BLOCKCHAIN",
  confirmed: "PAYMENT VERIFIED \u2014 FILES UNLOCKED",
  sending: "PAYMENT VERIFIED \u2014 FILES UNLOCKED",
  finished: "PAYMENT VERIFIED \u2014 FILES UNLOCKED",
  partially_paid: "UNDERPAID \u2014 SEND THE MISSING AMOUNT",
  failed: "PAYMENT FAILED \u2014 PICK ANOTHER COIN TO RETRY",
  refunded: "PAYMENT REFUNDED",
  expired: "PAYMENT EXPIRED \u2014 PICK ANOTHER COIN TO RETRY",
  exclusive: "EXCLUSIVE MASTER RIGHTS — BEAT RETIRED FROM CATALOG"
};

function setNpStatus(text, mode) {
  const el = $("np-status");
  if (!el) return;
  el.textContent = text;
  const cls = ["np-status"];
  if (mode) cls.push("np-status--" + mode);
  if (mode === "ok" || mode === "exclusive") cls.push("visible");
  el.className = cls.join(" ");
}

async function workerRequest(path, opts = {}) {
  if (!WORKER_URL) throw new Error("WORKER URL NOT CONFIGURED \u2014 SEE TOP OF SCRIPT.JS");
  const res = await fetch(WORKER_URL.replace(/\/+$/, "") + path, Object.assign({}, opts, {
    headers: Object.assign({ "Content-Type": "application/json" }, opts.headers || {})
  }));
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error((data && data.error) || "CHECKOUT ERROR " + res.status);
  return data;
}

function npOrderId() {
  return "KC-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
}

let npMins = null;

const isBelowMinSym = (sym, usdTotal) =>
  !!npMins && typeof npMins[sym] === "number" && usdTotal < npMins[sym];

async function loadMins() {
  try {
    const syms = Object.keys(ASSETS).join(",");
    const d = await workerRequest("/api/mins?coins=" + encodeURIComponent(syms));
    npMins = d.mins || null;
    refreshChipLocks();
    updatePaygridLocks();
  } catch {}
}

const isBelowMin = (sym) => isBelowMinSym(sym, payScreenOrder ? payScreenOrder.total : 0);

function showMinAlert(sym) {
  const el = $("payscreen-alert");
  if (el) {
    const name = (ASSETS[sym] || {}).name || sym;
    el.textContent = `Minimum purchase for ${name} is higher due to network fees. Please select USDT/USDC or Litecoin instead.`;
    el.hidden = false;
  }
  appendFallbackChips();
}

function buildCoinChip(sym) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "payscreen__tab";
  b.textContent = sym;
  b.dataset.sym = sym;
  b.addEventListener("click", () => {
    if (b.disabled || b.classList.contains("payscreen__tab--off") || isBelowMin(sym)) return;
    startNpPayment(sym);
  });
  return b;
}

function refreshChipLocks() {
  if (!npMins || !payScreenOrder) return;
  document.querySelectorAll(".payscreen__tab").forEach((b) => {
    const blocked = isBelowMin(b.dataset.sym);
    b.classList.toggle("payscreen__tab--off", blocked);
    b.disabled = blocked;
    if (blocked) {
      b.setAttribute("aria-disabled", "true");
      b.title = `MINIMUM ~${money(npMins[b.dataset.sym])} FOR THIS COIN`;
    } else {
      b.removeAttribute("aria-disabled");
      b.title = "";
    }
  });
  const active = document.querySelector(".payscreen__tab--on");
  if (active && active.classList.contains("payscreen__tab--off")) showMinAlert(active.dataset.sym);
}

function isGroupBelowMin(group) {
  const { n, total } = totals();
  if (!npMins || n === 0) return false;
  return group.assets.every((s) => isBelowMinSym(s, total));
}

function firstAffordableGroup(excludeValue) {
  return (
    PAYMENT_GROUPS.find((g) => g.value !== excludeValue && !isGroupBelowMin(g)) || null
  );
}

function updatePaygridLocks() {
  const { n, total } = totals();
  const enforce = n > 0 && !!npMins;
  document.querySelectorAll(".paygrid__opt").forEach((b) => {
    const group = PAYMENT_GROUPS.find((g) => g.value === b.dataset.value);
    if (!group) return;
    const blocked =
      enforce &&
      npMins &&
      group.assets.every((s) => typeof npMins[s] === "number" && total < npMins[s]);
    b.classList.toggle("paygrid__opt--off", blocked);
    b.disabled = blocked;
    if (blocked) {
      const cheapest = Math.min(
        ...group.assets.map((s) => npMins[s]).filter(Number.isFinite)
      );
      b.setAttribute("aria-disabled", "true");
      b.title = `MINIMUM ~${money(cheapest)} FOR THIS METHOD \u2014 NETWORK FEES`;
    } else {
      b.removeAttribute("aria-disabled");
      b.title = "";
    }
  });
}

function appendFallbackChips() {
  const tabs = $("payscreen-tabs");
  tabs.hidden = false;
  FALLBACK_SYMS.forEach((sym) => {
    if (!tabs.querySelector(`[data-sym="${sym}"]`)) tabs.appendChild(buildCoinChip(sym));
  });
  refreshChipLocks();
}

async function startNpPayment(sym) {
  const asset = ASSETS[sym];
  if (!asset || !payScreenOrder) return;
  payScreenSym = sym;
  markActiveTab(sym);
  stopNpPolling();
  npPayment = null;
  $("payscreen-payblock").hidden = true;
  $("payscreen-downloads-wrap").hidden = true;
  setNpStatus("GENERATING SECURE " + asset.sym + " ADDRESS\u2026");

  try {
    npPayment = await workerRequest("/api/checkout", {
      method: "POST",
      body: JSON.stringify({
        order_id: npPayment && npPayment.order_id,
        email: payScreenOrder.email,
        coinSym: sym,
        total: payScreenOrder.total,
        labeled: payScreenOrder.labeled,
        freeTitles: payScreenOrder.freeTitles || [],
        subtotal: payScreenOrder.subtotal,
        discount: payScreenOrder.discount,
        items: payScreenOrder.items,
        exclusivePicks: payScreenOrder.exclusivePicks || [],
        walletAddress: payScreenOrder.walletAddress || null
      })
    });
    const alertEl = $("payscreen-alert");
    if (alertEl) alertEl.hidden = true;
    renderNpPayment();
    startNpPolling(String(npPayment.order_id));
  } catch (err) {
    console.error("Checkout failed:", err);
    const msg = String((err && err.message) || "");
    if (/less than minimal|minimum|minimal/i.test(msg)) {
      showMinAlert(sym);
      setNpStatus("AMOUNT BELOW " + sym + " MINIMUM \u2014 PICK ANOTHER COIN", "warn");
    } else {
      setNpStatus(msg.toUpperCase() || "CHECKOUT ERROR \u2014 PICK A COIN TO RETRY", "warn");
    }
  }
}

function renderNpPayment() {
  if (!npPayment) return;
  $("payscreen-equiv").textContent = `${npPayment.pay_amount} ${String(npPayment.pay_currency).toUpperCase()}`;
  $("payscreen-network").textContent = "SEND VIA SOLANA NETWORK";
  $("payscreen-address").textContent = npPayment.pay_address;
  $("payscreen-payblock").hidden = false;
  const btn = $("copy-address");
  btn.disabled = false;
  btn.textContent = "COPY ADDRESS";
}

function startNpPolling(orderId) {
  stopNpPolling();
  npPollTimer = setInterval(async () => {
    try {
      const s = await workerRequest("/api/status?order_id=" + encodeURIComponent(orderId));
      if (s.released) {
        stopNpPolling();
        const hasExclusive = s.links && s.links.some((l) => l.isExclusive);
        setNpStatus(
          hasExclusive ? NP_STATUS_COPY.exclusive : NP_STATUS_COPY.finished,
          hasExclusive ? "exclusive" : "ok"
        );
        revealDownloads(s.links || []);
        return;
      }
      const st = String(s.status || "").toLowerCase();
      if (["confirmed", "sending", "finished"].includes(st)) {
        setNpStatus("PAYMENT CONFIRMED \u2014 RELEASING FILES\u2026", "warn");
      } else {
        const mode = st === "waiting" ? undefined : "warn";
        setNpStatus(NP_STATUS_COPY[st] || st.toUpperCase(), mode);
        if (["failed", "refunded", "expired"].includes(st)) stopNpPolling();
      }
    } catch {}
  }, 5000);
}

function stopNpPolling() {
  if (npPollTimer) {
    clearInterval(npPollTimer);
    npPollTimer = null;
  }
}

function showPayscreen(order) {
  if (!order || !payscreen) return;
  payScreenOrder = order;
  $("payscreen-total").textContent = money(order.total);
  const tabs = $("payscreen-tabs");
  tabs.innerHTML = "";
  const syms = order.group ? order.group.assets : ["USDT"];
  syms.forEach((sym) => tabs.appendChild(buildCoinChip(sym)));
  tabs.hidden = syms.length < 2;
  prepDownloads();
  payscreen.hidden = false;
  document.body.style.overflow = "hidden";
  selectInitialCoin(syms);
}

async function selectInitialCoin(syms) {
  setNpStatus("CHECKING NETWORK MINIMUMS\u2026");
  await loadMins();
  const available = syms.filter((s) => !isBelowMin(s));
  if (!available.length) {
    showMinAlert(syms[0]);
    setNpStatus("AMOUNT BELOW MINIMUM \u2014 PICK A SUPPORTED COIN", "warn");
    return;
  }
  startNpPayment(available[0]);
}

function prepDownloads() {
  $("payscreen-downloads-wrap").hidden = true;
  $("payscreen-downloads").innerHTML = "";
}

function revealDownloads(links) {
  const list = $("payscreen-downloads");
  list.innerHTML = "";
  const hasExclusive = links && links.some((l) => l.isExclusive);
  (links || []).forEach((it) => {
    const a = document.createElement("a");
    a.className = "payscreen__dl";
    a.href = it.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `DOWNLOAD ${it.title}`;
    list.appendChild(a);
  });
  if (hasExclusive) {
    const a = document.createElement("a");
    a.className = "payscreen__dl";
    a.href = "EXCLUSIVE_LICENSE.txt";
    a.download = "EXCLUSIVE_LICENSE.txt";
    a.textContent = "DOWNLOAD EXCLUSIVE LICENSE";
    list.appendChild(a);
  } else if (links && links.length) {
    const a = document.createElement("a");
    a.className = "payscreen__dl";
    a.href = "LICENSE.txt";
    a.download = "LICENSE.txt";
    a.textContent = "DOWNLOAD LICENSE";
    list.appendChild(a);
  }
  if (links && links.length) $("payscreen-downloads-wrap").hidden = false;
}

function markActiveTab(sym) {
  document.querySelectorAll(".payscreen__tab").forEach((b) => {
    b.classList.toggle("payscreen__tab--on", b.dataset.sym === sym);
  });
}

async function copyPayAddress() {
  const addr = npPayment && npPayment.pay_address;
  if (!addr) return;
  try {
    await navigator.clipboard.writeText(addr);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = addr;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const btn = $("copy-address");
  btn.disabled = true;
  btn.textContent = "COPIED";
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "COPY ADDRESS";
  }, 1600);
}

function hidePayscreen() {
  if (!payscreen || payscreen.hidden) return false;
  stopNpPolling();
  payscreen.hidden = true;
  payScreenOrder = null;
  payScreenSym = null;
  npPayment = null;
  document.body.style.overflow = "";
  return true;
}

function resetDrawer() {
  $("email").value = "";
  $("payment").value = "";
  document.querySelectorAll(".paygrid__opt").forEach((b) => {
    b.classList.remove("paygrid__opt--on");
    b.setAttribute("aria-checked", "false");
  });
  $("paygrid").classList.remove("invalid");
  closeDrawer();
  closeSeasonDrawer();
}

let currentPhase = null;

function rebuildCatalog() {
  CATALOG = catalogFor(selectedSeason);
  buildGrid();
  render();
}

function updateBrandSeasonLabel() {
  const lbl = $("brand-season-label");
  if (!lbl) return;
  const s = SEASONS.find((x) => x.id === selectedSeason);
  lbl.textContent = s ? s.label : "SEASON 01";
}

function setSeason(season) {
  const s = SEASONS.find((x) => x.id === season);
  if (!s) return;
  // Upcoming seasons remain locked/hidden until their launch — no access.
  if (!isSeasonViewable(s)) return;
  if (season !== selectedSeason) {
    selected.clear();
    exclusiveSelected.clear();
    freePicks.clear();
  }
  selectedSeason = season;
  updateBrandSeasonLabel();
  rebuildCatalog();
}

function applyPhase(force = false) {
  const p = storePhase();
  if (!force && p === currentPhase) return;
  const leavingS01 = currentPhase === "S01" && p !== "S01";
  currentPhase = p;
  if (leavingS01 || p === "GAP" || p === "POST") {
    selected.clear();
    exclusiveSelected.clear();
    freePicks.clear();
  }
  render();
}

function checkSeason2ExpiryNotification(now = Date.now()) {
  const closeTime = Date.parse(S02_CLOSE_AT);
  if (now >= closeTime) {
    try {
      const email = localStorage.getItem("kencarcer_alert_S02");
      const alreadyNotified = localStorage.getItem("kencarcer_notified_S02");
      if (email && !alreadyNotified) {
        localStorage.setItem("kencarcer_notified_S02", "true");
        if (WORKER_URL) {
          fetch(WORKER_URL.replace(/\/+$/, "") + "/api/notify-closure", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ season: "S02", email })
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error("Season 2 expiry notification error:", err);
    }
  }
}

function storeTick() {
  applyPhase();
  tickSeason();
  tickS02();
  tickBeatCountdowns();
  checkSeason2ExpiryNotification();
}

buildTicker();
buildPaygrid();
selectedSeason = defaultSeason();
updateBrandSeasonLabel();
rebuildCatalog();
currentPhase = storePhase();
storeTick();
render();
storeTimer = setInterval(storeTick, 1000);
startBtc();
loadMins();

if (!WORKER_URL) $("config-warning").hidden = false;

cartbar.addEventListener("click", openDrawer);
$("close").addEventListener("click", resetDrawer);
backdrop.addEventListener("click", resetDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const walletModal = $("wallet-modal");
  if (walletModal && !walletModal.hidden) {
    walletModal.hidden = true;
    document.body.style.overflow = "";
    return;
  }
  if (hidePayscreen()) window.scrollTo({ top: 0 });
  else resetDrawer();
});
$("cart-items").addEventListener("click", (e) => {
  const free = e.target.closest(".cart-items__free");
  if (free) {
    toggleFreePick(free.dataset.free);
    return;
  }
  const btn = e.target.closest(".cart-items__remove");
  if (btn) {
    const id = btn.dataset.id;
    const type = btn.dataset.type;
    if (type === "exclusive") {
      exclusiveSelected.delete(id);
    } else {
      selected.delete(id);
      freePicks.delete(id);
    }
    render();
  }
});
$("order-form").addEventListener("submit", submitOrder);
$("payscreen-close").addEventListener("click", () => {
  hidePayscreen();
  resetDrawer();
  window.scrollTo({ top: 0 });
});
$("copy-address").addEventListener("click", copyPayAddress);

grid.addEventListener("click", (e) => {
  const btn = e.target.closest(".card__btn");
  if (!btn || btn.disabled) return;
  toggle(btn.dataset.id, btn.dataset.type);
});

const brandBtn = $("brand-season-btn");
if (brandBtn) {
  brandBtn.addEventListener("click", openSeasonDrawer);
}

if (seasonClose) {
  seasonClose.addEventListener("click", closeSeasonDrawer);
}

const seasonDrawerList = $("season-drawer-list");
if (seasonDrawerList) {
  seasonDrawerList.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-season]");
    if (!btn || btn.disabled) return;
    const seasonId = btn.dataset.season;
    setSeason(seasonId);
    closeSeasonDrawer();
  });

  seasonDrawerList.addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target.closest(".season-alert-form");
    if (!form) return;
    const input = form.querySelector(".season-alert-input");
    const seasonId = form.dataset.seasonId;
    const email = input ? input.value.trim() : "";

    if (!EMAIL_RE.test(email)) {
      alert("Please enter a valid email address.");
      return;
    }

    try {
      if (seasonId) {
        localStorage.setItem("kencarter_alert_" + seasonId, email);
      }
    } catch (err) {
      console.error("Local storage error:", err);
    }

    renderSeasonDrawerList();
  });
}

const notifyLink = $("header-notify-link");
if (notifyLink) {
  notifyLink.addEventListener("click", () => {
    openSeasonDrawer();
    setTimeout(() => {
      const s2Card = document.querySelector('.season-alert-form[data-season-id="S02"]');
      if (s2Card) {
        s2Card.scrollIntoView({ behavior: "smooth", block: "center" });
        const input = s2Card.querySelector(".season-alert-input");
        if (input && !input.disabled) {
          input.focus();
        }
      }
    }, 250);
  });
}

const walletModal = $("wallet-modal");
const walletModalClose = $("wallet-modal-close");
const walletModalTitle = $("wallet-modal-title");
const walletModalDesc = $("wallet-modal-desc");
const walletModalSub = $("wallet-modal-sub");
const walletSelectList = $("wallet-select-list");
const walletInlineState = $("wallet-inline-state");

async function disconnectWalletSession() {
  window._forceDisconnected = true;
  connectedWalletAddress = null;
  isKenHolder = false;
  try {
    localStorage.clear();
    localStorage.setItem("ken_user_logged_out", "true");
    localStorage.setItem("ken_disconnected", "true");
    localStorage.setItem("kencarter_user_disconnected", "true");
    if (window.solana && typeof window.solana.disconnect === "function") {
      await window.solana.disconnect();
    }
    if (window.solflare && typeof window.solflare.disconnect === "function") {
      await window.solflare.disconnect();
    }
    if (window.phantom?.solana && typeof window.phantom.solana.disconnect === "function") {
      await window.phantom.solana.disconnect();
    }
  } catch (err) {
    console.error("Disconnect cleanup error:", err);
  }

  const btnText = $("wallet-btn-text");
  if (btnText) btnText.textContent = "CONNECT WALLET (KEN)";
  const walletBtnEl = $("wallet-btn");
  if (walletBtnEl) walletBtnEl.classList.remove("wallet-btn--holder");
  rebuildCatalog();
  render();
  openWalletModal();
}

function openWalletModal() {
  if (!walletModal) return;
  if (
    localStorage.getItem("ken_user_logged_out") === "true" ||
    localStorage.getItem("ken_disconnected") === "true" ||
    localStorage.getItem("kencarter_user_disconnected") === "true"
  ) {
    window._forceDisconnected = true;
  }
  if (window._forceDisconnected) {
    connectedWalletAddress = null;
    isKenHolder = false;
  }

  if (walletModalTitle) walletModalTitle.textContent = "CONNECT SOLANA WALLET";
  if (walletModalDesc) walletModalDesc.textContent = "Connect your wallet to verify KEN holdings and unlock your 15% discount & automated cashback.";
  if (walletModalSub) walletModalSub.hidden = false;
  if (walletSelectList) {
    walletSelectList.hidden = false;
    walletSelectList.innerHTML = `
      <button class="wallet-option-btn" id="connect-phantom-btn" type="button">
        <span class="wallet-option-icon"><img src="assets/images/phantom.svg?v=3" alt="Phantom" width="18" height="18" style="display:block; width:18px; height:18px;" /></span>
        <span class="wallet-option-text">CONNECT PHANTOM</span>
      </button>
      <button class="wallet-option-btn" id="connect-solflare-btn" type="button">
        <span class="wallet-option-icon"><img src="assets/images/solflare.svg?v=3" alt="Solflare" width="18" height="18" style="display:block; width:18px; height:18px;" /></span>
        <span class="wallet-option-text">CONNECT SOLFLARE</span>
      </button>
    `;

    const phantomBtn = $("connect-phantom-btn");
    const solflareBtn = $("connect-solflare-btn");

    if (phantomBtn) phantomBtn.addEventListener("click", () => connectSolanaWallet(null, "phantom"));
    if (solflareBtn) solflareBtn.addEventListener("click", () => connectSolanaWallet(null, "solflare"));
  }
  if (walletInlineState) {
    walletInlineState.hidden = true;
    walletInlineState.innerHTML = "";
  }
  walletModal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeWalletModal() {
  if (!walletModal) return;
  walletModal.hidden = true;
  document.body.style.overflow = "";
}

async function connectSolanaWallet(e, walletType = "phantom") {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }

  localStorage.removeItem("ken_user_logged_out");
  localStorage.removeItem("ken_disconnected");
  localStorage.removeItem("kencarter_user_disconnected");
  window._forceDisconnected = false;

  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const currentUrl = window.location.href;
  const encodedUrl = encodeURIComponent(currentUrl);

  let provider = null;
  if (walletType === "solflare") {
    provider = window.solflare || window.solana;
    if (!provider && isMobile) {
      window.location.href = `https://solflare.com/ul/v1/browse/${encodedUrl}`;
      return;
    }
  } else {
    provider = window.phantom?.solana || window.solana;
    if (!provider && isMobile) {
      window.location.href = `https://phantom.app/ul/browse/${encodedUrl}?ref=${encodedUrl}`;
      return;
    }
  }

  if (!provider) {
    const installUrl = walletType === "solflare" ? "https://solflare.com/download" : "https://phantom.app/download";
    window.open(installUrl, "_blank");
    return;
  }

  if (walletModalSub) walletModalSub.hidden = true;
  if (walletModalTitle) walletModalTitle.textContent = "CONNECTING";
  if (walletModalDesc) walletModalDesc.textContent = "Approving connection with your Solana wallet…";
  if (walletSelectList) walletSelectList.hidden = true;
  if (walletInlineState) {
    walletInlineState.innerHTML = `<div class="wallet-loading-spinner"></div>`;
    walletInlineState.hidden = false;
  }

  const btnText = $("wallet-btn-text");

  try {
    const res = await provider.connect({ onlyIfTrusted: false });
    const pubKey = (res && res.publicKey) ? res.publicKey.toString() : (provider.publicKey ? provider.publicKey.toString() : null);
    if (!pubKey) {
      throw new Error("Failed to extract public key from connected wallet.");
    }
    connectedWalletAddress = pubKey;

    if (walletModalTitle) walletModalTitle.textContent = "VERIFYING KEN";
    if (walletModalDesc) walletModalDesc.textContent = "Scanning Solana network for token balance (HEFkC6WQo3jTv39B6JhYQJ3ZW8xKxRELaWdnirdSpump)…";

    const verification = await workerRequest("/api/verify-ken", {
      method: "POST",
      body: JSON.stringify({
        walletAddress: pubKey,
        mint: "HEFkC6WQo3jTv39B6JhYQJ3ZW8xKxRELaWdnirdSpump"
      })
    });

    if (verification && verification.holder) {
      isKenHolder = true;
      if (btnText) btnText.textContent = `KEN HOLDER ✓ (${verification.balance.toLocaleString()} KEN)`;
      const walletBtnEl = $("wallet-btn");
      if (walletBtnEl) walletBtnEl.classList.add("wallet-btn--holder");

      if (walletModalTitle) walletModalTitle.textContent = "VERIFIED HOLDER";
      if (walletModalDesc) walletModalDesc.textContent = "KEN token balance confirmed on-chain.";
      if (walletInlineState) {
        walletInlineState.innerHTML = `
          <div style="text-align: center; padding: 12px;">
            <div style="font-size: 32px; font-weight: 700; color: #fff; margin: 6px auto 8px auto;">✓</div>
            <p style="margin-top: 4px; font-size: 11px; font-weight: 800; letter-spacing: 0.1em; color: #fff;">15% DISCOUNT &amp; VIP PERKS UNLOCKED</p>
          </div>
        `;
        walletInlineState.hidden = false;
      }

      setTimeout(() => {
        closeWalletModal();
      }, 1200);
    } else {
      isKenHolder = false;
      if (btnText) btnText.textContent = `${pubKey.slice(0, 4)}…${pubKey.slice(-4)} (CONNECTED)`;

      if (walletModalTitle) walletModalTitle.textContent = "KEN TOKEN REQUIRED";
      if (walletModalDesc) walletModalDesc.textContent = "Wallet connected successfully, but no KEN tokens were detected.";
      if (walletInlineState) {
        walletInlineState.innerHTML = `
          <div style="border: 1px solid #333; padding: 16px; background: #0d0d0d; color: #fff; text-align: center;">
            <p style="margin-bottom: 8px; font-weight: 700; font-size: 11px; letter-spacing: 0.08em;">ACQUIRE KEN TO UNLOCK VIP PERKS</p>
            <p style="margin-bottom: 14px; color: #888888; font-size: 10px; line-height: 1.5;">Hold KEN to activate your 15% lease discount, automated cashback, and Season 2 early access.</p>
            <a href="https://pump.fun/coin/HEFkC6WQo3jTv39B6JhYQJ3ZW8xKxRELaWdnirdSpump" target="_blank" rel="noopener noreferrer" class="payscreen__dl" style="display: block; text-decoration: none; background: #fff; color: #000; border-color: #fff; padding: 12px; font-weight: 800; font-size: 11px; text-transform: uppercase; margin-bottom: 10px;">BUY KEN ON PUMP.FUN &rarr;</a>
            <button type="button" id="check-balance-btn" class="payscreen__dl" style="width: 100%; background: #1a1a1a; color: #fff; border: 1px solid #333; padding: 12px; font-weight: 800; font-size: 11px; text-transform: uppercase; cursor: pointer; margin-bottom: 10px;">CHECK BALANCE / I'VE BOUGHT KEN</button>
            <button type="button" id="switch-wallet-btn" style="display: block; width: 100%; background: transparent; color: #888888; border: none; font-family: inherit; font-size: 11px; font-weight: 700; cursor: pointer; text-decoration: underline; padding: 6px;">HOW TO SWITCH WALLET / DISCONNECT?</button>
            <div id="disconnect-guide" hidden style="margin-top: 10px; padding: 14px; background: #141414; border: 1px solid #333; font-size: 11px; color: #ccc; line-height: 1.7; text-align: left; direction: ltr;">
              To switch or disconnect your wallet: click on your Phantom or Solflare extension icon in your browser toolbar, go to Settings &gt; Connected Apps, and disconnect this site.
            </div>
          </div>
        `;
        walletInlineState.hidden = false;
        const checkBtn = $("check-balance-btn");
        if (checkBtn) {
          checkBtn.addEventListener("click", () => recheckKenBalance(pubKey));
        }
        const switchBtn = $("switch-wallet-btn");
        const guideBox = $("disconnect-guide");
        if (switchBtn && guideBox) {
          switchBtn.addEventListener("click", () => {
            guideBox.hidden = !guideBox.hidden;
          });
        }
      }
    }
    rebuildCatalog();
    render();
  } catch (err) {
    console.error("Wallet connection error:", err);
    openWalletModal();
  }
}

async function recheckKenBalance(pubKey) {
  if (walletModalTitle) walletModalTitle.textContent = "RE-SCANNING KEN";
  if (walletModalDesc) walletModalDesc.textContent = "Checking blockchain for updated token balance…";
  if (walletSelectList) walletSelectList.hidden = true;
  if (walletInlineState) {
    walletInlineState.innerHTML = `<div class="wallet-loading-spinner" style="margin: 20px auto;"></div>`;
    walletInlineState.hidden = false;
  }

  try {
    const verification = await workerRequest("/api/verify-ken", {
      method: "POST",
      body: JSON.stringify({
        walletAddress: pubKey,
        mint: "HEFkC6WQo3jTv39B6JhYQJ3ZW8xKxRELaWdnirdSpump"
      })
    });

    const btnText = $("wallet-btn-text");
    if (verification && verification.holder) {
      isKenHolder = true;
      if (btnText) btnText.textContent = `KEN HOLDER ✓ (${verification.balance.toLocaleString()} KEN)`;
      const walletBtnEl = $("wallet-btn");
      if (walletBtnEl) walletBtnEl.classList.add("wallet-btn--holder");

      if (walletModalTitle) walletModalTitle.textContent = "VERIFIED HOLDER";
      if (walletModalDesc) walletModalDesc.textContent = "KEN token balance confirmed on-chain.";
      if (walletInlineState) {
        walletInlineState.innerHTML = `
          <div style="text-align: center; padding: 12px;">
            <div style="font-size: 32px; font-weight: 700; color: #fff; margin: 6px auto 8px auto;">✓</div>
            <p style="margin-top: 4px; font-size: 11px; font-weight: 800; letter-spacing: 0.1em; color: #fff;">15% DISCOUNT &amp; VIP PERKS UNLOCKED</p>
          </div>
        `;
        walletInlineState.hidden = false;
      }

      setTimeout(() => {
        closeWalletModal();
      }, 1200);
    } else {
      isKenHolder = false;
      if (walletModalTitle) walletModalTitle.textContent = "KEN TOKEN REQUIRED";
      if (walletModalDesc) walletModalDesc.textContent = "Still no KEN tokens detected in this wallet.";
      if (walletInlineState) {
        walletInlineState.innerHTML = `
          <div style="border: 1px solid #333; padding: 16px; background: #0d0d0d; color: #fff; text-align: center;">
            <p style="margin-bottom: 8px; font-weight: 700; font-size: 11px; letter-spacing: 0.08em; color: #ff4444;">BALANCE NOT DETECTED YET</p>
            <p style="margin-bottom: 14px; color: #888888; font-size: 10px; line-height: 1.5;">Ensure your purchase has settled on-chain, then click again.</p>
            <a href="https://pump.fun/coin/HEFkC6WQo3jTv39B6JhYQJ3ZW8xKxRELaWdnirdSpump" target="_blank" rel="noopener noreferrer" class="payscreen__dl" style="display: block; text-decoration: none; background: #fff; color: #000; border-color: #fff; padding: 12px; font-weight: 800; font-size: 11px; text-transform: uppercase; margin-bottom: 10px;">BUY KEN ON PUMP.FUN &rarr;</a>
            <button type="button" id="check-balance-btn" class="payscreen__dl" style="width: 100%; background: #1a1a1a; color: #fff; border: 1px solid #333; padding: 12px; font-weight: 800; font-size: 11px; text-transform: uppercase; cursor: pointer; margin-bottom: 10px;">CHECK BALANCE / I'VE BOUGHT KEN</button>
            <button type="button" id="switch-wallet-btn" style="display: block; width: 100%; background: transparent; color: #888888; border: none; font-family: inherit; font-size: 11px; font-weight: 700; cursor: pointer; text-decoration: underline; padding: 6px;">HOW TO SWITCH WALLET / DISCONNECT?</button>
            <div id="disconnect-guide" hidden style="margin-top: 10px; padding: 14px; background: #141414; border: 1px solid #333; font-size: 11px; color: #ccc; line-height: 1.7; text-align: left; direction: ltr;">
              To switch or disconnect your wallet: click on your Phantom or Solflare extension icon in your browser toolbar, go to Settings &gt; Connected Apps, and disconnect this site.
            </div>
          </div>
        `;
        walletInlineState.hidden = false;
        const checkBtn = $("check-balance-btn");
        if (checkBtn) {
          checkBtn.addEventListener("click", () => recheckKenBalance(pubKey));
        }
        const switchBtn = $("switch-wallet-btn");
        const guideBox = $("disconnect-guide");
        if (switchBtn && guideBox) {
          switchBtn.addEventListener("click", () => {
            guideBox.hidden = !guideBox.hidden;
          });
        }
      }
    }
    rebuildCatalog();
    render();
  } catch (err) {
    console.error("Recheck balance error:", err);
    if (walletModalTitle) walletModalTitle.textContent = "VERIFICATION FAILED";
    if (walletModalDesc) walletModalDesc.textContent = err.message || "Failed to query network.";
  }
}

const walletBtn = $("wallet-btn");
if (walletBtn) {
  walletBtn.addEventListener("click", openWalletModal);
}

if (walletModalClose) {
  walletModalClose.addEventListener("click", closeWalletModal);
}

if (walletModal) {
  walletModal.addEventListener("click", (e) => {
    if (e.target === walletModal) closeWalletModal();
  });
  const connectActionBtn = $("connect-wallet-action");
  if (connectActionBtn) {
    connectActionBtn.addEventListener("click", connectSolanaWallet);
  }
}
