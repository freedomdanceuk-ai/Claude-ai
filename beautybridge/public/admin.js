const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const pct = (n) => `${Math.round(n * 100)}%`;
const store = {
  get: () => { try { return sessionStorage.getItem('bb_admin') || ''; } catch { return ''; } },
  set: (v) => { try { v ? sessionStorage.setItem('bb_admin', v) : sessionStorage.removeItem('bb_admin'); } catch {} },
};
let token = store.get();
let tab = 'orders';

async function api(path, opts = {}) {
  const res = await fetch(`/api/admin${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { token = ''; store.set(''); login('Wrong admin token.'); throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}

document.getElementById('logout').onclick = (e) => { e.preventDefault(); token = ''; store.set(''); login(); };

function login(err = '') {
  $app.innerHTML = `
    <form class="panel stack" id="f" style="max-width:400px;margin-top:40px">
      <h2 style="margin:0">Admin login</h2>
      <label>Admin token<input name="t" type="password" required></label>
      <p class="err">${esc(err)}</p>
      <button class="btn">Log in</button>
    </form>`;
  document.getElementById('f').onsubmit = (e) => {
    e.preventDefault();
    token = new FormData(e.target).get('t');
    store.set(token);
    render();
  };
}

async function render() {
  if (!token) return login();
  let s;
  try { s = await api('/summary'); } catch { return; }
  $app.innerHTML = `
    <div class="stats">
      <div class="stat"><span class="muted">Revenue</span><b>${money(s.revenue)}</b></div>
      <div class="stat"><span class="muted">Est. profit</span><b>${money(s.estProfit)}</b></div>
      <div class="stat"><span class="muted">Paid orders</span><b>${s.paidOrders}</b></div>
      <div class="stat"><span class="muted">To send to supplier</span><b>${s.toFulfil}</b></div>
      <div class="stat"><span class="muted">New requests</span><b>${s.openRequests}</b></div>
    </div>
    <p class="muted" style="font-size:13px">Payments: <b>${s.paymentsMode}</b> · Supplier: <b>${s.supplierMode}</b> ·
      Duty rate ${pct(s.pricing.dutyRate)} · Target margin ${pct(s.pricing.targetMargin)}</p>
    <div class="tabs">
      ${['orders', 'products', 'requests'].map((t) => `<button class="chip ${t === tab ? 'on' : ''}" data-t="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </div>
    <div id="body"></div>`;
  $app.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { tab = b.dataset.t; render(); }));
  ({ orders, products, requests })[tab]();
}

// ---------- orders ----------
async function orders() {
  const list = await api('/orders');
  const body = document.getElementById('body');
  if (!list.length) { body.innerHTML = '<p class="panel muted">No orders yet.</p>'; return; }
  body.innerHTML = `<div class="panel scroll"><table>
    <tr><th>Order</th><th>Customer / ship to</th><th>Items</th><th>Total</th><th>Status & actions</th></tr>
    ${list.map((o) => `
      <tr>
        <td><b>${esc(o.id)}</b><br><span class="muted">${new Date(o.createdAt).toLocaleString()}</span></td>
        <td>${esc(o.customer.name)}<br><span class="muted">${esc(o.customer.email)}<br>
          ${esc(o.customer.address1)} ${esc(o.customer.address2)}<br>${esc(o.customer.city)}, ${esc(o.customer.state)} ${esc(o.customer.zip)}</span></td>
        <td>${o.items.map((i) => `${esc(i.name)} × ${i.qty}`).join('<br>')}</td>
        <td>${money(o.total)}</td>
        <td>
          <span class="status ${esc(o.status)}">${esc(o.status.replace(/_/g, ' '))}</span>
          ${o.supplierOrder ? `<div class="muted">Supplier #: ${esc(o.supplierOrder.supplierOrderId)}</div>` : ''}
          ${o.supplierOrder?.note ? `<div class="warn">${esc(o.supplierOrder.note)}</div>` : ''}
          ${o.tracking ? `<div class="muted">Tracking: ${esc(o.tracking.carrier)} ${esc(o.tracking.number)}</div>` : ''}
          <div class="actions">
            ${o.status === 'paid' ? `<button class="btn small" data-fulfil="${esc(o.id)}">Send to supplier</button>` : ''}
            ${o.status === 'ordered_from_supplier' ? `
              <input placeholder="Carrier (USPS…)" data-carrier="${esc(o.id)}">
              <input placeholder="Tracking number" data-trk="${esc(o.id)}">
              <button class="btn small" data-ship="${esc(o.id)}">Mark shipped</button>` : ''}
            ${o.status === 'shipped' ? `<button class="btn small" data-status="delivered" data-id="${esc(o.id)}">Mark delivered</button>` : ''}
            ${['paid', 'ordered_from_supplier', 'shipped'].includes(o.status) ? `<button class="btn small ghost" data-status="refunded" data-id="${esc(o.id)}">Refunded</button>` : ''}
            ${o.status === 'pending_payment' ? `<button class="btn small ghost" data-status="cancelled" data-id="${esc(o.id)}">Cancel</button>` : ''}
          </div>
        </td>
      </tr>`).join('')}
  </table></div>`;
  const act = (fn) => async (e) => { e.target.disabled = true; try { await fn(e.target); } catch (err) { alert(err.message); } render(); };
  body.querySelectorAll('[data-fulfil]').forEach((b) => (b.onclick = act((t) => api(`/orders/${t.dataset.fulfil}/fulfil`, { method: 'POST' }))));
  body.querySelectorAll('[data-ship]').forEach((b) => (b.onclick = act((t) => {
    const id = t.dataset.ship;
    const trackingNumber = body.querySelector(`[data-trk="${id}"]`).value.trim();
    if (!trackingNumber) throw new Error('Enter a tracking number');
    return api(`/orders/${id}/status`, { method: 'POST', body: JSON.stringify({
      status: 'shipped', trackingNumber, carrier: body.querySelector(`[data-carrier="${id}"]`).value.trim() }) });
  })));
  body.querySelectorAll('[data-status]').forEach((b) => (b.onclick = act((t) => {
    if (t.dataset.status === 'refunded' && !confirm('Mark as refunded? (Issue the refund in Stripe first.)')) return;
    return api(`/orders/${t.dataset.id}/status`, { method: 'POST', body: JSON.stringify({ status: t.dataset.status }) });
  })));
}

// ---------- products + pricing calculator ----------
async function products() {
  const list = await api('/products');
  const body = document.getElementById('body');
  body.innerHTML = `
    <form class="panel stack" id="add">
      <strong>Add a product (landed-cost calculator)</strong>
      <div class="grid3">
        <label>Name<input name="name" required></label>
        <label>Category<select name="category">${['Skincare', 'Makeup', 'Tools', 'Hair', 'Nails'].map((c) => `<option>${c}</option>`).join('')}</select></label>
        <label>Supplier SKU / variant ID<input name="supplierSku"></label>
        <label>Supplier cost (USD)<input name="supplierCost" required inputmode="decimal"></label>
        <label>Shipping China→US (USD)<input name="shippingCost" required inputmode="decimal"></label>
        <label>Duty rate override (e.g. 0.3)<input name="dutyRate" inputmode="decimal"></label>
      </div>
      <label>Description<textarea name="description" rows="2"></textarea></label>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" name="cosmetic" style="width:auto">
        Applied to skin / hair / nails (cosmetic: needs FDA MoCRA listing & labelling)</label>
      <div id="q" class="muted"></div>
      <button class="btn">Add product</button>
    </form>
    <div class="panel scroll"><table>
      <tr><th>Product</th><th>Cost</th><th>Duty</th><th>Landed</th><th>Price</th><th>Profit</th><th></th></tr>
      ${list.map((p) => `
        <tr>
          <td><b>${esc(p.name)}</b><br><span class="muted">${esc(p.category)} · demand ${p.demandScore ?? '-'}</span>
            ${p.cosmetic ? '<br><span class="warn">Cosmetic: confirm FDA compliance</span>' : ''}
            ${!p.supplierSku ? '<br><span class="warn">No supplier SKU: manual ordering</span>' : ''}</td>
          <td>${money(p.supplierCost)} + ${money(p.shippingCost)} ship</td>
          <td>${money(p.quote.duty)}</td>
          <td>${money(p.quote.landedCost)}</td>
          <td><input value="${p.price}" data-price="${esc(p.id)}" style="width:80px;padding:4px 6px"></td>
          <td>${money(p.price - p.quote.landedCost - (p.price * 0.029 + 0.3))}</td>
          <td><button class="btn small ghost" data-toggle="${esc(p.id)}" data-active="${p.active}">${p.active ? 'Hide' : 'Show'}</button></td>
        </tr>`).join('')}
    </table></div>`;

  const form = document.getElementById('add');
  const preview = async () => {
    const f = Object.fromEntries(new FormData(form));
    if (!f.supplierCost) return;
    try {
      const q = await api('/quote', { method: 'POST', body: JSON.stringify(f) });
      document.getElementById('q').innerHTML =
        `Duty ${money(q.duty)} · Landed cost ${money(q.landedCost)} · Fees ${money(q.paymentFees)} → <b>Retail ${money(q.price)}</b>, profit ${money(q.profit)} (${pct(q.margin)})`;
    } catch {}
  };
  form.oninput = preview;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    f.cosmetic = Boolean(f.cosmetic);
    try { await api('/products', { method: 'POST', body: JSON.stringify(f) }); render(); } catch (err) { alert(err.message); }
  };
  body.querySelectorAll('[data-price]').forEach((i) => (i.onchange = async () => {
    await api(`/products/${i.dataset.price}`, { method: 'PUT', body: JSON.stringify({ price: i.value }) });
    render();
  }));
  body.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = async () => {
    await api(`/products/${b.dataset.toggle}`, { method: 'PUT', body: JSON.stringify({ active: b.dataset.active !== 'true' }) });
    render();
  }));
}

// ---------- product requests (demand discovery) ----------
async function requests() {
  const list = await api('/requests');
  const body = document.getElementById('body');
  if (!list.length) { body.innerHTML = '<p class="panel muted">No product requests yet. Share the /#/request page with your audience.</p>'; return; }
  body.innerHTML = `<div class="panel scroll"><table>
    <tr><th>Votes</th><th>Product</th><th>Max price</th><th>Contact</th><th>Status</th></tr>
    ${list.map((r) => `
      <tr>
        <td><b>${r.votes}</b></td>
        <td>${esc(r.product)}${r.link ? `<br><a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">link</a>` : ''}</td>
        <td>${r.maxPrice ? '$' + esc(r.maxPrice) : '-'}</td>
        <td>${esc(r.email) || '-'}</td>
        <td><select data-req="${esc(r.id)}">${['new', 'sourcing', 'listed', 'rejected'].map((s) => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
      </tr>`).join('')}
  </table></div>`;
  body.querySelectorAll('[data-req]').forEach((s) => (s.onchange = () =>
    api(`/requests/${s.dataset.req}`, { method: 'POST', body: JSON.stringify({ status: s.value }) })));
}

render();
