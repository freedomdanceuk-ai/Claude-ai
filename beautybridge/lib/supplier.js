// Supplier adapter: places the order with your China supplier.
// Implemented for CJdropshipping's API (https://developers.cjdropshipping.com).
// Without CJ_API_KEY it runs in MOCK mode so you can test the whole flow;
// in mock mode you place the order by hand and paste the supplier order ID.
//
// Check field names against CJ's current docs before going live — their API
// versions change.

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';
let tokenCache = null;

const enabled = () => Boolean(process.env.CJ_API_KEY);

async function cjToken() {
  if (tokenCache && tokenCache.expires > Date.now()) return tokenCache.token;
  const res = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: process.env.CJ_API_KEY }),
  });
  const body = await res.json();
  if (!body.result) throw new Error(body.message || 'CJ auth failed');
  tokenCache = { token: body.data.accessToken, expires: Date.now() + 12 * 3600 * 1000 };
  return tokenCache.token;
}

async function placeOrder(order, productsById) {
  const missing = order.items.filter((it) => !productsById[it.productId]?.supplierSku);
  if (!enabled() || missing.length) {
    return {
      mode: 'mock',
      supplierOrderId: `MOCK-${order.id}`,
      note: !enabled()
        ? 'Mock mode: no CJ_API_KEY set. Place this order with the supplier manually.'
        : `Missing supplier SKU for: ${missing.map((m) => m.name).join(', ')}`,
    };
  }
  const a = order.customer;
  const payload = {
    orderNumber: order.id,
    shippingCountryCode: 'US',
    shippingCountry: 'United States',
    shippingProvince: a.state,
    shippingCity: a.city,
    shippingZip: a.zip,
    shippingAddress: [a.address1, a.address2].filter(Boolean).join(', '),
    shippingCustomerName: a.name,
    shippingPhone: a.phone || '',
    email: a.email,
    logisticName: process.env.CJ_LOGISTIC_NAME || 'CJPacket Ordinary',
    fromCountryCode: 'CN',
    products: order.items.map((it) => ({ vid: productsById[it.productId].supplierSku, quantity: it.qty })),
  };
  const res = await fetch(`${CJ_BASE}/shopping/order/createOrderV2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CJ-Access-Token': await cjToken() },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!body.result) throw new Error(body.message || 'CJ order failed');
  return { mode: 'cj', supplierOrderId: body.data?.orderId || body.data };
}

module.exports = { enabled, placeOrder };
