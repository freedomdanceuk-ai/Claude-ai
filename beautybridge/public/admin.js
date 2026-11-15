const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const pct = (n) => `${Math.round(n * 100)}%`;
const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const every = (sec) => (sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.round(sec / 60)} min` : sec < 86400 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86400)} day`);
const store = {
  get: () => { try { return sessionStorage.getItem('bb_admin') || ''; } catch { return ''; } },
  set: (v) => { try { v ? sessionStorage.setItem('bb_admin', v) : sessionStorage.removeItem('bb_admin'); } catch {} },
};
let token = store.get();
let tab = 'automation';
let timer;

async function api(path, opts = {}) {
  const res = await fetch(`/api/admin${path}`, {
    ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { token = ''; store.set(''); login('Wrong admin token.'); throw new Error('Unauthorized'); }
  if (!res.ok) throw new Error(body.error || 'Request failed');
  return body;
}

document.getElementById('logout').onclick = (e) => { e.preventDefault(); token = ''; store.set(''); clearInterval(timer); login(); };

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
  const alerts = [
    s.needsAttention && `${s.needsAttention} order(s) need attention`,
    s.productsToReview && `${s.productsToReview} product(s) waiting for your FDA check`,
  ].filter(Boolean);
  $app.innerHTML = `
    <div class="stats">
      <div class="stat"><span class="muted">Revenue</span><b>${money(s.revenue)}</b></div>
      <div class="stat"><span class="muted">Est. profit</span><b>${money(s.estProfit)}</b></div>
      <div class="stat"><span class="muted">Paid orders</span><b>${s.paidOrders}</b></div>
      <div class="stat"><span class="muted">In progress</span><b>${s.inProgress}</b></div>
      <div class="stat"><span class="muted">Open requests</span><b>${s.openRequests}</b></div>
    </div>
    ${alerts.length ? `<div class="panel" style="border-color:#f0c27a;background:#fff8ec">⚠️ ${alerts.map(esc).join(' · ')}</div>` : ''}
    <p class="muted" style="font-size:13px">Payments: <b>${esc(s.paymentsMode)}</b> · Supplier: <b>${esc(s.supplierMode)}</b> · Email: <b>${esc(s.emailMode)}</b> ·
      Duty ${pct(s.pricing.dutyRate)} · Margin ${pct(s.pricing.targetMargin)}</p>
    <div class="tabs">
      ${['automation', 'orders', 'products', 'requests'].map((t) => `<button class="chip ${t === tab ? 'on' : ''}" data-t="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
    </div>
    <div id="body"></div>`;
  $app.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { tab = b.dataset.t; render(); }));
  ({ automation, orders, products, requests })[tab](s);
}

// ---------- automation ----------
const JOB_INFO = {
  fulfil: ['Order with supplier', 'Paid orders are ordered and paid for on the supplier, shipped straight to the customer. Retries, then refunds automatically if it keeps failing.'],
  tracking: ['Tracking & delivery', 'Picks up tracking numbers and deliveries from the supplier and emails the customer.'],
  discover: ['Find trending products', 'Searches the supplier for popular beauty products, prices them (duty + shipping + margin) and lists them. Updates costs and hides sold-out items.'],
  requests: ['Source customer requests', 'Requests with enough votes are found on the supplier, listed, and the customer is emailed.'],
};
function automation(s) {
  const body = document.getElementById('body');
  body.innerHTML = `<div class="panel">
    ${Object.entries(s.jobs).map(([name, j]) => `
      <div class="row" style="align-items:flex-start">
        <div style="flex:1">
          <b>${esc(JOB_INFO[name][0])}</b> <span class="muted">· every ${every(j.everySec)} · last run ${ago(j.lastRun)}</span>
          <div class="muted" style="font-size:14px">${esc(JOB_INFO[name][1])}</div>
          ${j.lastResult ? `<div style="font-size:13px;margin-top:4px">Last result: <code>${esc(JSON.stringify(j.lastResult))}</code></div>` : ''}
          ${j.lastError ? `<div class="err">Error: ${esc(j.lastError)}</div>` : ''}
        </div>
        <button class="btn small ghost" data-run="${name}" ${j.running ? 'disabled' : ''}>${j.running ? 'Running…' : 'Run now'}</button>
      </div>`).join('')}
  </div>`;
  body.querySelectorAll('[data-run]').forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = 'Running…';
    try { await api(`/jobs/${b.dataset.run}/run`, { method: 'POST' }); } catch (e) { alert(e.message); }
    render();
  }));
}

// ---------- orders ----------
async function orders() {
  const list = await api('/orders');
  const body = document.getElementById('body');
  if (!list.length) { body.innerHTML = '<p class="panel muted">No orders yet.</p>'; return; }
  body.innerHTML = `<div class="panel scroll"><table>
    <tr><th>Order</th><th>Ship to</th><th>Items</th><th>Total</th><th>Status</th></tr>
    ${list.map((o) => `
      <tr>
        <td><b>${esc(o.id)}</b><br><span class="muted">${new Date(o.createdAt).toLocaleString()}</span><br>
          <span class="muted">${esc(o.payment?.provider || '')}</span></td>
        <td>${esc(o.customer.name)}<br><span class="muted">${esc(o.customer.email)}<br>
          ${esc(o.customer.city)}, ${esc(o.customer.state)} ${esc(o.customer.zip)}</span></td>
        <td>${o.items.map((i) => `${esc(i.name)} × ${i.qty}`).join('<br>')}</td>
        <td>${money(o.total)}</td>
        <td>
          <span class="status ${esc(o.status)}">${esc(o.status.replace(/_/g, ' '))}</span>
          ${o.supplierOrder?.supplierOrderId ? `<div class="muted">Supplier #${esc(o.supplierOrder.supplierOrderId)}</div>` : ''}
          ${o.tracking ? `<div class="muted">${esc(o.tracking.carrier)} ${esc(o.tracking.number)}</div>` : ''}
          ${o.fulfilment?.lastError ? `<div class="warn">Attempt ${o.fulfilment.attempts}: ${esc(o.fulfilment.lastError)}</div>` : ''}
          ${o.refundReason ? `<div class="muted">Refund: ${esc(o.refundReason)}</div>` : ''}
          <div class="actions">
            ${['needs_attention', 'paid'].includes(o.status) ? `<button class="btn small" data-retry="${esc(o.id)}">Retry supplier order</button>` : ''}
            ${['paid', 'needs_attention', 'ordered_from_supplier', 'shipped', 'delivered'].includes(o.status) ? `<button class="btn small ghost" data-refund="${esc(o.id)}">Refund</button>` : ''}
          </div>
        </td>
      </tr>`).join('')}
  </table></div>`;
  const act = (fn) => async (e) => { e.target.disabled = true; try { await fn(e.target); } catch (err) { alert(err.message); } render(); };
  body.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = act((t) => api(`/orders/${t.dataset.retry}/retry`, { method: 'POST' }))));
  body.querySelectorAll('[data-refund]').forEach((b) => (b.onclick = act((t) => {
    const reason = prompt('Refund the full amount to the customer? Reason (sent to the customer):', 'customer request');
    if (reason === null) return;
    return api(`/orders/${t.dataset.refund}/refund`, { method: 'POST', body: JSON.stringify({ reason }) });
  })));
}

// ---------- products ----------
async function products(s) {
  const list = await api('/products');
  const body = document.getElementById('body');
  const review = list.filter((p) => p.review === 'needs_review');
  const rest = list.filter((p) => p.review !== 'needs_review');
  body.innerHTML = `
    ${review.length ? `<div class="panel"><strong>Waiting for your FDA check (${review.length})</strong>
      <p class="muted" style="font-size:14px">These go on the skin/hair/nails, so US law treats them as cosmetics. Before approving, confirm the supplier has
      FDA facility registration and a product listing, and English ingredient labels. Then approve and they go live automatically.</p>
      ${review.map((p) => `<div class="row"><span>${esc(p.name)} <span class="muted">· ${money(p.price)} · profit ${money(p.quote.profit)}</span></span>
        <span class="actions"><button class="btn small" data-approve="${esc(p.id)}">Approve</button><button class="btn small ghost" data-reject="${esc(p.id)}">Reject</button></span></div>`).join('')}
    </div>` : ''}
    <div class="panel scroll"><table>
      <tr><th>Product</th><th>Cost + ship</th><th>Duty</th><th>Landed</th><th>Price</th><th>Profit</th><th></th></tr>
      ${rest.map((p) => `
        <tr>
          <td><b>${esc(p.name)}</b><br><span class="muted">${esc(p.category)} · demand ${p.demandScore ?? '-'} · ${esc(p.source || 'seed')}</span>
            ${p.hiddenReason ? `<br><span class="warn">Hidden: ${esc(p.hiddenReason)}</span>` : ''}
            ${p.review === 'rejected' ? '<br><span class="warn">Rejected</span>' : ''}</td>
          <td>${money(p.supplierCost)} + ${money(p.shippingCost)}</td>
          <td>${money(p.quote.duty)}</td>
          <td>${money(p.quote.landedCost)}</td>
          <td><input value="${p.price}" data-price="${esc(p.id)}" style="width:80px;padding:4px 6px">
            <div class="muted" style="font-size:12px">${p.manualPrice ? `manual · <a href="#" data-auto="${esc(p.id)}">auto</a>` : 'auto'}</div></td>
          <td>${money(p.price - p.quote.landedCost - (p.price * s.pricing.paymentPctFee + s.pricing.paymentFixedFee))}</td>
          <td><button class="btn small ghost" data-toggle="${esc(p.id)}" data-active="${p.active}">${p.active ? 'Hide' : 'Show'}</button></td>
        </tr>`).join('')}
    </table></div>`;
  const put = (id, b) => api(`/products/${id}`, { method: 'PUT', body: JSON.stringify(b) }).then(render, (e) => alert(e.message));
  body.querySelectorAll('[data-approve]').forEach((b) => (b.onclick = () => put(b.dataset.approve, { active: true })));
  body.querySelectorAll('[data-reject]').forEach((b) => (b.onclick = () => put(b.dataset.reject, { reject: true })));
  body.querySelectorAll('[data-price]').forEach((i) => (i.onchange = () => put(i.dataset.price, { price: i.value })));
  body.querySelectorAll('[data-auto]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); put(a.dataset.auto, { autoPrice: true }); }));
  body.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = () => put(b.dataset.toggle, { active: b.dataset.active !== 'true' })));
}

// ---------- requests ----------
async function requests() {
  const list = await api('/requests');
  const body = document.getElementById('body');
  if (!list.length) { body.innerHTML = '<p class="panel muted">No product requests yet. Share the /#/request page with your audience.</p>'; return; }
  body.innerHTML = `<div class="panel scroll"><table>
    <tr><th>Votes</th><th>Product</th><th>Max price</th><th>Contact</th><th>Status</th></tr>
    ${list.map((r) => `
      <tr>
        <td><b>${r.votes}</b></td>
        <td>${esc(r.product)}${r.link ? `<br><a href="${esc(r.link)}" target="_blank" rel="noopener noreferrer">link</a>` : ''}
          ${r.lastSourcedAt ? `<br><span class="muted">auto-searched ${ago(r.lastSourcedAt)}</span>` : ''}</td>
        <td>${r.maxPrice ? '$' + esc(r.maxPrice) : '-'}</td>
        <td>${esc(r.email) || '-'}</td>
        <td><select data-req="${esc(r.id)}">${['new', 'sourcing', 'listed', 'rejected'].map((s) => `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
      </tr>`).join('')}
  </table></div>`;
  body.querySelectorAll('[data-req]').forEach((s) => (s.onchange = () =>
    api(`/requests/${s.dataset.req}`, { method: 'POST', body: JSON.stringify({ status: s.value }) })));
}

render();
timer = setInterval(() => { if (token && tab === 'automation' && document.visibilityState === 'visible') render(); }, 15000);
