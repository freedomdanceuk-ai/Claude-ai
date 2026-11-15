// The automation engine. Background jobs that run the business hands-free:
//
//   fulfil    paid orders → create + pay supplier order (retries, then auto-refund)
//   tracking  supplier ships → save tracking, email customer; delivered → email
//   discover  find trending beauty products on the supplier, price them, list them
//   requests  customer requests with enough votes → find on supplier, list, email requester
//
// Every job is safe to re-run; each order step is idempotent.
const db = require('./db');
const pricing = require('./pricing');
const supplier = require('./supplier');
const paypal = require('./paypal');
const email = require('./email');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const envNum = (k, d) => Number(env(k, d));
const envBool = (k, d) => String(env(k, d)) === 'true';

const KEYWORDS = env('DISCOVERY_KEYWORDS',
  'face serum,sheet mask,gua sha,lash,makeup brush,heatless curl,nail art,hair clip,makeup sponge,facial cleansing brush,lip oil,scalp massager'
).split(',').map((s) => s.trim()).filter(Boolean);

// Products we never list: drug/medical claims or substances banned in US cosmetics.
const BLOCKED = /whiten|bleach|lighten|hydroquinone|mercury|acne treat|hair growth|minoxidil|teeth|tooth|lash growth|brow growth|prescription|medical|injection|filler|needle|microneedl|derma ?roller|botox|weight loss|slimming|led mask|laser|tattoo|cbd|hemp/i;
// Products applied to the body are cosmetics under FDA rules (MoCRA).
const COSMETIC = /serum|cream|lotion|mask|essence|toner|oil|balm|gel|glue|adhesive|shampoo|conditioner|lipstick|gloss|foundation|concealer|mascara|eyeliner|eyeshadow|blush|powder|sunscreen|spf|cleanser|moistur|perfume|fragrance|dye|tint|scrub|polish|primer|spray/i;
const CATEGORY = [
  [/nail/i, 'Nails'], [/hair|scalp|curl|clip|wig|brush.*hair/i, 'Hair'],
  [/lash|lip|eye|brow|makeup|foundation|concealer|blush|sponge|palette/i, 'Makeup'],
  [/serum|cream|mask|toner|essence|cleans|skin|moistur/i, 'Skincare'],
];
const categorise = (name) => (CATEGORY.find(([re]) => re.test(name)) || [, 'Tools'])[1];

let data;
const state = {}; // job name → { running, lastRun, lastResult, lastError }

// ---------------------------------------------------------------- orders

function setStatus(order, status, extra = {}) {
  Object.assign(order, extra);
  if (order.status !== status) {
    order.status = status;
    order.history.push({ at: db.now(), status });
  }
}

async function refund(order, reason) {
  if (['refunded', 'cancelled'].includes(order.status)) return order;
  if (order.payment?.provider === 'paypal' && order.payment.captureId) {
    await paypal.refundCapture(order.payment.captureId, order.id, `Refund for order ${order.id}`);
  }
  setStatus(order, 'refunded', { refundReason: reason });
  db.save();
  email.toCustomer(order, 'refunded');
  email.toAdmin(`Order ${order.id} refunded`, `Reason: ${reason}`);
  return order;
}

async function fulfilOne(order) {
  const byId = Object.fromEntries(data.products.map((p) => [p.id, p]));
  order.supplierOrder = order.supplierOrder || {};
  const so = order.supplierOrder;
  if (!so.supplierOrderId) {
    so.supplierOrderId = await supplier.createOrder(order, byId);
    db.save(); // persist before paying so a retry never double-orders
  }
  if (!so.paid) {
    await supplier.payOrder(so.supplierOrderId);
    so.paid = true;
    so.placedAt = db.now();
  }
  so.mode = supplier.live() ? 'cj' : 'mock';
  setStatus(order, 'ordered_from_supplier');
  delete order.fulfilment;
  db.save();
}

const BACKOFF_MIN = [2, 10, 30, 60, 120];

async function fulfil() {
  const due = data.orders.filter(
    (o) => o.status === 'paid' && (!o.fulfilment?.nextAttemptAt || new Date(o.fulfilment.nextAttemptAt) <= new Date())
  );
  let ok = 0, failed = 0;
  for (const o of due) {
    try {
      await fulfilOne(o);
      ok++;
    } catch (e) {
      failed++;
      const f = (o.fulfilment = o.fulfilment || { attempts: 0 });
      f.attempts++;
      f.lastError = e.message;
      const max = envNum('MAX_FULFIL_ATTEMPTS', 5);
      if (f.attempts >= max) {
        if (envBool('AUTO_REFUND_ON_FAILURE', 'true')) {
          try { await refund(o, 'the item could not be ordered from our supplier'); }
          catch (re) {
            setStatus(o, 'needs_attention');
            email.toAdmin(`Refund failed for ${o.id}`, `${e.message} / refund: ${re.message}`);
          }
        } else {
          setStatus(o, 'needs_attention');
          email.toAdmin(`Order ${o.id} needs attention`, `Supplier ordering failed ${f.attempts} times: ${e.message}`);
        }
      } else {
        f.nextAttemptAt = new Date(Date.now() + BACKOFF_MIN[Math.min(f.attempts - 1, BACKOFF_MIN.length - 1)] * 60000).toISOString();
      }
      db.save();
    }
  }
  return { due: due.length, ok, failed };
}

async function tracking() {
  const open = data.orders.filter((o) => ['ordered_from_supplier', 'shipped'].includes(o.status) && o.supplierOrder?.placedAt);
  let shipped = 0, delivered = 0;
  for (const o of open) {
    try {
      const s = await supplier.orderStatus(o.supplierOrder);
      if (s.status === 'cancelled') {
        await refund(o, 'the supplier cancelled the order');
        continue;
      }
      if (['shipped', 'delivered'].includes(s.status) && o.status === 'ordered_from_supplier' && s.trackingNumber) {
        setStatus(o, 'shipped', { tracking: { carrier: s.carrier, number: s.trackingNumber } });
        db.save();
        email.toCustomer(o, 'shipped');
        shipped++;
      }
      if (s.status === 'delivered' && o.status === 'shipped') {
        setStatus(o, 'delivered');
        db.save();
        email.toCustomer(o, 'delivered');
        delivered++;
      }
    } catch (e) {
      o.trackingError = e.message;
      db.save();
    }
  }
  return { checked: open.length, shipped, delivered };
}

// ---------------------------------------------------------------- catalog

/** Price a supplier product and add it to the shop. Returns the product or null. */
async function importProduct(found, { source }) {
  if (BLOCKED.test(found.name)) return null;
  const existing = data.products.find((p) => p.supplierPid === found.pid);
  if (existing) return existing;
  const d = await supplier.details(found.pid);
  if (!d) return null;
  const q = pricing.quote({ supplierCost: d.cost, shippingCost: d.shippingCost });
  if (q.price > envNum('MAX_RETAIL_PRICE', 40) || q.profit < envNum('MIN_PROFIT', 3)) return null;

  const cosmetic = COSMETIC.test(found.name);
  const needsReview = cosmetic && envBool('REVIEW_COSMETICS', 'true');
  const p = {
    id: db.id('p'),
    name: found.name.replace(/\s+/g, ' ').trim().slice(0, 90),
    category: categorise(found.name),
    description: `Shipped to your door in about ${d.days || '7–15'} days. Import duties included.`,
    image: d.image || found.image || '',
    supplierPid: found.pid,
    supplierSku: d.vid,
    logistic: d.logistic,
    supplierCost: d.cost,
    shippingCost: d.shippingCost,
    price: q.price,
    cosmetic,
    active: !needsReview,
    review: needsReview ? 'needs_review' : undefined,
    hue: Math.floor(Math.random() * 360),
    demandScore: Math.min(99, 50 + Math.round(Math.log10(1 + (found.popularity || 0)) * 15)),
    source,
    importedAt: db.now(),
  };
  data.products.push(p);
  db.save();
  return p;
}

async function discover() {
  if (!supplier.live()) return { skipped: 'Supplier is in mock mode. Add CJ_API_KEY to discover real products.' };
  // 1) Refresh existing supplier products: cost changes, out-of-stock, re-price.
  let refreshed = 0, hidden = 0;
  for (const p of data.products.filter((x) => x.supplierPid)) {
    try {
      const d = await supplier.details(p.supplierPid);
      if (!d) { if (p.active) { p.active = false; p.hiddenReason = 'unavailable at supplier'; hidden++; } continue; }
      Object.assign(p, { supplierSku: d.vid, supplierCost: d.cost, shippingCost: d.shippingCost, logistic: d.logistic });
      if (!p.manualPrice) p.price = pricing.quote(p).price;
      if (p.hiddenReason === 'unavailable at supplier') { p.active = true; delete p.hiddenReason; }
      refreshed++;
    } catch { /* try again next run */ }
  }
  // Products with no supplier link can't be fulfilled automatically: hide them.
  for (const p of data.products.filter((x) => !x.supplierSku && x.active)) { p.active = false; p.hiddenReason = 'no supplier link'; hidden++; }
  db.save();

  // 2) Find new trending products.
  const perKeyword = envNum('DISCOVERY_PER_KEYWORD', 2);
  let budget = envNum('MAX_NEW_PRODUCTS_PER_RUN', 10);
  const added = [], review = [];
  for (const kw of KEYWORDS) {
    if (budget <= 0) break;
    let results = [];
    try { results = await supplier.search(kw, 20); } catch { continue; }
    results.sort((a, b) => b.popularity - a.popularity);
    let taken = 0;
    for (const r of results) {
      if (taken >= perKeyword || budget <= 0) break;
      if (data.products.some((p) => p.supplierPid === r.pid)) continue;
      try {
        const p = await importProduct(r, { source: `discover:${kw}` });
        if (p) { taken++; budget--; (p.active ? added : review).push(p.name); }
      } catch { /* skip this one */ }
    }
  }
  if (added.length || review.length) {
    email.toAdmin('New products found',
      `Listed automatically: ${added.join('; ') || 'none'}. Waiting for your FDA check: ${review.join('; ') || 'none'}.`);
  }
  return { refreshed, hidden, added: added.length, needsReview: review.length };
}

async function requests() {
  const minVotes = envNum('REQUEST_AUTO_SOURCE_VOTES', 3);
  const weekAgo = Date.now() - 7 * 86400000;
  const due = data.requests.filter(
    (r) => r.status === 'new' && r.votes >= minVotes && (!r.lastSourcedAt || new Date(r.lastSourcedAt).getTime() < weekAgo)
  );
  let listed = 0, review = 0, notFound = 0;
  for (const r of due) {
    r.lastSourcedAt = db.now();
    if (BLOCKED.test(r.product)) { r.status = 'rejected'; continue; }
    try {
      const results = (await supplier.search(r.product, 10)).sort((a, b) => b.popularity - a.popularity);
      let p = null;
      for (const found of results.slice(0, 3)) { p = await importProduct(found, { source: `request:${r.id}` }); if (p) break; }
      if (!p) { notFound++; continue; }
      r.productId = p.id;
      if (p.active) { r.status = 'listed'; listed++; email.requestListed(r, p); }
      else { r.status = 'sourcing'; review++; }
    } catch { notFound++; }
  }
  db.save();
  return { due: due.length, listed, needsReview: review, notFound };
}

/** When an admin approves a reviewed product, tell anyone who requested it. */
function onProductActivated(p) {
  for (const r of data.requests.filter((x) => x.productId === p.id && x.status === 'sourcing')) {
    r.status = 'listed';
    email.requestListed(r, p);
  }
  db.save();
}

// ---------------------------------------------------------------- scheduler

const JOBS = { fulfil, tracking, discover, requests };
const INTERVALS = {
  fulfil: () => envNum('JOB_FULFIL_SEC', 60),
  tracking: () => envNum('JOB_TRACKING_SEC', supplier.live() ? 3600 : 30),
  discover: () => envNum('JOB_DISCOVER_SEC', 86400),
  requests: () => envNum('JOB_REQUESTS_SEC', 3600),
};

async function run(name) {
  const s = (state[name] = state[name] || {});
  if (s.running) return { busy: true };
  s.running = true;
  try {
    s.lastResult = await JOBS[name]();
    s.lastError = null;
  } catch (e) {
    s.lastError = e.message;
    console.error(`[job ${name}]`, e);
  } finally {
    s.running = false;
    s.lastRun = db.now();
  }
  return s;
}

function start(d) {
  data = d;
  if (process.env.AUTOMATION === 'off') return console.log('Automation is OFF');
  for (const name of Object.keys(JOBS)) {
    setTimeout(() => run(name), 3000).unref?.();
    setInterval(() => run(name), INTERVALS[name]() * 1000).unref?.();
  }
}

const status = () =>
  Object.fromEntries(Object.keys(JOBS).map((n) => [n, { everySec: INTERVALS[n](), ...(state[n] || {}) }]));

module.exports = { start, run, status, refund, onProductActivated, JOBS: Object.keys(JOBS) };
