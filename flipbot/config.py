"""Settings for the flip bot. Edit the numbers here to match how you trade."""
import os

# Claude model used to value items and write adverts.
MODEL = os.environ.get("FLIPBOT_MODEL", "claude-opus-5-5")

DB_PATH = os.environ.get("FLIPBOT_DB", os.path.join(os.path.dirname(__file__), "flipbot.db"))

# Public feed of new listings. The site's robots.txt explicitly allows it.
RSS_FEEDS = ["https://www.classifieds.co.zw/rss-listings"]
# The feed only shows the newest few adverts, so the bot re-checks it on a timer.
SCAN_EVERY_MINUTES = 30
USER_AGENT = "FlipBot/0.1 (personal deal finder)"

# Only show a deal as "FLIP" when it clears both of these.
MIN_PROFIT_USD = 20
MIN_MARKUP_PCT = 15

# Your own costs per flip (transport, airtime, fuel). Taken off the profit.
HANDLING_COST_USD = {
    "furniture": 15,
    "electronics": 3,
    "vehicles": 50,
    "other": 5,
}

# Used only when no Claude API key is set: a flat markup per category.
FALLBACK_MARKUP_PCT = {
    "furniture": 30,
    "electronics": 20,
    "vehicles": 8,
    "other": 25,
}
