# Flip Bot

Finds items listed for sale in Zimbabwe, values them, adds a markup, and
writes the resale advert. You work as the broker: advertise first, buy from
the original seller once you have a buyer.

## Run it

```bash
cd flipbot
pip install -r requirements.txt
export ANTHROPIC_API_KEY=your-key     # from console.anthropic.com
python app.py
```

Open http://localhost:5000 on the same computer.

Without the API key the bot still runs, but it only applies a flat markup per
category. It cannot tell whether an item is cheap or overpriced. With the key,
Claude estimates the second-hand market range, sets the resale price, flags
risks, and writes the advert.

## How it works

1. **Find.** Every 30 minutes (and when you press *Scan*) the bot reads the
   new-listings feed on classifieds.co.zw and opens each new advert.
   For Facebook Marketplace, WhatsApp groups and anywhere else, paste the
   listing into *Add a listing*. Those sites do not allow bots to read them.
2. **Assess.** Each listing gets an asking price, market range, resale price,
   markup, profit after your costs, risk flags and questions for the seller.
3. **Decide.** `FLIP` means it clears your minimum profit and markup.
   `SKIP` means it does not. `NEEDS INFO` means the price is missing.
4. **Sell.** Copy the advert, post it, and move the deal through
   New → Advertised → Buyer found → Bought → Sold. Enter what you paid and
   sold for and the dashboard shows your actual profit.

## Settings

Edit `config.py`: minimum profit and markup, your handling cost per
category, how often to scan, and which Claude model to use.

## Rules to trade by

- Confirm with the seller that the item is still available before advertising.
- Never take a buyer's deposit for an item you have not secured.
- Take your own photos when you view the item; do not reuse the seller's.
- The advert only states what the listing states. Check the item before you
  promise condition to a buyer.
- A price far below market is more often a scam or stolen goods than a bargain.

## Host it online (use it from your phone, anywhere)

The repo includes a `Dockerfile` and a `render.yaml` for Render.com.

1. Create an account at render.com and connect your GitHub.
2. New → Blueprint → pick this repository. Render reads `render.yaml`.
3. It asks for two values:
   - `FLIPBOT_PASSWORD`: the password you will type on your phone. Make it long.
   - `ANTHROPIC_API_KEY`: your Claude key.
4. Deploy. Render gives you a link like `https://flipbot-xxxx.onrender.com`.
   Open it on your phone and add it to your home screen.

The blueprint uses a paid plan with a 1 GB disk so your deals are kept between
restarts. The hosted bot refuses to start without a password.
