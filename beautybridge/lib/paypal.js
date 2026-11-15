// PayPal Checkout (Orders v2). The PayPal JS SDK buttons on the checkout page
// offer PayPal, Venmo (US), Pay Later and debit/credit cards automatically.
// Without PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET the app runs in DEMO mode.

const BASE = () =>
  process.env.PAYPAL_API_BASE || // for testing only
  (process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

const enabled = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
let tokenCache = null;

async function token() {
  if (tokenCache && tokenCache.expires > Date.now()) return tokenCache.token;
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${BASE()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error_description || 'PayPal auth failed');
  tokenCache = { token: body.access_token, expires: Date.now() + (body.expires_in - 60) * 1000 };
  return tokenCache.token;
}

async function call(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.details?.[0]?.description || data.message || res.statusText;
    const err = new Error(`PayPal: ${detail}`);
    err.issue = data.details?.[0]?.issue;
    throw err;
  }
  return data;
}

const amt = (n) => Number(n).toFixed(2);

async function createOrder(order) {
  const c = order.customer;
  return call(
    'POST',
    '/v2/checkout/orders',
    {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: order.id,
          custom_id: order.id,
          invoice_id: order.id,
          description: 'BeautyBridge order',
          amount: {
            currency_code: 'USD',
            value: amt(order.total),
            breakdown: {
              item_total: { currency_code: 'USD', value: amt(order.subtotal) },
              shipping: { currency_code: 'USD', value: amt(order.shippingFee) },
            },
          },
          items: order.items.map((it) => ({
            name: it.name.slice(0, 127),
            quantity: String(it.qty),
            unit_amount: { currency_code: 'USD', value: amt(it.price) },
            category: 'PHYSICAL_GOODS',
          })),
          shipping: {
            name: { full_name: c.name },
            address: {
              address_line_1: c.address1,
              address_line_2: c.address2 || undefined,
              admin_area_2: c.city,
              admin_area_1: c.state,
              postal_code: c.zip,
              country_code: 'US',
            },
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'BeautyBridge',
            shipping_preference: 'SET_PROVIDED_ADDRESS',
            user_action: 'PAY_NOW',
          },
        },
      },
    },
    { 'PayPal-Request-Id': `create-${order.id}` }
  );
}

// Capture after the buyer approves. Returns { captureId, amount, status }.
async function captureOrder(paypalOrderId, ourOrderId) {
  let data;
  try {
    data = await call('POST', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {}, {
      'PayPal-Request-Id': `capture-${ourOrderId}`,
    });
  } catch (e) {
    if (e.issue !== 'ORDER_ALREADY_CAPTURED') throw e;
    data = await call('GET', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`);
  }
  const cap = data.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    status: cap?.status,
    captureId: cap?.id,
    amount: Number(cap?.amount?.value),
    currency: cap?.amount?.currency_code,
    customId: data.purchase_units?.[0]?.custom_id || cap?.custom_id,
  };
}

async function refundCapture(captureId, orderId, note) {
  return call(
    'POST',
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    { note_to_payer: note?.slice(0, 255) },
    { 'PayPal-Request-Id': `refund-${orderId}` }
  );
}

// Ask PayPal to confirm a webhook really came from PayPal.
async function verifyWebhook(headers, event) {
  if (!process.env.PAYPAL_WEBHOOK_ID) return false;
  const data = await call('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: process.env.PAYPAL_WEBHOOK_ID,
    webhook_event: event,
  });
  return data.verification_status === 'SUCCESS';
}

module.exports = { enabled, createOrder, captureOrder, refundCapture, verifyWebhook };
