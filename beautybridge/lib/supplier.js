// Supplier adapter for CJdropshipping (https://developers.cjdropshipping.com).
//
// LIVE mode (CJ_API_KEY set): orders are created on CJ, paid from your CJ wallet
// balance, and CJ ships straight to the customer.
// MOCK mode (no key): a simulated supplier that "ships" and "delivers" after a
// delay, so you can watch the full automatic flow without spending money.
//
// ⚠️ Before going live, check each path in ENDPOINTS and the response fields
// against CJ's current API docs — CJ revises its API from time to time.

const CJ_BASE = process.env.CJ_BASE_URL || 'https://developers.cjdropshipping.com/api2.0/v1';
const ENDPOINTS = {
  token: 'POST /authentication/getAccessToken', // body { apiKey }
  productList: 'GET /product/list', // ?productNameEn=&pageNum=&pageSize=
  variants: 'GET /product/variant/query', // ?pid=
  freight: 'POST /logistic/freightCalculate', // { startCountryCode, endCountryCode, products:[{vid,quantity}] }
  createOrder: 'POST /shopping/order/createOrderV2',
  payBalance: 'POST /shopping/pay/payBalance', // { orderId }
  orderDetail: 'GET /shopping/order/getOrderDetail', // ?orderId=
  trackInfo: 'GET /logistic/getTrackInfo', // ?trackNumber=
};

const live = () => Boolean(process.env.CJ_API_KEY);
let tokenCache = null;

async function cj(name, { query, body } = {}) {
  const [method, path] = ENDPOINTS[name].split(' ');
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const headers = { 'Content-Type': 'application/json' };
  if (name !== 'token') headers['CJ-Access-Token'] = await cjToken();
  const res = await fetch(`${CJ_BASE}${path}${qs}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.result === false || (data.code && data.code !== 200)) {
    throw new Error(`CJ ${name}: ${data.message || res.statusText}`);
  }
  return data.data;
}

async function cjToken() {
  if (tokenCache && tokenCache.expires > Date.now()) return tokenCache.token;
  const d = await cj('token', { body: { apiKey: process.env.CJ_API_KEY } });
  tokenCache = { token: d.accessToken, expires: Date.now() + 12 * 3600 * 1000 };
  return tokenCache.token;
}

const firstNum = (v) => {
  const m = String(v ?? '').match(/[\d.]+/);
  return m ? Number(m[0]) : NaN;
};

// ---------------- catalog ----------------

/** Search beauty products. Returns [{ pid, name, image, cost, popularity, category }] */
async function search(keyword, limit = 20) {
  if (!live()) return mockSearch(keyword);
  const d = await cj('productList', { query: { productNameEn: keyword, pageNum: 1, pageSize: limit } });
  return (d?.list || []).map((p) => ({
    pid: p.pid,
    name: p.productNameEn || p.productName,
    image: p.productImage,
    cost: firstNum(p.sellPrice),
    popularity: Number(p.listedNum || 0),
    category: p.categoryName || '',
  })).filter((p) => p.pid && p.name && p.cost > 0);
}

/** Cheapest in-stock variant plus shipping cost to the US. */
async function details(pid) {
  if (!live()) return mockDetails(pid);
  const variants = await cj('variants', { query: { pid } });
  const list = (Array.isArray(variants) ? variants : variants?.list || [])
    .map((v) => ({ vid: v.vid, cost: firstNum(v.variantSellPrice), image: v.variantImage, name: v.variantNameEn }))
    .filter((v) => v.vid && v.cost > 0)
    .sort((a, b) => a.cost - b.cost);
  if (!list.length) return null;
  const v = list[0];
  const freight = await shippingQuote(v.vid);
  if (!freight) return null;
  return { vid: v.vid, cost: v.cost, image: v.image, shippingCost: freight.price, logistic: freight.name, days: freight.days };
}

async function shippingQuote(vid) {
  const d = await cj('freight', {
    body: { startCountryCode: 'CN', endCountryCode: 'US', products: [{ vid, quantity: 1 }] },
  });
  const maxDays = Number(process.env.MAX_SHIPPING_DAYS || 20);
  const preferred = process.env.CJ_LOGISTIC_NAME;
  const opts = (d || [])
    .map((o) => ({ name: o.logisticName, price: Number(o.logisticPrice), days: Math.max(...String(o.logisticAging).split('-').map(Number).filter(Boolean)) }))
    .filter((o) => o.name && o.price >= 0 && (!o.days || o.days <= maxDays))
    .sort((a, b) => a.price - b.price);
  return opts.find((o) => o.name === preferred) || opts[0] || null;
}

// ---------------- orders ----------------

/** Create the supplier order (idempotent on our order id). Returns supplier order id. */
async function createOrder(order, productsById) {
  if (!live()) return `MOCK-${order.id}`;
  const missing = order.items.filter((it) => !productsById[it.productId]?.supplierSku);
  if (missing.length) throw new Error(`No supplier variant for: ${missing.map((m) => m.name).join(', ')}`);
  const a = order.customer;
  const d = await cj('createOrder', {
    body: {
      orderNumber: order.id,
      shippingCountryCode: 'US',
      shippingCountry: 'United States',
      shippingProvince: a.state,
      shippingCity: a.city,
      shippingZip: a.zip,
      shippingAddress: a.address1,
      shippingAddress2: a.address2 || '',
      shippingCustomerName: a.name,
      shippingPhone: a.phone || '0000000000',
      email: a.email,
      fromCountryCode: 'CN',
      logisticName: order.items.map((it) => productsById[it.productId].logistic).find(Boolean) || process.env.CJ_LOGISTIC_NAME || 'CJPacket Ordinary',
      products: order.items.map((it) => ({ vid: productsById[it.productId].supplierSku, quantity: it.qty })),
    },
  });
  const id = typeof d === 'string' ? d : d?.orderId || d?.id;
  if (!id) throw new Error('CJ did not return an order id');
  return id;
}

/** Pay the supplier order from your CJ wallet balance. */
async function payOrder(supplierOrderId) {
  if (!live()) return true;
  await cj('payBalance', { body: { orderId: supplierOrderId } });
  return true;
}

/** Returns { status: 'processing'|'shipped'|'delivered'|'cancelled', carrier, trackingNumber } */
async function orderStatus(supplierOrder) {
  if (!live()) return mockStatus(supplierOrder);
  const d = await cj('orderDetail', { query: { orderId: supplierOrder.supplierOrderId } });
  const s = String(d?.orderStatus || '').toUpperCase();
  const trackingNumber = d?.trackNumber || d?.trackingNumber || '';
  let status = 'processing';
  if (s.includes('CANCEL')) status = 'cancelled';
  else if (s.includes('DELIVER')) status = 'delivered';
  else if (trackingNumber || s.includes('SHIPPED')) status = 'shipped';
  if (status === 'shipped' && trackingNumber) {
    try {
      const t = await cj('trackInfo', { query: { trackNumber: trackingNumber } });
      const info = Array.isArray(t) ? t[0] : t;
      if (/deliver/i.test(info?.trackingStatus || info?.status || '')) status = 'delivered';
    } catch { /* tracking lookup is best-effort */ }
  }
  return { status, carrier: d?.logisticName || 'CJPacket', trackingNumber };
}

// ---------------- mock supplier (demo mode) ----------------

function mockStatus(so) {
  const age = (Date.now() - new Date(so.placedAt).getTime()) / 1000;
  const ship = Number(process.env.MOCK_SHIP_AFTER_SEC || 120);
  const deliver = Number(process.env.MOCK_DELIVER_AFTER_SEC || 300);
  const trackingNumber = `MOCK${so.supplierOrderId.replace(/\W/g, '').slice(-10)}US`;
  if (age >= deliver) return { status: 'delivered', carrier: 'USPS (mock)', trackingNumber };
  if (age >= ship) return { status: 'shipped', carrier: 'USPS (mock)', trackingNumber };
  return { status: 'processing' };
}

function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
function mockSearch(keyword) {
  const title = keyword.replace(/\b\w/g, (c) => c.toUpperCase());
  const h = hash(keyword.toLowerCase());
  return [{ pid: `mock-${h}`, name: title, image: '', cost: 1.5 + (h % 700) / 100, popularity: 100 + (h % 900), category: '' }];
}
function mockDetails(pid) {
  const h = hash(pid);
  return { vid: `${pid}-v1`, cost: 1.5 + (h % 700) / 100, image: '', shippingCost: 2.5 + (h % 300) / 100, logistic: 'Mock Packet', days: 12 };
}

module.exports = { live, search, details, createOrder, payOrder, orderStatus, ENDPOINTS };
