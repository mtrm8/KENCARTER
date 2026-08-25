// Cloudflare Worker backend — performs every NOWPayments call, holds the
// download URLs, and dispatches the delivery email after an HMAC-verified
// 'finished' IPN. Nothing order-related is submitted from this file.
const WORKER_URL = "https://kencarter-checkout.kencarter-store.workers.dev";

const PRICE = 14.95;
const LOW_STOCK_AT = 3;

// Details sourced from the "Beat Covers" folder: BEAT XX (NAME) - BPM - KEY.
// leases = total leases available for the beat, left = leases still on sale.
// NOTHING SOLD YET — every beat starts at full stock. After an order comes in,
// drop `left` by the number sold; set left:0 (or soldOut:true) to archive it.
//
// ORDERING: the grid is sorted automatically — NEWEST BEATS AT THE TOP,
// OLDEST AT THE BOTTOM (highest "01 OF 07" tag number first). Sold-out beats
// sink below the live catalog as an archive, also newest first. To release a
// new beat just append it to the END of this array as BEAT 08, 09, ... and
// it appears at the top of the grid on its own. Numbers are derived from this
// array's order, so they stay permanent per beat.
const LEASES_PER_BEAT = 10;

const BEATS = [
  { id: "beat1", title: "BEAT 01", name: "CH\u00a3$$",          img: "assets/beat1.jpg?v=2", bpm: 140, key: "E MIN",  tag: "SEASON 01", leases: LEASES_PER_BEAT },
  { id: "beat2", title: "BEAT 02", name: "AnGeLL",             img: "assets/beat2.jpg?v=2", bpm: 75,  key: "G# MIN", tag: "SEASON 01", leases: LEASES_PER_BEAT },
  { id: "beat3", title: "BEAT 03", name: "DIAMONS IN THE BAG", img: "assets/beat3.jpg?v=2", bpm: 130, key: "A# MIN", tag: "SEASON 01", leases: LEASES_PER_BEAT },
  { id: "beat4", title: "BEAT 04", name: "$$$",                img: "assets/beat4.jpg?v=2", bpm: 140, key: "G MIN",  tag: "SEASON 01", leases: LEASES_PER_BEAT },
  { id: "beat5", title: "BEAT 05", name: "HIGH VIEW",          img: "assets/beat5.jpg?v=2", bpm: 168, key: "C MIN",  tag: "SEASON 01", leases: LEASES_PER_BEAT },
  { id: "beat6", title: "BEAT 06", name: "PROTOCOL",           img: "assets/beat6.jpg?v=2", bpm: 135, key: "G# MIN", tag: "SEASON 01", leases: LEASES_PER_BEAT },
  { id: "beat7", title: "BEAT 07", name: "LAST SEAT",          img: "assets/beat7.jpg?v=2", bpm: 140, key: "G# MIN", tag: "SEASON 01", releaseAt: "2026-08-23T20:00:00", leases: LEASES_PER_BEAT }
].map((b) => ({ ...b, left: b.left ?? b.leases }));

const TICKER_TEXT = "KEN CARTER \u2014 SEASON 01 IS LIVE \u2014 STRICTLY LIMITED LEASES \u2014 ALL BEATS $14.95 \u2014 PICK 2, GET 1 FREE \u2014 ";

// Official closing of SEASON 01 (7 days out). When this passes, the season
// banner timer expires and the season locks.
const SEASON_END_AT = "2026-09-01T20:00:00";

const money = (n) => "$" + n.toFixed(2);

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

const releaseDate = (b) => (b.releaseAt ? new Date(b.releaseAt) : null);
const isReleased = (b) => !b.releaseAt || Date.now() >= releaseDate(b).getTime();
const isSoldOut = (b) => b.soldOut || b.left <= 0;

// Grid order: live catalog newest-first, then the sold-out archive newest-first.
const byNewest = (a, b) => BEATS.indexOf(b) - BEATS.indexOf(a);
const RENDER_ORDER = [
  ...BEATS.filter((b) => !isSoldOut(b)).sort(byNewest),
  ...BEATS.filter((b) => isSoldOut(b)).sort(byNewest)
];

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

const $ = (id) => document.getElementById(id);

const grid = $("grid");
const cartbar = $("cartbar");
const drawer = $("drawer");
const backdrop = $("backdrop");

const BTC_ENDPOINT =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,tether,usd-coin&vs_currencies=usd";

// Settlement coins on NOWPayments — `np` is the NOWPayments currency code.
const ASSETS = {
  USDT: {
    sym: "USDT", name: "TETHER", id: "tether", np: "usdttrc20",
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
  }
};

// Offered as a low-fee fallback when a coin's network minimum blocks a small cart.
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
  // A below-minimum method can never be chosen — bounce to the next one.
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
  return pad(BEATS.indexOf(beat) + 1);
}

function specLine(beat) {
  return `${beat.bpm} BPM // ${beat.key}`;
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

function cardInner(beat) {
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
  const action = sold
    ? `<button class="card__btn card__btn--sold" disabled>SOLD OUT</button>`
    : released
      ? `<button class="card__btn" data-id="${beat.id}" data-on="0" aria-pressed="false"><span class="lbl">ADD</span><span class="lbl">REMOVE</span></button>`
      : `<button class="card__btn" data-id="${beat.id}" disabled>SOON</button>`;
  return `
    <div class="card__media">
      <img src="${beat.img}" alt="${beat.title}" decoding="async" fetchpriority="high">
      <span class="card__num">${beatNum(beat)} OF ${pad(BEATS.length)}</span>
      ${mediaTag}
    </div>
    <div class="card__info">
      <div class="card__meta">
        <div class="card__name">${beat.title} <span class="card__name-alt">\u2014 ${beat.name}</span></div>
        <div class="card__specs">${specLine(beat)}</div>
        <div class="card__price">${money(PRICE)}</div>
        <div class="btc-price"></div>
        ${stockHTML(beat)}
      </div>
      ${action}
    </div>`;
}

function buildGrid() {
  RENDER_ORDER.forEach((beat) => {
    const card = document.createElement("article");
    card.className =
      "card" +
      (isReleased(beat) ? "" : " card--locked") +
      (isSoldOut(beat) ? " card--sold" : "");
    card.id = "card-" + beat.id;
    card.innerHTML = cardInner(beat);
    grid.appendChild(card);
  });

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".card__btn");
    if (!btn || btn.disabled) return;
    toggle(btn.dataset.id);
  });
}

let countdownTimer = null;

function checkReleases() {
  let allLive = true;
  BEATS.forEach((beat) => {
    const card = $("card-" + beat.id);
    if (!card || !card.classList.contains("card--locked")) return;
    const remaining = releaseDate(beat).getTime() - Date.now();
    if (remaining <= 0) {
      unlockBeat(beat);
      return;
    }
    allLive = false;
    const el = $("countdown-" + beat.id);
    if (el) el.textContent = formatRemaining(remaining);
  });
  if (allLive && countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function unlockBeat(beat) {
  const card = $("card-" + beat.id);
  if (!card) return;
  card.classList.remove("card--locked");
  card.innerHTML = cardInner(beat);
  render();
}

function startCountdowns() {
  if (!BEATS.some((b) => !isReleased(b))) return;
  countdownTimer = setInterval(checkReleases, 1000);
}

let seasonTimer = null;

function tickSeason() {
  const el = $("season-timer");
  if (!el) return;
  const remaining = new Date(SEASON_END_AT).getTime() - Date.now();
  if (remaining <= 0) {
    el.textContent = "EXPIRED";
    if (seasonTimer) {
      clearInterval(seasonTimer);
      seasonTimer = null;
    }
    return;
  }
  el.textContent = formatRemaining(remaining);
}

function toggle(id) {
  const beat = BEATS.find((b) => b.id === id);
  if (!beat || !isReleased(beat) || isSoldOut(beat)) return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
}

function removeItem(id) {
  selected.delete(id);
  render();
}

function totals() {
  const n = selected.size;
  const subtotal = n * PRICE;
  const freeCount = [...freePicks].filter((id) => selected.has(id)).length;
  const discount = freeCount * PRICE;
  return { n, subtotal, freeCount, discount, total: subtotal - discount };
}

function render() {
  const { n, subtotal, discount, total } = totals();

  // Cart size changed → re-check which payment methods remain affordable.
  updatePaygridLocks();
  // If the selected method just became unaffordable, fall back automatically.
  if (payGroup && isGroupBelowMin(payGroup)) {
    const alt = firstAffordableGroup();
    if (alt) selectPayment(alt.value);
    else {
      payGroup = null;
      payAssetSym = null;
      $("payment").value = "";
      document.querySelectorAll(".paygrid__opt").forEach((b) => b.classList.remove("paygrid__opt--on"));
    }
  }

  BEATS.forEach((b) => {
    if (!isReleased(b) || isSoldOut(b)) return;
    const card = $("card-" + b.id);
    const on = selected.has(b.id);
    card.classList.toggle("card--selected", on);
    const btn = card.querySelector(".card__btn");
    btn.dataset.on = on ? "1" : "0";
    btn.setAttribute("aria-pressed", String(on));
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
  } else if (n % 3 === 2) {
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
  BEATS.filter((b) => selected.has(b.id)).forEach((b) => {
    const picked = freePicks.has(b.id);
    const li = document.createElement("li");
    if (picked) li.className = "cart-item--free";
    li.innerHTML = `
      <img src="${b.img}" alt="">
      <span class="cart-items__name">${b.title} <span class="cart-items__name-alt">\u2014 ${b.name}</span><span class="cart-items__specs">${specLine(b)} \u2014 ${stockLine(b)}</span></span>
      <span class="cart-items__price${picked ? " cart-items__price--free" : ""}">${picked ? "FREE" : money(PRICE)}</span>
      ${picked ? `<button class="cart-items__free" data-free="${b.id}">REMOVE FREE</button>` : cap > freePicks.size ? `<button class="cart-items__free" data-free="${b.id}">MAKE FREE</button>` : ""}
      <button class="cart-items__remove" data-id="${b.id}">REMOVE</button>`;
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
  loadMins(); // refresh network minimums so paygrid locks stay current
}

function closeDrawer() {
  drawer.classList.remove("drawer--open");
  drawer.setAttribute("aria-hidden", "true");
  backdrop.hidden = true;
  document.body.style.overflow = "";
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

  // Backstop: never allow a below-minimum method through to checkout.
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

  const payment = $("payment").value;
  if (!payment) {
    $("paygrid").classList.add("invalid");
    errorEl.textContent = "SELECT A PAYMENT METHOD.";
    errorEl.hidden = false;
    return;
  }

  if (n === 0) {
    errorEl.textContent = "SELECT AT LEAST ONE BEAT.";
    errorEl.hidden = false;
    return;
  }

  if (!WORKER_URL) {
    emailInput.classList.add("invalid");
    errorEl.textContent = "STORE OWNER: OPEN SCRIPT.JS AND SET YOUR WORKER URL AT THE TOP OF THE FILE.";
    errorEl.hidden = false;
    return;
  }

  const chosen = BEATS.filter((b) => selected.has(b.id));
  lastOrder = {
    email,
    group: payGroup,
    labeled: chosen.map((b) => `${b.title}${freePicks.has(b.id) ? " (FREE)" : ""}`),
    freeTitles: chosen.filter((b) => freePicks.has(b.id)).map((b) => b.title),
    subtotal,
    discount,
    total,
    items: chosen.map((b) => ({ id: b.id, title: b.title }))
  };

  // Order + delivery are handled entirely by the Worker: the popup creates
  // the NOWPayments payment and links unlock only on verified 'finished'.
  finishOrder();
}

function finishOrder() {
  selected.clear();
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
  expired: "PAYMENT EXPIRED \u2014 PICK ANOTHER COIN TO RETRY"
};

function setNpStatus(text, mode) {
  const el = $("np-status");
  if (!el) return;
  el.textContent = text;
  el.className = "np-status" + (mode ? " np-status--" + mode : "");
}

// All NOWPayments traffic is proxied through the Worker — the browser never
// sees the API key, and download links come back only after IPN verification.
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

// Loads USD minimum charge per coin from the Worker; drives BOTH the drawer
// paygrid locks and the popup chip locks.
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
    // Physically blocked coins never trigger checkout: pointer-events: none
    // stops real clicks, the disabled flag stops assistive tech, and this
    // guard re-checks the live minimum in case state changed after render.
    if (b.disabled || b.classList.contains("payscreen__tab--off") || isBelowMin(sym)) return;
    startNpPayment(sym);
  });
  return b;
}

// Greys out chips whose network minimum exceeds the cart total.
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

// ── Drawer paygrid locks: a method group is disabled when the cart total is
// below the minimum of EVERY coin it offers. BTC (~$26 min) locks on $14.95 carts.
function isGroupBelowMin(group) {
  if (!npMins) return false;
  return group.assets.every((s) => isBelowMinSym(s, totals().total));
}

function firstAffordableGroup(excludeValue) {
  return (
    PAYMENT_GROUPS.find((g) => g.value !== excludeValue && !isGroupBelowMin(g)) || null
  );
}

function updatePaygridLocks() {
  document.querySelectorAll(".paygrid__opt").forEach((b) => {
    const group = PAYMENT_GROUPS.find((g) => g.value === b.dataset.value);
    if (!group) return;
    const blocked = isGroupBelowMin(group);
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

// Asks the Worker for a fresh deposit address in the chosen coin. Switching
// coins re-uses the same order id so the server keeps one order record.
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
        items: payScreenOrder.items
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
  $("payscreen-network").textContent = "RATE LOCKED BY NOWPAYMENTS";
  $("payscreen-address").textContent = npPayment.pay_address;
  $("payscreen-payblock").hidden = false;
  const btn = $("copy-address");
  btn.disabled = false;
  btn.textContent = "COPY ADDRESS";
}

// Polls the Worker for payment progress. Links arrive ONLY when the Worker
// has marked the order released (HMAC-verified 'finished' IPN received).
function startNpPolling(orderId) {
  stopNpPolling();
  npPollTimer = setInterval(async () => {
    try {
      const s = await workerRequest("/api/status?order_id=" + encodeURIComponent(orderId));
      if (s.released) {
        stopNpPolling();
        setNpStatus("PAYMENT VERIFIED \u2014 FILES UNLOCKED", "ok");
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

// Loads network minimums FIRST so a below-minimum coin never fires a doomed
// checkout; falls back through the group and surfaces alternatives.
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

// Downloads stay hidden until the Worker releases them post-IPN verification.
function prepDownloads() {
  $("payscreen-downloads-wrap").hidden = true;
  $("payscreen-downloads").innerHTML = "";
}

// Renders ONLY the links handed back by the Worker after verified payment.
function revealDownloads(links) {
  const list = $("payscreen-downloads");
  list.innerHTML = "";
  (links || []).forEach((it) => {
    const a = document.createElement("a");
    a.className = "payscreen__dl";
    a.href = it.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = `DOWNLOAD ${it.title}`;
    list.appendChild(a);
  });
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
}

buildTicker();
buildGrid();
buildPaygrid();
render();
startCountdowns();
tickSeason();
seasonTimer = setInterval(tickSeason, 1000);
startBtc();
loadMins();

if (!WORKER_URL) $("config-warning").hidden = false;

cartbar.addEventListener("click", openDrawer);
$("close").addEventListener("click", resetDrawer);
backdrop.addEventListener("click", resetDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
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
  if (btn) removeItem(btn.dataset.id);
});
$("order-form").addEventListener("submit", submitOrder);
$("payscreen-close").addEventListener("click", () => {
  hidePayscreen();
  resetDrawer();
  window.scrollTo({ top: 0 });
});
$("copy-address").addEventListener("click", copyPayAddress);
