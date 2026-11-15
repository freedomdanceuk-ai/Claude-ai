# BeautyBridge

A middleman store: find beauty products US shoppers want, sell them at a price
that already includes shipping and import duty, buy them from a China supplier
when an order comes in, and track delivery to the customer.

## Run it

```bash
cd beautybridge
npm install
ADMIN_TOKEN=pick-a-secret npm start
```

- Store: http://localhost:3000
- Admin: http://localhost:3000/admin (log in with your `ADMIN_TOKEN`)

With no keys set it runs in **demo mode**: no real payments are taken and supplier orders are mocked.
See `.env.example` for all settings.

## How an order flows

1. Customer orders. Prices come from the server, and duty and shipping are already included.
2. Customer pays through **Stripe Checkout**: card, Apple Pay, Google Pay, Cash App Pay.
   The Stripe webhook marks the order **paid**.
3. Admin clicks **Send to supplier**. With `CJ_API_KEY` set, this places the order on
   CJdropshipping, shipped straight to the customer. Without the key, you order by hand.
4. Admin enters the tracking number and marks the order **shipped**, later **delivered**.
5. Customer tracks the order at `/#/track` using the order number and email.

## Finding products people want

- **Request a product** page (`/#/request`): shoppers ask for products and upvote each other's requests.
  Admin → Requests ranks them by votes. Source the top ones.
- `demandScore` on each product sets its order in the shop. Set it from TikTok Shop / Amazon
  bestseller research or supplier "trending" lists.
- Admin → Products has a **landed-cost calculator**: enter the supplier cost and shipping
  to get the duty, landed cost, retail price and profit.

## Going live with Stripe

1. Set `STRIPE_SECRET_KEY` and `BASE_URL` (your public https URL).
2. In the Stripe Dashboard, add a webhook to `https://YOUR-DOMAIN/api/stripe/webhook` for
   `checkout.session.completed`, and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Turn on Apple Pay, Google Pay and Cash App Pay under Settings → Payment methods.

## Before you sell for real (US rules)

- **Import duty:** The US ended duty-free "de minimis" entry for Chinese goods in 2025.
  Every parcel owes duty, and tariff rates on Chinese goods change often.
  Get your rate from your carrier or a customs broker and set `DUTY_RATE`.
- **Cosmetics (FDA / MoCRA):** Products applied to the body (serums, masks, lash glue,
  nail gel) must come from an FDA-registered facility, carry a product listing, and have
  English ingredient labelling. Check this with each supplier. Products flagged
  `cosmetic` are marked in the admin panel.
- **Business:** Form an LLC, get an EIN, and add a refund policy, terms and a privacy policy.
  Collect state sales tax where you pass the thresholds (Stripe Tax can do this).
- Order product samples before you list anything.

## Production notes

- Data is stored in `data/db.json`. Move to Postgres before you have real volume.
- Put it behind HTTPS (Render, Railway and Fly.io all work) and set a long `ADMIN_TOKEN`.
- Order confirmation and shipping emails are not built yet. The next step is to add
  Resend or Postmark.
