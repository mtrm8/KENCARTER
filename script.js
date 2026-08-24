const STATICFORMS_ENDPOINT = "https://api.staticforms.dev/submit";
const STATICFORMS_API_KEY = "sf_7dbd34559d35443370eded7e";
const OWNER_EMAIL = "kencarterr8@gmail.com";

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
  { id: "beat1", title: "BEAT 01", name: "CH\u00a3$$",          img: "assets/beat1.jpg?v=2", bpm: 140, key: "E MIN",  leases: LEASES_PER_BEAT },
  { id: "beat2", title: "BEAT 02", name: "AnGeLL",             img: "assets/beat2.jpg?v=2", bpm: 75,  key: "G# MIN", leases: LEASES_PER_BEAT },
  { id: "beat3", title: "BEAT 03", name: "DIAMONS IN THE BAG", img: "assets/beat3.jpg?v=2", bpm: 130, key: "A# MIN", leases: LEASES_PER_BEAT },
  { id: "beat4", title: "BEAT 04", name: "$$$",                img: "assets/beat4.jpg?v=2", bpm: 140, key: "G MIN",  leases: LEASES_PER_BEAT },
  { id: "beat5", title: "BEAT 05", name: "HIGH VIEW",          img: "assets/beat5.jpg?v=2", bpm: 168, key: "C MIN",  leases: LEASES_PER_BEAT },
  { id: "beat6", title: "BEAT 06", name: "PROTOCOL",           img: "assets/beat6.jpg?v=2", bpm: 135, key: "G# MIN", leases: LEASES_PER_BEAT },
  { id: "beat7", title: "BEAT 07", name: "LAST SEAT",          img: "assets/beat7.jpg?v=2", bpm: 140, key: "G# MIN", tag: "NEW", releaseAt: "2026-08-23T20:00:00", leases: LEASES_PER_BEAT }
].map((b) => ({ ...b, left: b.left ?? b.leases }));

const TICKER_TEXT = "KEN CARTER \u2014 ALL BEATS $14.95 \u2014 PICK 2, GET 1 FREE \u2014 STRICTLY LIMITED LEASES \u2014 ";

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

const SENT_ORDERS_KEY = "kencarter_sent_orders";

function loadSentOrders() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SENT_ORDERS_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

let sentOrders = loadSentOrders();

const orderSignature = (email, titles) =>
  email.toLowerCase() + "|" + titles.join(",");

function persistSentOrders() {
  try {
    localStorage.setItem(SENT_ORDERS_KEY, JSON.stringify(Array.from(sentOrders)));
  } catch {}
}

function markOrderSent(signature) {
  sentOrders.add(signature);
  persistSentOrders();
}

function markOrderUnsent(signature) {
  sentOrders.delete(signature);
  persistSentOrders();
}

const $ = (id) => document.getElementById(id);

const grid = $("grid");
const cartbar = $("cartbar");
const drawer = $("drawer");
const backdrop = $("backdrop");

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
  const freeCount = Math.floor(n / 3);
  const discount = freeCount * PRICE;
  return { n, subtotal, freeCount, discount, total: subtotal - discount };
}

function render() {
  const { n, subtotal, discount, total } = totals();

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
  $("t-total").textContent = money(total);

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
  } else {
    hint.hidden = false;
    hint.textContent = `FREE BEAT${cap > 1 ? "S" : ""} APPLIED.`;
  }

  const list = $("cart-items");
  list.innerHTML = "";
  BEATS.filter((b) => selected.has(b.id)).forEach((b) => {
    const picked = freePicks.has(b.id);
    const li = document.createElement("li");
    if (picked) li.className = "cart-item--free";
    li.innerHTML = `
      <img src="${b.img}" alt="">
      <span class="cart-items__name">${b.title}<span class="cart-items__specs">${specLine(b)} \u2014 ${stockLine(b)}</span></span>
      <span class="cart-items__price${picked ? " cart-items__price--free" : ""}">${picked ? "FREE" : money(PRICE)}</span>
      ${cap > 0 && !picked ? `<button class="cart-items__free" data-free="${b.id}">MAKE FREE</button>` : ""}
      <button class="cart-items__remove" data-id="${b.id}">REMOVE</button>`;
    list.appendChild(li);
  });
  $("cart-empty").hidden = n !== 0;
}

function openDrawer() {
  drawer.classList.add("drawer--open");
  drawer.setAttribute("aria-hidden", "false");
  backdrop.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeDrawer() {
  drawer.classList.remove("drawer--open");
  drawer.setAttribute("aria-hidden", "true");
  backdrop.hidden = true;
  document.body.style.overflow = "";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function endpointIsSet() {
  return /^sf_[a-z0-9]+$/i.test(STATICFORMS_API_KEY);
}

let sending = false;

function submitOrder(e) {
  e.preventDefault();
  if (sending) return;

  const emailInput = $("email");
  const errorEl = $("form-error");
  const submitBtn = $("submit-btn");
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

  if (n === 0) {
    errorEl.textContent = "SELECT AT LEAST ONE BEAT.";
    errorEl.hidden = false;
    return;
  }

  if (!endpointIsSet()) {
    emailInput.classList.add("invalid");
    errorEl.textContent = "STORE OWNER: OPEN SCRIPT.JS AND SET YOUR STATIC FORMS API KEY ON LINE 2.";
    errorEl.hidden = false;
    return;
  }

  const chosen = BEATS.filter((b) => selected.has(b.id));
  const titles = chosen.map((b) => b.title);
  const specs = chosen.map(specLine).join(" | ");
  const labeled = chosen.map((b) => `${b.title}${freePicks.has(b.id) ? " (FREE)" : ""}`);
  const freeTitles = chosen.filter((b) => freePicks.has(b.id)).map((b) => b.title);

  const signature = orderSignature(email, titles);
  if (sentOrders.has(signature)) {
    errorEl.textContent = "THIS ORDER WAS ALREADY SENT \u2014 DUPLICATES ARE BLOCKED.";
    errorEl.hidden = false;
    return;
  }

  const order = {
    apiKey: STATICFORMS_API_KEY,
    email,
    message: `NEW BEAT ORDER \u2014 ${n} BEAT${n > 1 ? "S" : ""} \u2014 ${money(total)} \u2014 ${labeled.join(", ")}`,
    Beats: labeled.join(", "),
    Free: freeTitles.length ? freeTitles.join(", ") : "\u2014",
    Specs: specs,
    Items: String(n),
    Subtotal: money(subtotal),
    Discount: discount > 0 ? `\u2212${money(discount)} (pick 2, get 1 free)` : "\u2014",
    Total: money(total),
    Date: new Date().toLocaleString()
  };

  sending = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "SENDING...";
  markOrderSent(signature);

  fetch(STATICFORMS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(order)
  })
    .then(async (res) => {
      const data = await res.json().catch(() => null);
      if (!res.ok || (data && data.success === false)) {
        const msg =
          (data && data.errors && data.errors[0] && data.errors[0].message) ||
          (data && data.error) ||
          (data && data.message) ||
          "Request failed";
        throw Object.assign(new Error(msg), { status: res.status });
      }
      finishOrder();
    })
    .catch((err) => {
      markOrderUnsent(signature);
      showOrderError(err, order);
    })
    .finally(() => {
      sending = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "SUBMIT ORDER";
    });
}

let orderErrorTimer;

function showOrderError(err, order) {
  console.error("Order submission failed:", err);
  const el = $("order-error");
  el.textContent = "ORDER SEND FAILED";
  if (err.message && err.message !== "Request failed") {
    el.textContent += ` \u2014 ${err.message.toUpperCase()}`;
  }
  if (err.status) el.textContent += ` (ERROR ${err.status})`;
  if (location.protocol === "file:") {
    el.textContent += " \u2014 SERVE THE SITE VIA HTTP://LOCALHOST:8000";
  }
  el.textContent += " \u2014 ";
  const mailto = document.createElement("a");
  mailto.href =
    `mailto:${OWNER_EMAIL}?subject=${encodeURIComponent(order._subject)}` +
    `&body=${encodeURIComponent(
      `Email: ${order.Customer_Email}\nBeats: ${order.Beats}\nItems: ${order.Items}\nSubtotal: ${order.Subtotal}\nDiscount: ${order.Discount}\nTotal: ${order.Total}`
    )}`;
  mailto.textContent = "TAP HERE TO SEND BY EMAIL INSTEAD";
  el.appendChild(mailto);
  el.hidden = false;
  clearTimeout(orderErrorTimer);
  orderErrorTimer = setTimeout(() => (el.hidden = true), 12000);
}

function finishOrder() {
  selected.clear();
  render();
  document.querySelector(".totals").hidden = true;
  $("cart-items").hidden = true;
  $("cart-empty").hidden = true;
  $("head-cart").hidden = true;
  $("success").hidden = false;
}

function resetDrawer() {
  const fromSuccess = !$("success").hidden;
  $("success").hidden = true;
  document.querySelector(".totals").hidden = false;
  $("cart-items").hidden = false;
  $("email").value = "";
  $("head-cart").hidden = false;
  closeDrawer();
  if (fromSuccess) window.scrollTo({ top: 0 });
}

buildTicker();
buildGrid();
render();
startCountdowns();

if (!endpointIsSet()) $("config-warning").hidden = false;

cartbar.addEventListener("click", openDrawer);
$("close").addEventListener("click", resetDrawer);
backdrop.addEventListener("click", resetDrawer);
document.addEventListener("keydown", (e) => e.key === "Escape" && resetDrawer());
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
