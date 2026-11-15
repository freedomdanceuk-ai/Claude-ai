"""Where listings come from.

1. The classifieds.co.zw RSS feed (the site allows automated readers on it).
2. Listings you paste in yourself from anywhere: Facebook Marketplace,
   WhatsApp groups, newspapers. Those places do not allow bots to read them,
   so the bot does not try.
"""
import json
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from html import unescape

import config


def _fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def read_rss(feed_url):
    """Return [{'title', 'url'}] for the newest listings in a feed."""
    root = ET.fromstring(_fetch(feed_url))
    items = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if title and link:
            items.append({"title": title, "url": link})
    return items


def fetch_listing(url):
    """Read a listing page. Returns {'text', 'price'}; both empty if the page
    cannot be read (for example the site shows a browser check). We do not
    try to get around such checks: you add the details on the dashboard.
    """
    empty = {"text": "", "price": None}
    try:
        html = _fetch(url)
    except (urllib.error.URLError, TimeoutError):
        return empty
    if "Just a moment" in html[:2000]:
        return empty

    lines, price = [], None
    for block in re.findall(r'<script type="application/ld\+json">([\s\S]*?)</script>', html):
        try:
            data = json.loads(block)
        except ValueError:
            continue
        for node in data.get("@graph", [data]) if isinstance(data, dict) else []:
            if node.get("@type") == "BreadcrumbList":
                crumbs = [i.get("name", "") for i in node.get("itemListElement", [])][:-1]
                lines.append("Category: " + " > ".join(crumbs))
            elif node.get("@type") == "Product":
                offer = node.get("offers") or {}
                if offer.get("priceCurrency") == "USD" and offer.get("price"):
                    price = float(offer["price"])
                    lines.append(f"Price: USD {price:g}")

    body = re.sub(r"<(script|style)[\s\S]*?</\1>", " ", html)
    body = re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", body))).strip()
    # Keep the seller's own description, drop menus and "similar adverts".
    m = re.search(r"Share via email(.*?)(?:On Offer or Wanted|Similar adverts|More ads from this seller|Contact Seller)", body)
    desc = (m.group(1) if m else body).strip()[:3000]
    if "More ads from this seller" in body:
        lines.append("Seller type: has several adverts (likely a dealer or shop)")
    lines.append("Description: " + desc)
    return {"text": "\n".join(lines), "price": price}


def scan(con):
    """Pull every feed, store listings we have not seen. Returns new ids."""
    import db
    new_ids = []
    for feed in config.RSS_FEEDS:
        for item in read_rss(feed):
            if db.has_url(con, item["url"]):
                continue
            time.sleep(1)  # be gentle on the site
            page = fetch_listing(item["url"])
            lid = db.add_listing(con, "classifieds.co.zw", item["title"], url=item["url"],
                                 raw_text=page["text"], ask_price=page["price"])
            if lid:
                new_ids.append(lid)
    return new_ids
