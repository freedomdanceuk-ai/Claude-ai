const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./lib/db');
const pricing = require('./lib/pricing');
const payments = require('./lib/payments');
const supplier = require('./lib/supplier');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';
const FREE_SHIPPING_OVER = 35;
const SHIPPING_FEE = 4.99;

const STATUSES = ['pending_payment', 'paid', 'ordered_from_supplier', 'shipped', 'delivered', 'cancelled', 'refunded'];

const data = db.load();
// Fill in retail prices for products that don't have one yet.
for (const p of data.products) if (p.price == null) p.price = pricing.quote(p).price;
db.save();

const app = express();

// ---------- Stripe webhook (needs the raw body, so it goes before express.json) ----------
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const raw = req.body.toString('utf8');
  if (!payments.verifyWebhook(raw, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET)) {
    return res.status(400).send('Bad signature');
  }
  const event = JSON.parse(raw);
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const order = data.orders.find((o) => o.id === s.metadata?.orderId);
    if (order && order.status === 'pending_payment' && s.payment_status === 'paid') {
      markPaid(order, { provider: 'stripe', sessionId: s.id, paymentIntent: s.payment_intent });
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const publicProduct = ({ supplierCost, shippingCost, supplierSku, ...p }) => p;
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function publicOrder(o) {
  const { customer, payment, supplierOrder, notes, ...rest } = o;
  return { ...rest, customer: { name: customer.name, city: customer.city, state: customer.state } };
}

function markPaid(order, payment) {
  order.status = 'paid';
  order.payment = payment;
  order.history.push({ at: db.now(), status: 'paid' });
  db.save();
}

function requireAdmin(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer /, '');
  const a = Buffer.from(token), b = Buffer.from(ADMIN_TOKEN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ---------- public API ----------
app.get('/api/config', (req, res) => {
  res.json({
    paymentsMode: payments.enabled() ? 'stripe' : 'demo',
    freeShippingOver: FREE_SHIPPING_OVER,
    shippingFee: SHIPPING_FEE,
    deliveryEstimate: '7–15 business days',
  });
});

app.get('/api/products', (req, res) => {
  res.json(data.products.filter((p) => p.active).map(publicProduct));
});

app.get('/api/products/:id', (req, res) => {
  const p = data.products.find((x) => x.id === req.params.id && x.active);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(publicProduct(p));
});

app.post('/api/checkout', async (req, res) => {
  try {
    const { items = [], customer = {} } = req.body;
    const c = {
      name: clean(customer.name, 100), email: clean(customer.email, 150).toLowerCase(),
      phone: clean(customer.phone, 30), address1: clean(customer.address1), address2: clean(customer.address2),
      city: clean(customer.city, 80), state: clean(customer.state, 40), zip: clean(customer.zip, 10),
    };
    if (!c.name || !isEmail(c.email) || !c.address1 || !c.city || !c.state || !/^\d{5}(-\d{4})?$/.test(c.zip)) {
      return res.status(400).json({ error: 'Please fill in your name, a valid email and a full US address.' });
    }
    // Prices always come from the server, never from the browser.
    const lines = [];
    for (const it of items.slice(0, 50)) {
      const p = data.products.find((x) => x.id === it.id && x.active);
      const qty = Math.min(Math.max(parseInt(it.qty, 10) || 0, 0), 20);
      if (p && qty) lines.push({ productId: p.id, name: p.name, price: p.price, qty });
    }
    if (!lines.length) return res.status(400).json({ error: 'Your cart is empty.' });

    const subtotal = Math.round(lines.reduce((s, l) => s + l.price * l.qty, 0) * 100) / 100;
    const shippingFee = subtotal >= FREE_SHIPPING_OVER ? 0 : SHIPPING_FEE;
    const order = {
      id: db.id('ord').toUpperCase().replace('ORD_', 'BB-'),
      createdAt: db.now(), status: 'pending_payment',
      items: lines, subtotal, shippingFee, total: Math.round((subtotal + shippingFee) * 100) / 100,
      customer: c, tracking: null, history: [{ at: db.now(), status: 'pending_payment' }],
    };
    data.orders.push(order);
    db.save();

    if (payments.enabled()) {
      const session = await payments.createCheckoutSession(order, BASE_URL);
      order.payment = { provider: 'stripe', sessionId: session.id };
      db.save();
      return res.json({ orderId: order.id, url: session.url });
    }
    res.json({ orderId: order.id, demo: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// Demo-only: simulate a successful payment when Stripe isn't configured.
app.post('/api/orders/:id/demo-pay', (req, res) => {
  if (payments.enabled()) return res.status(403).json({ error: 'Disabled when Stripe is configured' });
  const o = data.orders.find((x) => x.id === req.params.id);
  if (!o || o.customer.email !== clean(req.body.email, 150).toLowerCase()) return res.status(404).json({ error: 'Not found' });
  if (o.status === 'pending_payment') markPaid(o, { provider: 'demo' });
  res.json(publicOrder(o));
});

app.get('/api/orders/:id', (req, res) => {
  const o = data.orders.find((x) => x.id === clean(req.params.id, 40).toUpperCase());
  if (!o || o.customer.email !== clean(req.query.email, 150).toLowerCase()) {
    return res.status(404).json({ error: 'No order found with that number and email.' });
  }
  res.json(publicOrder(o));
});

// Product requests: customers tell you what they want (free demand research).
app.get('/api/requests', (req, res) => {
  res.json(
    data.requests
      .filter((r) => r.status !== 'rejected')
      .sort((a, b) => b.votes - a.votes)
      .slice(0, 50)
      .map(({ email, ...r }) => r)
  );
});

app.post('/api/requests', (req, res) => {
  const product = clean(req.body.product, 120);
  const email = clean(req.body.email, 150).toLowerCase();
  if (product.length < 3) return res.status(400).json({ error: 'Tell us what product you want.' });
  if (email && !isEmail(email)) return res.status(400).json({ error: 'That email looks wrong.' });
  const dup = data.requests.find((r) => r.product.toLowerCase() === product.toLowerCase());
  if (dup) { dup.votes++; db.save(); return res.json({ ...dup, email: undefined, merged: true }); }
  const r = {
    id: db.id('req'), product, link: /^https?:\/\//i.test(clean(req.body.link, 300)) ? clean(req.body.link, 300) : '', maxPrice: clean(req.body.maxPrice, 10),
    email, votes: 1, status: 'new', createdAt: db.now(),
  };
  data.requests.push(r);
  db.save();
  res.json({ ...r, email: undefined });
});

app.post('/api/requests/:id/vote', (req, res) => {
  const r = data.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  r.votes++;
  db.save();
  res.json({ id: r.id, votes: r.votes });
});

// ---------- admin API ----------
const admin = express.Router();
admin.use(requireAdmin);

admin.get('/summary', (req, res) => {
  const paid = data.orders.filter((o) => !['pending_payment', 'cancelled', 'refunded'].includes(o.status));
  const byId = Object.fromEntries(data.products.map((p) => [p.id, p]));
  const revenue = paid.reduce((s, o) => s + o.total, 0);
  const cost = paid.reduce(
    (s, o) => s + o.items.reduce((t, it) => t + (byId[it.productId] ? pricing.quote(byId[it.productId]).landedCost * it.qty : 0), 0),
    0
  );
  const pc = pricing.config();
  const fees = paid.reduce((s, o) => s + o.total * pc.paymentPctFee + pc.paymentFixedFee, 0);
  res.json({
    orders: data.orders.length, paidOrders: paid.length,
    toFulfil: data.orders.filter((o) => o.status === 'paid').length,
    revenue: Math.round(revenue * 100) / 100, estProfit: Math.round((revenue - cost - fees) * 100) / 100,
    openRequests: data.requests.filter((r) => r.status === 'new').length,
    paymentsMode: payments.enabled() ? 'stripe' : 'demo', supplierMode: supplier.enabled() ? 'cj' : 'mock',
    pricing: pricing.config(),
  });
});

admin.get('/orders', (req, res) => res.json([...data.orders].reverse()));

admin.post('/orders/:id/fulfil', async (req, res) => {
  const o = data.orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  if (o.status !== 'paid') return res.status(400).json({ error: 'Only paid orders can be sent to the supplier.' });
  try {
    const byId = Object.fromEntries(data.products.map((p) => [p.id, p]));
    const result = await supplier.placeOrder(o, byId);
    o.supplierOrder = { ...result, placedAt: db.now() };
    o.status = 'ordered_from_supplier';
    o.history.push({ at: db.now(), status: o.status });
    db.save();
    res.json(o);
  } catch (e) {
    res.status(502).json({ error: `Supplier error: ${e.message}` });
  }
});

admin.post('/orders/:id/status', (req, res) => {
  const o = data.orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  const { status, carrier, trackingNumber, note, supplierOrderId } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status' });
  if (trackingNumber) o.tracking = { carrier: clean(carrier, 40) || 'USPS', number: clean(trackingNumber, 60) };
  if (supplierOrderId) o.supplierOrder = { ...(o.supplierOrder || {}), supplierOrderId: clean(supplierOrderId, 60) };
  if (note) o.notes = [...(o.notes || []), { at: db.now(), text: clean(note, 500) }];
  if (status && status !== o.status) { o.status = status; o.history.push({ at: db.now(), status }); }
  db.save();
  res.json(o);
});

admin.get('/products', (req, res) => res.json(data.products.map((p) => ({ ...p, quote: pricing.quote(p) }))));

admin.post('/quote', (req, res) => {
  try { res.json(pricing.quote(req.body)); } catch (e) { res.status(400).json({ error: e.message }); }
});

function productFields(b) {
  const out = {};
  for (const k of ['name', 'category', 'description', 'supplierSku']) if (b[k] !== undefined) out[k] = clean(b[k], k === 'description' ? 1000 : 120);
  for (const k of ['supplierCost', 'shippingCost', 'price', 'hue', 'demandScore']) if (b[k] !== undefined && b[k] !== '') out[k] = Number(b[k]);
  for (const k of ['cosmetic', 'active']) if (b[k] !== undefined) out[k] = Boolean(b[k]);
  return out;
}

admin.post('/products', (req, res) => {
  const f = productFields(req.body);
  if (!f.name || !(f.supplierCost >= 0)) return res.status(400).json({ error: 'Name and supplier cost are required.' });
  const p = { id: db.id('p'), category: 'Skincare', description: '', shippingCost: 0, supplierSku: '', cosmetic: false,
    active: true, hue: Math.floor(Math.random() * 360), demandScore: 50, ...f };
  if (!(p.price > 0)) p.price = pricing.quote(p).price;
  data.products.push(p);
  db.save();
  res.json(p);
});

admin.put('/products/:id', (req, res) => {
  const p = data.products.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  Object.assign(p, productFields(req.body));
  if (req.body.repriced) p.price = pricing.quote(p).price;
  db.save();
  res.json(p);
});

admin.get('/requests', (req, res) => res.json([...data.requests].sort((a, b) => b.votes - a.votes)));

admin.post('/requests/:id', (req, res) => {
  const r = data.requests.find((x) => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  if (['new', 'sourcing', 'listed', 'rejected'].includes(req.body.status)) r.status = req.body.status;
  db.save();
  res.json(r);
});

app.use('/api/admin', admin);

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, () => {
  console.log(`BeautyBridge running at ${BASE_URL}`);
  console.log(`Payments: ${payments.enabled() ? 'Stripe' : 'DEMO (no real charges)'} | Supplier: ${supplier.enabled() ? 'CJdropshipping' : 'MOCK'}`);
  if (ADMIN_TOKEN === 'change-me') console.warn('WARNING: set ADMIN_TOKEN before deploying.');
});
