// BeautyBridge storefront — vanilla JS, hash routing.
const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n).toFixed(2)}`;
const ICONS = { Skincare: '🧴', Makeup: '💄', Tools: '🪞', Hair: '💇‍♀️', Nails: '💅' };
const thumb = (p) => /^https:\/\//.test(p.image || '')
  ? `<div class="thumb"><img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy"></div>`
  : `<div class="thumb" style="background:linear-gradient(135deg,hsl(${p.hue} 70% 92%),hsl(${(p.hue + 40) % 360} 60% 82%))">${ICONS[p.category] || '✨'}</div>`;
const STATUS_LABEL = {
  pending_payment: 'Awaiting payment', paid: 'Payment received', ordered_from_supplier: 'Being prepared',
  shipped: 'Shipped', delivered: 'Delivered', cancelled: 'Cancelled', refunded: 'Refunded', needs_attention: 'Being prepared',
};

let config = { freeShippingOver: 35, shippingFee: 4.99, paymentsMode: 'demo', deliveryEstimate: '7–15 business days' };
let products = [];

// ---------- cart (localStorage, guarded) ----------
const cart = {
  get() { try { return JSON.parse(localStorage.getItem('bb_cart') || '[]'); } catch { return []; } },
  set(items) { try { localStorage.setItem('bb_cart', JSON.stringify(items)); } catch {} updateCount(); },
  add(id, qty) {
    const items = cart.get();
    const it = items.find((x) => x.id === id);
    if (it) it.qty = Math.min(it.qty + qty, 20); else items.push({ id, qty });
    cart.set(items);
  },
};
function updateCount() {
  document.getElementById('cartCount').textContent = cart.get().reduce((s, i) => s + i.qty, 0);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Something went wrong');
  return body;
}

// ---------- views ----------
function viewShop(cat) {
  const cats = ['All', ...new Set(products.map((p) => p.category))];
  const list = products
    .filter((p) => !cat || cat === 'All' || p.category === cat)
    .sort((a, b) => (b.demandScore || 0) - (a.demandScore || 0));
  $app.innerHTML = `
    <section class="hero">
      <h1>The beauty products everyone's talking about.</h1>
      <p>We track what's trending, source it direct from the makers, and ship it to your door, so you get viral beauty finds without the markup.</p>
    </section>
    <div class="filters">${cats.map((c) => `<button class="chip ${c === (cat || 'All') ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <div class="grid">
      ${list.map((p) => `
        <a class="card" href="#/p/${esc(p.id)}">
          ${thumb(p)}
          <div class="body">
            <span class="cat">${esc(p.category)}</span>
            <span class="name">${esc(p.name)}</span>
            ${p.demandScore >= 88 ? '<span class="hot">🔥 Trending</span>' : ''}
            <span class="price">${money(p.price)}</span>
          </div>
        </a>`).join('')}
    </div>`;
  $app.querySelectorAll('.chip').forEach((b) => (b.onclick = () => (location.hash = `#/?cat=${encodeURIComponent(b.dataset.cat)}`)));
}

function viewProduct(id) {
  const p = products.find((x) => x.id === id);
  if (!p) { $app.innerHTML = '<p class="panel">Product not found. <a href="#/">Back to shop</a></p>'; return; }
  $app.innerHTML = `
    <div class="detail">
      ${thumb(p)}
      <div>
        <span class="muted">${esc(p.category)}</span>
        <h1>${esc(p.name)}</h1>
        <div class="price">${money(p.price)}</div>
        <p>${esc(p.description)}</p>
        <div style="display:flex;align-items:center;margin-top:16px">
          <div class="qty"><button id="dec">−</button><input id="q" value="1" inputmode="numeric"><button id="inc">+</button></div>
          <button class="btn" id="add">Add to cart</button>
        </div>
        <p class="okmsg" id="msg"></p>
        <ul class="facts">
          <li>🚚 Ships to all 50 US states · ${esc(config.deliveryEstimate)}</li>
          <li>📦 Free shipping on orders over ${money(config.freeShippingOver)}</li>
          <li>↩️ 30-day refund if your item arrives damaged or doesn't arrive</li>
          <li>🔒 Pay with PayPal, Venmo, Pay Later or card</li>
        </ul>
      </div>
    </div>`;
  const q = document.getElementById('q');
  const clamp = (v) => Math.min(Math.max(parseInt(v, 10) || 1, 1), 20);
  document.getElementById('dec').onclick = () => (q.value = clamp(+q.value - 1));
  document.getElementById('inc').onclick = () => (q.value = clamp(+q.value + 1));
  document.getElementById('add').onclick = () => {
    cart.add(p.id, clamp(q.value));
    document.getElementById('msg').innerHTML = `Added to cart. <a href="#/cart">View cart →</a>`;
  };
}

function cartLines() {
  return cart.get()
    .map((it) => ({ ...it, p: products.find((p) => p.id === it.id) }))
    .filter((l) => l.p);
}
function totals(lines) {
  const subtotal = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
  const shipping = subtotal >= config.freeShippingOver || subtotal === 0 ? 0 : config.shippingFee;
  return { subtotal, shipping, total: subtotal + shipping };
}

function viewCart() {
  const lines = cartLines();
  if (!lines.length) {
    $app.innerHTML = `<div class="panel"><h2>Your cart is empty</h2><a class="btn" href="#/">Start shopping</a></div>`;
    return;
  }
  const t = totals(lines);
  const toFree = config.freeShippingOver - t.subtotal;
  $app.innerHTML = `
    <h2 style="margin-top:28px">Your cart</h2>
    <div class="panel">
      ${lines.map((l) => `
        <div class="row">
          <div><strong>${esc(l.p.name)}</strong><div class="muted">${money(l.p.price)} each</div></div>
          <div style="display:flex;gap:8px;align-items:center">
            <div class="qty"><button data-d="-1" data-id="${esc(l.id)}">−</button><input value="${l.qty}" readonly><button data-d="1" data-id="${esc(l.id)}">+</button></div>
            <strong>${money(l.p.price * l.qty)}</strong>
          </div>
        </div>`).join('')}
      <div class="row"><span>Subtotal</span><span>${money(t.subtotal)}</span></div>
      <div class="row"><span>Shipping ${toFree > 0 ? `<span class="muted">(add ${money(toFree)} for free shipping)</span>` : ''}</span><span>${t.shipping ? money(t.shipping) : 'FREE'}</span></div>
      <div class="row total"><span>Total</span><span>${money(t.total)}</span></div>
    </div>
    <a class="btn" href="#/checkout">Checkout</a>`;
  $app.querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => {
    const items = cart.get();
    const it = items.find((x) => x.id === b.dataset.id);
    it.qty = Math.min(it.qty + Number(b.dataset.d), 20);
    cart.set(items.filter((x) => x.qty > 0));
    viewCart();
  }));
}

function viewCheckout() {
  const lines = cartLines();
  if (!lines.length) { location.hash = '#/cart'; return; }
  const t = totals(lines);
  $app.innerHTML = `
    <h2 style="margin-top:28px">Checkout</h2>
    <div class="two">
      <form class="panel stack" id="f">
        <strong>Shipping address (US only)</strong>
        <label>Full name<input name="name" required autocomplete="name"></label>
        <label>Email (for your receipt and tracking)<input name="email" type="email" required autocomplete="email"></label>
        <label>Phone (optional, helps the courier)<input name="phone" autocomplete="tel"></label>
        <label>Address<input name="address1" required autocomplete="address-line1"></label>
        <label>Apartment, suite (optional)<input name="address2" autocomplete="address-line2"></label>
        <div class="cols">
          <label>City<input name="city" required autocomplete="address-level2"></label>
          <label>State<input name="state" required maxlength="2" placeholder="CA" autocomplete="address-level1"></label>
          <label>ZIP<input name="zip" required pattern="\\d{5}(-\\d{4})?" autocomplete="postal-code"></label>
        </div>
        <p class="err" id="err"></p>
        ${config.paymentsMode === 'paypal'
          ? `<div id="paypal-buttons"><p class="muted">Loading secure payment…</p></div>
             <p class="muted" style="font-size:13px;margin:0">Pay with PayPal, Venmo, Pay Later or any debit/credit card. No PayPal account needed for cards.</p>`
          : `<button class="btn" id="pay">Place demo order</button>
             <p class="muted" style="font-size:13px;margin:0">Demo mode: no payment is taken. Add PayPal keys to accept real payments.</p>`}
      </form>
      <div class="panel">
        <strong>Order summary</strong>
        ${lines.map((l) => `<div class="row"><span>${esc(l.p.name)} × ${l.qty}</span><span>${money(l.p.price * l.qty)}</span></div>`).join('')}
        <div class="row"><span>Shipping</span><span>${t.shipping ? money(t.shipping) : 'FREE'}</span></div>
        <div class="row total"><span>Total</span><span>${money(t.total)}</span></div>
        <p class="muted" style="font-size:13px">Import duties are included in our prices. No surprise fees at your door.</p>
      </div>
    </div>`;
  const form = document.getElementById('f');
  const errEl = document.getElementById('err');
  const getCustomer = () => {
    const c = Object.fromEntries(new FormData(form));
    c.state = (c.state || '').trim().toUpperCase();
    return c;
  };
  const startCheckout = () =>
    api('/api/checkout', { method: 'POST', body: JSON.stringify({ items: cart.get(), customer: getCustomer() }) });
  const done = (orderId) => {
    cart.set([]);
    location.hash = `#/order/${orderId}?email=${encodeURIComponent(getCustomer().email)}`;
  };

  if (config.paymentsMode === 'paypal') {
    form.onsubmit = (e) => e.preventDefault();
    renderPayPal({ form, errEl, startCheckout, done });
    return;
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('pay');
    btn.disabled = true;
    try {
      const r = await startCheckout();
      await api(`/api/orders/${r.orderId}/demo-pay`, { method: 'POST', body: JSON.stringify({ email: getCustomer().email }) });
      done(r.orderId);
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false;
    }
  };
}

let paypalSdk;
function loadPayPal() {
  paypalSdk = paypalSdk || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(config.paypalClientId)}` +
      '&currency=USD&intent=capture&components=buttons&enable-funding=venmo,paylater';
    s.onload = () => resolve(window.paypal);
    s.onerror = () => { paypalSdk = null; reject(new Error('Could not load PayPal. Check your connection and refresh.')); };
    document.head.appendChild(s);
  });
  return paypalSdk;
}

async function renderPayPal({ form, errEl, startCheckout, done }) {
  const box = document.getElementById('paypal-buttons');
  let orderId;
  try {
    const pp = await loadPayPal();
    box.innerHTML = '';
    await pp.Buttons({
      style: { layout: 'vertical', shape: 'rect', label: 'pay' },
      // Make sure the address is filled in before PayPal opens.
      onClick: (_d, actions) => {
        errEl.textContent = '';
        if (!form.reportValidity()) return actions.reject();
        return actions.resolve();
      },
      createOrder: async () => {
        try {
          const r = await startCheckout();
          orderId = r.orderId;
          return r.paypalOrderId;
        } catch (e) { errEl.textContent = e.message; throw e; }
      },
      onApprove: async () => {
        try {
          await api('/api/paypal/capture', { method: 'POST', body: JSON.stringify({ orderId }) });
          done(orderId);
        } catch (e) { errEl.textContent = e.message; }
      },
      onCancel: () => { errEl.textContent = 'Payment cancelled. You have not been charged.'; },
      onError: () => { if (!errEl.textContent) errEl.textContent = 'Payment could not be completed. Please try again.'; },
    }).render(box);
  } catch (e) {
    box.innerHTML = `<p class="err">${esc(e.message)}</p>`;
  }
}

async function viewOrder(id, email) {
  $app.innerHTML = '<p class="panel">Loading order…</p>';
  try {
    const o = await api(`/api/orders/${encodeURIComponent(id)}?email=${encodeURIComponent(email)}`);
    if (o.status !== 'pending_payment') cart.set([]);
    const steps = ['paid', 'ordered_from_supplier', 'shipped', 'delivered'];
    const reached = new Set(o.history.map((h) => h.status));
    $app.innerHTML = `
      <div class="panel">
        <h2 style="margin-top:0">${o.status === 'paid' ? 'Thank you! 🎉 ' : ''}Order ${esc(o.id)}</h2>
        <p>Status: <strong>${esc(STATUS_LABEL[o.status] || o.status)}</strong></p>
        ${o.tracking ? `<p>Tracking: <strong>${esc(o.tracking.carrier)} ${esc(o.tracking.number)}</strong></p>` : ''}
        <ul class="timeline">${steps.map((s) => `<li class="${reached.has(s) ? 'done' : ''}"><span class="dot"></span>${STATUS_LABEL[s]}</li>`).join('')}</ul>
        <p class="muted">Estimated delivery: ${esc(config.deliveryEstimate)} from the order date. Save your order number: <strong>${esc(o.id)}</strong></p>
      </div>
      <div class="panel">
        ${o.items.map((l) => `<div class="row"><span>${esc(l.name)} × ${l.qty}</span><span>${money(l.price * l.qty)}</span></div>`).join('')}
        <div class="row"><span>Shipping</span><span>${o.shippingFee ? money(o.shippingFee) : 'FREE'}</span></div>
        <div class="row total"><span>Total</span><span>${money(o.total)}</span></div>
      </div>`;
  } catch (e) {
    $app.innerHTML = `<p class="panel err">${esc(e.message)} <a href="#/track">Try again</a></p>`;
  }
}

function viewTrack() {
  $app.innerHTML = `
    <form class="panel stack" id="f" style="max-width:480px">
      <h2 style="margin:0">Track your order</h2>
      <label>Order number<input name="id" placeholder="BB-..." required></label>
      <label>Email used at checkout<input name="email" type="email" required></label>
      <button class="btn">Track</button>
    </form>`;
  document.getElementById('f').onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    location.hash = `#/order/${encodeURIComponent(f.id.trim())}?email=${encodeURIComponent(f.email.trim())}`;
  };
}

async function viewRequest() {
  $app.innerHTML = `
    <section class="hero"><h1>Can't find it? Ask us.</h1>
      <p>Tell us the beauty product you want. The most-wanted requests get sourced and added to the shop, and we'll email you when yours arrives.</p></section>
    <div class="two">
      <div class="panel"><strong>Most wanted right now</strong><div id="list"><p class="muted">Loading…</p></div></div>
      <form class="panel stack" id="f">
        <strong>Request a product</strong>
        <label>What do you want?<input name="product" required placeholder="e.g. Snail mucin essence"></label>
        <label>Link (TikTok, Amazon, anywhere, optional)<input name="link" type="url"></label>
        <label>Most you'd pay (USD, optional)<input name="maxPrice" inputmode="decimal"></label>
        <label>Email to notify you (optional)<input name="email" type="email"></label>
        <button class="btn">Send request</button>
        <p id="msg"></p>
      </form>
    </div>`;
  const render = async () => {
    const reqs = await api('/api/requests');
    document.getElementById('list').innerHTML = reqs.length
      ? reqs.map((r) => `<div class="req"><button class="vote" data-id="${esc(r.id)}">▲ ${r.votes}</button><span style="flex:1">${esc(r.product)}</span>${r.status !== 'new' ? `<span class="tag">${esc(r.status)}</span>` : ''}</div>`).join('')
      : '<p class="muted">No requests yet. Be the first!</p>';
    document.querySelectorAll('.vote').forEach((b) => (b.onclick = async () => {
      let voted = []; try { voted = JSON.parse(localStorage.getItem('bb_votes') || '[]'); } catch {}
      if (voted.includes(b.dataset.id)) return;
      await api(`/api/requests/${b.dataset.id}/vote`, { method: 'POST' });
      try { localStorage.setItem('bb_votes', JSON.stringify([...voted, b.dataset.id])); } catch {}
      render();
    }));
  };
  render();
  document.getElementById('f').onsubmit = async (e) => {
    e.preventDefault();
    const msg = document.getElementById('msg');
    try {
      const r = await api('/api/requests', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) });
      msg.className = 'okmsg';
      msg.textContent = r.merged ? 'Others want this too. We added your vote!' : 'Thanks! Your request is in.';
      e.target.reset();
      render();
    } catch (err) { msg.className = 'err'; msg.textContent = err.message; }
  };
}

// ---------- router ----------
function route() {
  const [path, qs] = location.hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(qs || '');
  const parts = (path || '/').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  if (parts[0] === 'p') return viewProduct(parts[1]);
  if (parts[0] === 'cart') return viewCart();
  if (parts[0] === 'checkout') return viewCheckout();
  if (parts[0] === 'track') return viewTrack();
  if (parts[0] === 'request') return viewRequest();
  if (parts[0] === 'order') return viewOrder(decodeURIComponent(parts[1]), params.get('email') || '');
  return viewShop(params.get('cat'));
}

(async function init() {
  updateCount();
  try {
    [config, products] = await Promise.all([api('/api/config'), api('/api/products')]);
    document.getElementById('banner').textContent =
      `Free US shipping on orders over ${money(config.freeShippingOver)} · Delivered in ${config.deliveryEstimate}`;
  } catch {
    $app.innerHTML = '<p class="panel err">Could not load the shop. Please refresh.</p>';
    return;
  }
  window.addEventListener('hashchange', route);
  route();
})();
