// Stripe Checkout (cards, Apple Pay, Google Pay, Cash App Pay, Link — enable the
// methods you want in the Stripe Dashboard; Checkout shows them automatically).
// Without STRIPE_SECRET_KEY the app runs in DEMO mode: no real money moves.
const crypto = require('crypto');

const enabled = () => Boolean(process.env.STRIPE_SECRET_KEY);

// Stripe's API takes form-encoded nested params: a[b][0][c]=x
function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') encode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

async function createCheckoutSession(order, baseUrl) {
  const params = {
    mode: 'payment',
    customer_email: order.customer.email,
    client_reference_id: order.id,
    metadata: { orderId: order.id },
    success_url: `${baseUrl}/#/order/${order.id}?email=${encodeURIComponent(order.customer.email)}`,
    cancel_url: `${baseUrl}/#/cart`,
    line_items: order.items.map((it) => ({
      quantity: it.qty,
      price_data: {
        currency: 'usd',
        unit_amount: Math.round(it.price * 100),
        product_data: { name: it.name },
      },
    })),
  };
  if (order.shippingFee > 0) {
    params.line_items.push({
      quantity: 1,
      price_data: { currency: 'usd', unit_amount: Math.round(order.shippingFee * 100), product_data: { name: 'Shipping' } },
    });
  }
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: encode(params),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || 'Stripe error');
  return { id: body.id, url: body.url };
}

// Verify the Stripe-Signature header (v1 scheme) without the SDK.
function verifyWebhook(rawBody, header, secret, toleranceSec = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=')).filter((p) => p.length === 2)
  );
  const t = Number(parts.t);
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some(
    (s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))
  );
}

module.exports = { enabled, createCheckoutSession, verifyWebhook };
