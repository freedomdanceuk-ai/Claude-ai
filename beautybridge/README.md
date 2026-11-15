# BeautyBridge

An automated middleman store. It finds beauty products US shoppers want, sells them
at a price that already covers shipping and import duty, takes payment with PayPal,
orders from the China supplier (CJdropshipping), and emails tracking and delivery
updates to the customer, all without anyone touching it.

## Run it

```bash
cd beautybridge
npm install
cp .env.example .env     # fill in your keys (or leave blank for demo mode)
ADMIN_TOKEN=pick-a-secret npm start
```

- Store: http://localhost:3000
- Admin: http://localhost:3000/admin

With no keys it runs fully in **demo mode**. Payment is simulated, a mock supplier
"ships" the order after 2 minutes and "delivers" it after 5, and emails go to
`data/outbox.log`. You can watch the whole automatic flow without spending money.

## What happens automatically

| When | What the app does |
|---|---|
| Customer pays (PayPal, Venmo, Pay Later or card) | Captures payment, emails a confirmation, orders the product from CJ to ship to the customer, and pays CJ from your CJ wallet |
| Supplier order fails | Retries 5 times over about 4 hours, then refunds the customer through PayPal and emails both of you |
| Supplier ships | Saves the tracking number and emails the customer a tracking link |
| Package delivered | Marks the order delivered and emails the customer |
| Supplier cancels | Refunds the customer automatically |
| Every day | Finds popular beauty products on CJ, works out duty + shipping + margin, lists the profitable ones, updates costs and hides sold-out items |
| Every hour | Customer requests with 3+ votes are found on CJ, listed, and the requester is emailed |

The **Automation** tab in the admin panel shows every job, its last result, and a "Run now" button.

### What still needs you (on purpose)

- **Cosmetics review.** Anything applied to skin, hair or nails (serums, masks, lash glue, gel polish)
  is a cosmetic under US law. The FDA requires the maker to have a registered facility, a product
  listing and English ingredient labels. These products wait in Admin → Products until you click
  **Approve**. Tools and accessories (gua sha, brushes, clips) go live with no review.
  You can set `REVIEW_COSMETICS=false` to skip this, but selling a non-compliant cosmetic is
  your legal risk.
- **Blocked products.** The app never lists skin whitening/bleaching products, teeth whitening,
  growth serums, needles, LED masks or anything with medical claims. These are regulated as drugs
  or devices in the US.
- **Top up your CJ wallet.** Supplier orders are paid from that balance. If it runs dry,
  orders fail, and after retries the customer is refunded.

## Setup for real money

1. **PayPal Business account.** At developer.paypal.com create an app, then set `PAYPAL_CLIENT_ID`
   and `PAYPAL_CLIENT_SECRET`. Test with `PAYPAL_ENV=sandbox` first, then switch to `live`.
2. **PayPal webhook.** Add `https://YOUR-DOMAIN/api/paypal/webhook` with the events
   `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED` and `PAYMENT.CAPTURE.REVERSED`.
   Put its ID in `PAYPAL_WEBHOOK_ID`. This catches payments even if a buyer closes the tab.
3. **CJdropshipping.** Create an account, generate an API key, set `CJ_API_KEY`, and add funds to the wallet.
   ⚠️ The CJ endpoint paths are listed in one place, `ENDPOINTS` in `lib/supplier.js`.
   Check them against CJ's current API docs before going live.
4. **Email.** Create a Resend account, verify your domain, then set `RESEND_API_KEY` and `EMAIL_FROM`.
5. **Hosting.** See "Deploy to Render" below.

## Deploy to Render

The repo has a `render.yaml` blueprint at the root.

1. Sign up at render.com with your GitHub account, and give Render access to this repository.
2. Click **New → Blueprint**, pick this repository, and click **Apply**.
3. Render asks for the secret values. Leave any you don't have yet blank: the app runs in
   demo mode until they're filled in. Set `BASE_URL` to the address Render gives you
   (e.g. `https://beautybridge.onrender.com`) after the first deploy, then redeploy.
4. Find your admin password: Dashboard → beautybridge → Environment → `ADMIN_TOKEN`.

It uses the **Starter** plan (about $7/month plus $0.25/month for the 1 GB disk). The free plan
is not suitable: it sleeps when idle, which stops the automation, and it has no disk, so orders would be lost.

For other hosts (Railway, Fly.io, a VPS), use the `Dockerfile` and mount a persistent volume at `/var/data`.

## Before you sell (US rules)

- **Import duty.** The US ended duty-free entry for Chinese parcels in 2025, so every parcel owes duty.
  Tariff rates on Chinese goods change often. Get yours from a customs broker and set `DUTY_RATE`.
- **Business.** Form an LLC, get an EIN, publish refund, terms and privacy pages, and collect
  sales tax in states where you pass the thresholds.
- Order samples of the auto-listed products before advertising them.

## Project layout

```
server.js            web server + API
lib/automation.js    background jobs (fulfil, tracking, discover, requests)
lib/paypal.js        PayPal Orders v2: create, capture, refund, webhook verification
lib/supplier.js      CJdropshipping API + mock supplier
lib/email.js         customer + admin emails (Resend)
lib/pricing.js       landed-cost pricing (duty + shipping + fees + margin)
public/              storefront + admin dashboard
```

Data is stored in `data/db.json`. Move to Postgres once you have steady order volume.
