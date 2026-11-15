const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./lib/db');
const pricing = require('./lib/pricing');
const paypal = require('./lib/paypal');
const supplier = require('./lib/supplier');
const email = require('./lib/email');
const automation = require('./lib/automation');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me';
const FREE_SHIPPING_OVER = Number(process.env.FREE_SHIPPING_OVER || 35);
const SHIPPING_FEE = Number(process.env.SHIPPING_FEE || 4.99);

const STATUSES = ['pending_payment', 'paid', 'ordered_from_supplier', 'shipped', 'delivered', 'needs_attention', 'cancelled', 'refunded'];

const data = db.load();
for (const p of data.products) if (p.price == null) p.price = pricing.quote(p).price;
db.save();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const publicProduct = ({ supplierCost, shippingCost, supplierSku, supplierPid, logistic, source, review, hiddenReason, manualPrice, importedAt, ...p }) => p;
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const findOrder = (id) => data.orders.find((x) => x.id === clean(id, 40).toUpperCase());

function publicOrder(o) {
  const { customer, payment, supplierOrder, notes, fulfilment, trackingError, ...rest } = o;
  return { ...rest, customer: { name: customer.name, city: customer.city, state: customer.state } };
}

function markPaid(order, payment) {
  if (order.status !== 'pending_payment') return;
  order.status = 'paid';
  order.payment = payment;
  order.history.push({ at: db.now(), status: 'paid' });
  db.save();
  email.toCustomer(order, 'confirmed');
  automation.run('fulfil'); // send to the supplier right away
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
    paymentsMode: paypal.enabled() ? 'paypal' : 'demo',
    paypalClientId: paypal.enabled() ? process.env.PAYPAL_CLIENT_ID : null,
    freeShippingOver: FREE_SHIPPING_OVER,
    shippingFee: SHIPPING_FEE,
    deliveryEstimate: '7–15 business days',
  });
});

app.get('/api/products', (req, res) => res.json(data.products.filter((p) => p.active).map(publicProduct)));

app.get('/api/products/:id', (req, res) => {
  const p = data.products.find((x) => x.id === req.params.id && x.active);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(publicProduct(p));
});

// Step 1: create our order (+ PayPal order). Called by the PayPal button's createOrder.
app.post('/api/checkout', async (req, res) => {
  try {
    const { items = [], customer = {} } = req.body;
    const c = {
      name: clean(customer.name, 100), email: clean(customer.email, 150).toLowerCase(),
      phone: clean(customer.phone, 30), address1: clean(customer.address1, 100), address2: clean(customer.address2, 100),
      city: clean(customer.city, 80), state: clean(customer.state, 2).toUpperCase(), zip: clean(customer.zip, 10),
    };
    if (!c.name || !isEmail(c.email) || !c.address1 || !c.city || !/^[A-Z]{2}$/.test(c.state) || !/^\d{5}(-\d{4})?$/.test(c.zip)) {
      return res.status(400).json({ error: 'Please fill in your name, a valid email and a full US address (2-letter state).' });
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
      id: 'BB-' + crypto.randomBytes(5).toString('hex').toUpperCase(),
      createdAt: db.now(), status: 'pending_payment',
      items: lines, subtotal, shippingFee, total: Math.round((subtotal + shippingFee) * 100) / 100,
      customer: c, tracking: null, history: [{ at: db.now(), status: 'pending_payment' }],
    };
    data.orders.push(order);
    db.save();

    if (paypal.enabled()) {
      const pp = await paypal.createOrder(order);
      order.payment = { provider: 'paypal', paypalOrderId: pp.id };
      db.save();
      return res.json({ orderId: order.id, paypalOrderId: pp.id });
    }
    res.json({ orderId: order.id, demo: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// Step 2: buyer approved in PayPal → capture the money.
app.post('/api/paypal/capture', async (req, res) => {
  const o = findOrder(req.body.orderId);
  if (!o || !o.payment?.paypalOrderId) return res.status(404).json({ error: 'Order not found' });
  if (o.status !== 'pending_payment') return res.json(publicOrder(o)); // already captured (e.g. by webhook)
  try {
    const cap = await paypal.captureOrder(o.payment.paypalOrderId, o.id);
    if (cap.status !== 'COMPLETED' || cap.currency !== 'USD' || Math.abs(cap.amount - o.total) > 0.005) {
      console.error('Capture mismatch', o.id, cap);
      return res.status(402).json({ error: 'Payment was not completed. You have not been charged.' });
    }
    markPaid(o, { ...o.payment, captureId: cap.captureId });
    res.json(publicOrder(o));
  } catch (e) {
    console.error(e);
    res.status(402).json({ error: 'PayPal could not complete the payment. Please try another method.' });
  }
});

// Backup path: PayPal tells us about payments/refunds even if the buyer closed the browser.
app.post('/api/paypal/webhook', async (req, res) => {
  try {
    if (!(await paypal.verifyWebhook(req.headers, req.body))) return res.status(400).send('Bad signature');
  } catch (e) {
    console.error('Webhook verification error', e.message);
    return res.status(500).send('Verification error');
  }
  const ev = req.body, r = ev.resource || {};
  const o = findOrder(r.custom_id || r.invoice_id || '');
  if (o) {
    if (ev.event_type === 'PAYMENT.CAPTURE.COMPLETED' && Math.abs(Number(r.amount?.value) - o.total) <= 0.005) {
      markPaid(o, { ...(o.payment || {}), provider: 'paypal', captureId: r.id });
    }
    if (['PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED'].includes(ev.event_type) && o.status !== 'refunded') {
      o.status = 'refunded';
      o.history.push({ at: db.now(), status: 'refunded' });
      db.save();
      email.toAdmin(`PayPal ${ev.event_type} on ${o.id}`, 'Check whether the supplier order should be cancelled.');
    }
  }
  res.json({ received: true });
});

// Demo-only: simulate a successful payment when PayPal isn't configured.
app.post('/api/orders/:id/demo-pay', (req, res) => {
  if (paypal.enabled()) return res.status(403).json({ error: 'Disabled when PayPal is configured' });
  const o = findOrder(req.params.id);
  if (!o || o.customer.email !== clean(req.body.email, 150).toLowerCase()) return res.status(404).json({ error: 'Not found' });
  markPaid(o, { provider: 'demo' });
  res.json(publicOrder(o));
});

app.get('/api/orders/:id', (req, res) => {
  const o = findOrder(req.params.id);
  if (!o || o.customer.email !== clean(req.query.email, 150).toLowerCase()) {
    return res.status(404).json({ error: 'No order found with that number and email.' });
  }
  res.json(publicOrder(o));
});

// Product requests: customers tell you what they want; popular ones are sourced automatically.
app.get('/api/requests', (req, res) => {
  res.json(
    data.requests.filter((r) => r.status !== 'rejected').sort((a, b) => b.votes - a.votes).slice(0, 50)
      .map(({ email: _e, lastSourcedAt, ...r }) => r)
  );
});

app.post('/api/requests', (req, res) => {
  const product = clean(req.body.product, 120);
  const mail = clean(req.body.email, 150).toLowerCase();
  const link = clean(req.body.link, 300);
  if (product.length < 3) return res.status(400).json({ error: 'Tell us what product you want.' });
  if (mail && !isEmail(mail)) return res.status(400).json({ error: 'That email looks wrong.' });
  const dup = data.requests.find((r) => r.product.toLowerCase() === product.toLowerCase());
  if (dup) {
    dup.votes++;
    if (!dup.email && mail) dup.email = mail;
    db.save();
    return res.json({ id: dup.id, product: dup.product, votes: dup.votes, status: dup.status, merged: true });
  }
  const r = {
    id: db.id('req'), product, link: /^https?:\/\//i.test(link) ? link : '', maxPrice: clean(req.body.maxPrice, 10),
    email: mail, votes: 1, status: 'new', createdAt: db.now(),
  };
  data.requests.push(r);
  db.save();
  res.json({ id: r.id, product: r.product, votes: r.votes, status: r.status });
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
  const pc = pricing.config();
  const revenue = paid.reduce((s, o) => s + o.total, 0);
  const cost = paid.reduce((s, o) => s + o.items.reduce((t, it) => t + (byId[it.productId] ? pricing.quote(byId[it.productId]).landedCost * it.qty : 0), 0), 0);
  const fees = paid.reduce((s, o) => s + o.total * pc.paymentPctFee + pc.paymentFixedFee, 0);
  res.json({
    orders: data.orders.length, paidOrders: paid.length,
    inProgress: data.orders.filter((o) => ['paid', 'ordered_from_supplier', 'shipped'].includes(o.status)).length,
    needsAttention: data.orders.filter((o) => o.status === 'needs_attention').length,
    productsToReview: data.products.filter((p) => p.review === 'needs_review').length,
    revenue: Math.round(revenue * 100) / 100, estProfit: Math.round((revenue - cost - fees) * 100) / 100,
    openRequests: data.requests.filter((r) => r.status === 'new').length,
    paymentsMode: paypal.enabled() ? `paypal (${process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox'})` : 'demo',
    supplierMode: supplier.live() ? 'cj' : 'mock',
    emailMode: process.env.RESEND_API_KEY ? 'resend' : 'log only',
    pricing: pc,
    jobs: automation.status(),
  });
});

admin.post('/jobs/:name/run', async (req, res) => {
  if (!automation.JOBS.includes(req.params.name)) return res.status(404).json({ error: 'Unknown job' });
  res.json(await automation.run(req.params.name));
});

admin.get('/orders', (req, res) => res.json([...data.orders].reverse()));

admin.post('/orders/:id/retry', async (req, res) => {
  const o = findOrder(req.params.id);
  if (!o || !['needs_attention', 'paid'].includes(o.status)) return res.status(400).json({ error: 'Only stuck orders can be retried.' });
  if (o.status !== 'paid') { o.status = 'paid'; o.history.push({ at: db.now(), status: 'paid' }); }
  o.fulfilment = { attempts: 0 };
  db.save();
  await automation.run('fulfil');
  res.json(o);
});

admin.post('/orders/:id/refund', async (req, res) => {
  const o = findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  try { res.json(await automation.refund(o, clean(req.body.reason, 200) || 'refunded by the store')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

admin.post('/orders/:id/status', (req, res) => {
  const o = findOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  const { status, carrier, trackingNumber, note } = req.body;
  if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Bad status' });
  if (trackingNumber) o.tracking = { carrier: clean(carrier, 40) || 'USPS', number: clean(trackingNumber, 60) };
  if (note) o.notes = [...(o.notes || []), { at: db.now(), text: clean(note, 500) }];
  if (status && status !== o.status) {
    o.status = status;
    o.history.push({ at: db.now(), status });
    if (status === 'shipped' && o.tracking) email.toCustomer(o, 'shipped');
    if (status === 'delivered') email.toCustomer(o, 'delivered');
  }
  db.save();
  res.json(o);
});

admin.get('/products', (req, res) => res.json(data.products.map((p) => ({ ...p, quote: pricing.quote(p) }))));

admin.post('/quote', (req, res) => {
  try { res.json(pricing.quote(req.body)); } catch (e) { res.status(400).json({ error: e.message }); }
});

admin.put('/products/:id', (req, res) => {
  const p = data.products.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  if (b.price !== undefined && Number(b.price) > 0) { p.price = Number(b.price); p.manualPrice = true; }
  if (b.autoPrice) { delete p.manualPrice; p.price = pricing.quote(p).price; }
  if (b.name) p.name = clean(b.name, 90);
  if (b.description !== undefined) p.description = clean(b.description, 1000);
  if (b.reject) { p.active = false; p.review = 'rejected'; }
  else if (b.active !== undefined) {
    p.active = Boolean(b.active);
    if (p.active) { delete p.review; delete p.hiddenReason; automation.onProductActivated(p); }
  }
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
  console.log(`Payments: ${paypal.enabled() ? 'PayPal' : 'DEMO (no real charges)'} | Supplier: ${supplier.live() ? 'CJdropshipping' : 'MOCK'} | Email: ${process.env.RESEND_API_KEY ? 'Resend' : 'log only'}`);
  if (ADMIN_TOKEN === 'change-me') console.warn('WARNING: set ADMIN_TOKEN before deploying.');
  automation.start(data);
});
