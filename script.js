const FORMSPREE_ENDPOINT = "https://formspree.io/f/xwleyqpa";
const OWNER_EMAIL = "kencarterr8@gmail.com";

const PRICE = 14.95;

const BEATS = [
  { id: "beat1", title: "BEAT 01", img: "assets/beat1.jpg" },
  { id: "beat2", title: "BEAT 02", img: "assets/beat2.png" },
  { id: "beat3", title: "BEAT 03", img: "assets/beat3.png" },
  { id: "beat4", title: "BEAT 04", img: "assets/beat4.png" },
  { id: "beat5", title: "BEAT 05", img: "assets/beat5.png" }
];

const TICKER_TEXT = "KEN CARTER \u2014 ALL BEATS $14.95 \u2014 BUY 2 GET THE 3RD FREE \u2014 ";

const money = (n) => "$" + n.toFixed(2);

const selected = new Set();

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

const $ = (id) => document.getElementById(id);

const grid = $("grid");
const cartbar = $("cartbar");
const drawer = $("drawer");
const backdrop = $("backdrop");

function buildTicker() {
  const line = TICKER_TEXT.repeat(6);
  document.querySelectorAll(".ticker__track span").forEach((s) => (s.textContent = line));
}

function buildGrid() {
  BEATS.forEach((beat) => {
    const card = document.createElement("article");
    card.className = "card";
    card.id = "card-" + beat.id;
    card.innerHTML = `
      <div class="card__media">
        <img src="${beat.img}" alt="${beat.title}" loading="lazy">
        <span class="card__tag">$${PRICE.toFixed(2)}</span>
      </div>
      <div class="card__info">
        <div>
          <div class="card__name">${beat.title}</div>
          <div class="card__price">${money(PRICE)}</div>
        </div>
        <button class="card__btn" data-id="${beat.id}">ADD</button>
      </div>`;
    grid.appendChild(card);
  });

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".card__btn");
    if (!btn) return;
    toggle(btn.dataset.id);
  });
}

function toggle(id) {
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
    const card = $("card-" + b.id);
    const btn = card.querySelector(".card__btn");
    const on = selected.has(b.id);
    card.classList.toggle("card--selected", on);
    btn.textContent = on ? "REMOVE" : "ADD";
  });

  cartbar.disabled = n === 0;
  $("cartbar-label").textContent =
    n === 0 ? "CART (0)" : `CART (${n}) \u2014 ${money(total)}`;

  $("drawer-count").textContent = n;
  $("t-subtotal").textContent = money(subtotal);
  $("t-discount-row").hidden = discount === 0;
  $("t-discount").textContent = "\u2212" + money(discount);
  $("t-total").textContent = money(total);

  const list = $("cart-items");
  list.innerHTML = "";
  BEATS.filter((b) => selected.has(b.id)).forEach((b) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <img src="${b.img}" alt="">
      <span class="cart-items__name">${b.title}</span>
      <span>${money(PRICE)}</span>
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
  return /formspree\.io\/f\/[a-z0-9]+/i.test(FORMSPREE_ENDPOINT);
}

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

  if (n === 0) {
    errorEl.textContent = "SELECT AT LEAST ONE BEAT.";
    errorEl.hidden = false;
    return;
  }

  if (!endpointIsSet()) {
    emailInput.classList.add("invalid");
    errorEl.textContent = "STORE OWNER: OPEN SCRIPT.JS AND SET YOUR FORMSPREE ENDPOINT ON LINE 1.";
    errorEl.hidden = false;
    return;
  }

  const titles = BEATS.filter((b) => selected.has(b.id)).map((b) => b.title);

  const signature = orderSignature(email, titles);
  if (sentOrders.has(signature)) {
    errorEl.textContent = "THIS ORDER WAS ALREADY SENT \u2014 DUPLICATES ARE BLOCKED.";
    errorEl.hidden = false;
    return;
  }

  const order = {
    _subject: `NEW BEAT ORDER \u2014 ${n} BEAT${n > 1 ? "S" : ""} \u2014 ${money(total)}`,
    _replyto: email,
    Customer_Email: email,
    Beats: titles.join(", "),
    Items: String(n),
    Subtotal: money(subtotal),
    Discount: discount > 0 ? `\u2212${money(discount)} (buy 2 get 3rd free)` : "\u2014",
    Total: money(total),
    Date: new Date().toLocaleString()
  };

  finishOrder(email, titles, total);

  fetch(FORMSPREE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(order)
  })
    .then(async (res) => {
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          (data && data.errors && data.errors[0] && data.errors[0].message) ||
          (data && data.error) ||
          (data && data.message) ||
          "Request failed";
        throw Object.assign(new Error(msg), { status: res.status });
      }
      sentOrders.add(signature);
      try {
        localStorage.setItem(SENT_ORDERS_KEY, JSON.stringify(Array.from(sentOrders)));
      } catch {}
    })
    .catch((err) => showOrderError(err, order));
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

function finishOrder(email, titles, total) {
  selected.clear();
  render();
  $("order-form").hidden = true;
  document.querySelector(".totals").hidden = true;
  $("cart-items").hidden = true;
  $("cart-empty").hidden = true;
  $("success-summary").textContent =
    `${titles.join(", ")} \u2014 ${money(total)} \u2014 FILES WILL BE SENT TO ${email.toUpperCase()}`;
  $("success").hidden = false;
}

function resetDrawer() {
  const fromSuccess = !$("success").hidden;
  $("success").hidden = true;
  $("order-form").hidden = false;
  document.querySelector(".totals").hidden = false;
  $("cart-items").hidden = false;
  $("email").value = "";
  closeDrawer();
  if (fromSuccess) window.scrollTo({ top: 0 });
}

buildTicker();
buildGrid();
render();

if (!endpointIsSet()) $("config-warning").hidden = false;

cartbar.addEventListener("click", openDrawer);
$("close").addEventListener("click", resetDrawer);
backdrop.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => e.key === "Escape" && closeDrawer());
$("cart-items").addEventListener("click", (e) => {
  const btn = e.target.closest(".cart-items__remove");
  if (btn) removeItem(btn.dataset.id);
});
$("order-form").addEventListener("submit", submitOrder);
$("continue-btn").addEventListener("click", resetDrawer);
