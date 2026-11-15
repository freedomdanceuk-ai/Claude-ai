// Transactional email via Resend (https://resend.com). Without RESEND_API_KEY
// emails are written to the console and data/outbox.log so you can see them.
const fs = require('fs');
const path = require('path');

const STORE = 'BeautyBridge';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${Number(n).toFixed(2)}`;
const base = () => process.env.BASE_URL || 'http://localhost:3000';
const trackLink = (o) => `${base()}/#/order/${o.id}?email=${encodeURIComponent(o.customer.email)}`;

function layout(title, inner) {
  return `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;color:#241f21">
    <h2 style="color:#b4436c;margin-bottom:4px">${STORE}</h2><h3>${esc(title)}</h3>${inner}
    <p style="color:#75696d;font-size:13px;margin-top:24px">Questions? Just reply to this email.</p></div>`;
}
const items = (o) =>
  `<table style="width:100%;border-collapse:collapse">${o.items
    .map((i) => `<tr><td style="padding:4px 0">${esc(i.name)} × ${i.qty}</td><td style="text-align:right">${money(i.price * i.qty)}</td></tr>`)
    .join('')}<tr><td style="padding-top:8px"><b>Total</b></td><td style="text-align:right"><b>${money(o.total)}</b></td></tr></table>`;
const button = (href, label) =>
  `<p><a href="${esc(href)}" style="background:#b4436c;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${esc(label)}</a></p>`;

const templates = {
  confirmed: (o) => ({
    subject: `Order ${o.id} confirmed`,
    html: layout('Thanks for your order! 🎉', `<p>Hi ${esc(o.customer.name)}, we've received your payment and are preparing your order.
      It usually arrives in 7–15 business days. We'll email you a tracking number as soon as it ships.</p>${items(o)}${button(trackLink(o), 'View order')}`),
  }),
  shipped: (o) => ({
    subject: `Your order ${o.id} has shipped 📦`,
    html: layout('Your order is on its way', `<p>Tracking number: <b>${esc(o.tracking.number)}</b> (${esc(o.tracking.carrier)})</p>
      ${button(`https://t.17track.net/en#nums=${encodeURIComponent(o.tracking.number)}`, 'Track package')}
      <p>Tracking can take 2–3 days to show updates while the parcel leaves the warehouse.</p>`),
  }),
  delivered: (o) => ({
    subject: `Delivered: order ${o.id}`,
    html: layout('Your order was delivered 💕', `<p>We hope you love it! If anything is wrong, reply within 30 days and we'll make it right.</p>`),
  }),
  refunded: (o) => ({
    subject: `Refund for order ${o.id}`,
    html: layout('We refunded your order', `<p>Sorry, we couldn't fulfil your order${o.refundReason ? ` (${esc(o.refundReason)})` : ''}.
      We've refunded ${money(o.total)} to your original payment method. It usually shows within 3–5 business days.</p>`),
  }),
  requestListed: (r, p) => ({
    subject: `It's here: ${r.product}`,
    html: layout('The product you asked for is now in stock', `<p>You asked for <b>${esc(r.product)}</b>. We found it:
      <b>${esc(p.name)}</b> for ${money(p.price)}.</p>${button(`${base()}/#/p/${p.id}`, 'Shop now')}`),
  }),
  adminAlert: (title, text) => ({
    subject: `[${STORE} admin] ${title}`,
    html: layout(title, `<p>${esc(text)}</p>${button(`${base()}/admin`, 'Open admin')}`),
  }),
};

async function send(to, { subject, html }) {
  if (!to) return;
  if (!process.env.RESEND_API_KEY) {
    const line = `[${new Date().toISOString()}] EMAIL to=${to} subject="${subject}"`;
    console.log(line);
    try {
      const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
      fs.appendFileSync(path.join(dir, 'outbox.log'), line + '\n');
    } catch {}
    return;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || `${STORE} <onboarding@resend.dev>`, to, subject, html,
        reply_to: process.env.SUPPORT_EMAIL || undefined }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.error('Email failed:', res.status, await res.text());
  } catch (e) {
    console.error('Email failed:', e.message); // never break order processing over an email
  }
}

const toCustomer = (o, kind) => send(o.customer.email, templates[kind](o));
const toAdmin = (title, text) => send(process.env.ADMIN_EMAIL, templates.adminAlert(title, text));
const requestListed = (r, p) => send(r.email, templates.requestListed(r, p));

module.exports = { toCustomer, toAdmin, requestListed };
