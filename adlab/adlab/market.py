"""Market knowledge: audience segments per business type and channel economics per region.

The cost figures are rough planning estimates (2025-2026 public benchmarks), not quotes.
Always check the live estimate inside each Ads Manager before committing money.
"""

from __future__ import annotations

from dataclasses import dataclass

# ---------------------------------------------------------------------------
# Channels
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Channel:
    key: str
    name: str
    paid: bool
    base_cpm: float  # USD per 1000 impressions in the US (rough benchmark)
    base_ctr: float  # typical click / message-start rate for paid placements
    min_daily: float  # practical minimum daily budget in USD
    best_for: tuple[str, ...]  # goals this channel is strongest at
    formats: tuple[str, ...]  # keys into formats.SPECS
    vertical_first: bool
    ad_tool: str


CHANNELS: dict[str, Channel] = {c.key: c for c in [
    Channel("tiktok", "TikTok", True, 7.0, 0.010, 5.0, ("awareness", "engagement", "messages"),
            ("tiktok",), True, "TikTok Promote (in app) or TikTok Ads Manager (Spark Ads)"),
    Channel("facebook", "Facebook", True, 9.0, 0.012, 3.0, ("messages", "sales", "traffic", "awareness"),
            ("facebook_feed", "facebook_story"), False, "Meta Ads Manager - Click-to-WhatsApp/Messenger"),
    Channel("instagram", "Instagram", True, 9.5, 0.010, 3.0, ("engagement", "sales", "awareness", "messages"),
            ("instagram_reel", "instagram_feed", "instagram_story"), True, "Meta Ads Manager (same campaign as Facebook)"),
    Channel("whatsapp", "WhatsApp Status & Channels", False, 0.0, 0.0, 0.0, ("messages", "sales"),
            ("whatsapp_status",), True, "Post free to Status/Channel; paid reach comes via Click-to-WhatsApp on Meta"),
    Channel("youtube", "YouTube Shorts / In-stream", True, 8.0, 0.006, 5.0, ("awareness", "traffic"),
            ("youtube_short", "youtube"), True, "Google Ads - Video campaign"),
    Channel("x", "X (Twitter)", True, 5.0, 0.008, 5.0, ("awareness", "traffic"),
            ("x_post",), False, "X Ads"),
    Channel("linkedin", "LinkedIn", True, 30.0, 0.006, 10.0, ("traffic", "sales"),
            ("linkedin",), False, "LinkedIn Campaign Manager"),
    Channel("pinterest", "Pinterest", True, 6.0, 0.007, 5.0, ("traffic", "sales"),
            ("pinterest",), True, "Pinterest Ads"),
    Channel("snapchat", "Snapchat", True, 5.0, 0.006, 5.0, ("awareness", "engagement"),
            ("snapchat",), True, "Snapchat Ads Manager"),
]}

# ---------------------------------------------------------------------------
# Regions: how expensive ads are and how popular each channel is (0-1)
# ---------------------------------------------------------------------------

REGIONS: dict[str, dict] = {
    "zimbabwe": {
        "name": "Zimbabwe", "cpm_mult": 0.12, "currency_note": "USD, EcoCash, InnBucks",
        "reach": {"facebook": 1.0, "whatsapp": 1.0, "tiktok": 0.85, "instagram": 0.45, "youtube": 0.5,
                  "x": 0.35, "linkedin": 0.25, "pinterest": 0.05, "snapchat": 0.1},
        "peak_times": "12:00-14:00 and 19:00-22:00 CAT; Sunday afternoon is strong",
        "notes": "Data costs are high: keep videos short and light. Trust and payment plans (lay-by) win sales.",
    },
    "south_africa": {
        "name": "South Africa", "cpm_mult": 0.30, "currency_note": "ZAR",
        "reach": {"facebook": 0.9, "whatsapp": 1.0, "tiktok": 0.85, "instagram": 0.7, "youtube": 0.75,
                  "x": 0.5, "linkedin": 0.45, "pinterest": 0.2, "snapchat": 0.2},
        "peak_times": "12:00-13:30 and 18:30-21:30 SAST; month-end payday weeks convert best",
        "notes": "Payday (25th-1st) drives purchases. Load-shedding hours change when people scroll.",
    },
    "nigeria": {
        "name": "Nigeria", "cpm_mult": 0.12, "currency_note": "NGN",
        "reach": {"facebook": 0.85, "whatsapp": 1.0, "tiktok": 0.8, "instagram": 0.8, "youtube": 0.6,
                  "x": 0.6, "linkedin": 0.3, "pinterest": 0.05, "snapchat": 0.25},
        "peak_times": "12:00-14:00 and 19:00-23:00 WAT",
        "notes": "Instagram is a major shopping channel; show prices in NGN and offer pay-on-delivery in Lagos/Abuja.",
    },
    "kenya": {
        "name": "Kenya", "cpm_mult": 0.14, "currency_note": "KES, M-Pesa",
        "reach": {"facebook": 0.9, "whatsapp": 1.0, "tiktok": 0.85, "instagram": 0.6, "youtube": 0.65,
                  "x": 0.45, "linkedin": 0.3, "pinterest": 0.05, "snapchat": 0.15},
        "peak_times": "12:30-14:00 and 19:00-22:00 EAT",
        "notes": "Put the M-Pesa till/paybill number in the ad.",
    },
    "uk": {
        "name": "United Kingdom", "cpm_mult": 0.80, "currency_note": "GBP",
        "reach": {"facebook": 0.75, "whatsapp": 0.8, "tiktok": 0.85, "instagram": 0.85, "youtube": 0.85,
                  "x": 0.5, "linkedin": 0.6, "pinterest": 0.45, "snapchat": 0.5},
        "peak_times": "07:30-09:00, 12:00-13:00 and 19:00-22:00 GMT/BST",
        "notes": "",
    },
    "usa": {
        "name": "United States", "cpm_mult": 1.0, "currency_note": "USD",
        "reach": {"facebook": 0.75, "whatsapp": 0.3, "tiktok": 0.85, "instagram": 0.85, "youtube": 0.9,
                  "x": 0.5, "linkedin": 0.6, "pinterest": 0.6, "snapchat": 0.55},
        "peak_times": "11:00-13:00 and 19:00-22:00 local time",
        "notes": "",
    },
    "diaspora": {
        "name": "Diaspora (UK, SA, USA, Australia, Botswana)", "cpm_mult": 0.65,
        "currency_note": "Show the home-country price in USD plus 'pay from abroad'",
        "reach": {"facebook": 1.0, "whatsapp": 1.0, "tiktok": 0.8, "instagram": 0.6, "youtube": 0.6,
                  "x": 0.3, "linkedin": 0.3, "pinterest": 0.1, "snapchat": 0.1},
        "peak_times": "Evenings in the target country; Sunday is family/WhatsApp time",
        "notes": "Diaspora buyers pay for family back home. Show delivery photos and accept card / bank transfer.",
    },
    "global": {
        "name": "Global / other", "cpm_mult": 0.6, "currency_note": "USD",
        "reach": {"facebook": 0.85, "whatsapp": 0.8, "tiktok": 0.85, "instagram": 0.8, "youtube": 0.85,
                  "x": 0.5, "linkedin": 0.5, "pinterest": 0.35, "snapchat": 0.35},
        "peak_times": "12:00-14:00 and 19:00-22:00 local time",
        "notes": "",
    },
}

# ---------------------------------------------------------------------------
# Business categories
# ---------------------------------------------------------------------------

CATEGORIES: dict[str, dict] = {
    "furniture": {
        "name": "Furniture & home decor",
        "keywords": ["sofa", "couch", "lounge", "bed", "furniture", "dining", "wardrobe", "kitchen", "decor", "chair"],
        "purchase_cycle": "considered",
        "channel_fit": {"facebook": 1.0, "tiktok": 0.9, "whatsapp": 1.0, "instagram": 0.8, "pinterest": 0.7,
                        "youtube": 0.5, "x": 0.2, "linkedin": 0.15, "snapchat": 0.2},
        "segments": [
            ("Young couples setting up a first home", "24-34", "mixed, women lead the decision",
             ["home decor", "weddings", "new home", "interior design"],
             "Biggest volume. Want style, payment plans and delivery."),
            ("Established families upgrading", "35-55", "mixed",
             ["family", "home improvement", "real estate"],
             "Higher order value: full lounge/bedroom suites, care about durability."),
            ("Diaspora buying for family back home", "28-55", "mixed",
             ["expat communities", "remittances", "home country news"],
             "Pay from abroad and want proof of delivery. High trust bar, high spend."),
            ("Landlords, Airbnb hosts and small offices", "30-60", "mixed",
             ["real estate investing", "Airbnb", "small business"],
             "Bulk orders and repeat purchases."),
        ],
        "hooks": ["Delivery reveal: truck to living room", "Before/after room makeover",
                  "'Guess the price' then reveal", "What's inside: frame, foam, springs",
                  "Customer testimonial in a real home"],
    },
    "fashion": {
        "name": "Fashion, clothing & accessories",
        "keywords": ["dress", "shoes", "fashion", "outfit", "clothing", "wear", "bag", "jewellery", "jewelry", "wig", "hair"],
        "purchase_cycle": "impulse",
        "channel_fit": {"instagram": 1.0, "tiktok": 1.0, "facebook": 0.7, "whatsapp": 0.8, "pinterest": 0.7,
                        "snapchat": 0.6, "youtube": 0.4, "x": 0.3, "linkedin": 0.05},
        "segments": [
            ("Trend-led young women", "18-30", "female", ["fashion", "beauty", "celebrities", "online shopping"],
             "Respond to try-ons, outfit transitions and drops."),
            ("Young men into streetwear", "18-30", "male", ["sneakers", "hip hop", "football"],
             "Respond to fit checks and limited stock."),
            ("Working professionals", "28-45", "mixed", ["business", "careers", "luxury"],
             "Value quality and occasion wear."),
        ],
        "hooks": ["Outfit transition on the beat", "'3 ways to wear this'", "Try-on haul", "Limited stock countdown"],
    },
    "food": {
        "name": "Food, restaurant & catering",
        "keywords": ["food", "restaurant", "cake", "pizza", "chicken", "catering", "bakery", "menu", "meal", "drink"],
        "purchase_cycle": "impulse",
        "channel_fit": {"tiktok": 1.0, "instagram": 0.9, "facebook": 0.9, "whatsapp": 0.9, "youtube": 0.4,
                        "snapchat": 0.5, "pinterest": 0.3, "x": 0.3, "linkedin": 0.05},
        "segments": [
            ("Students and young workers nearby", "18-30", "mixed", ["food", "music", "nightlife"],
             "Price- and deal-sensitive, decide fast."),
            ("Families ordering for weekends/events", "28-50", "mixed", ["family", "parenting", "events"],
             "Order bigger; respond to combos and catering."),
            ("Office lunch buyers", "24-45", "mixed", ["business", "office"], "Want speed and delivery."),
        ],
        "hooks": ["Close-up sizzle/cheese pull in first second", "Price + portion reveal", "Behind the kitchen", "Customer first bite"],
    },
    "beauty": {
        "name": "Beauty, salon & cosmetics",
        "keywords": ["salon", "makeup", "nails", "skin", "beauty", "lashes", "spa", "barber", "cosmetics"],
        "purchase_cycle": "repeat",
        "channel_fit": {"instagram": 1.0, "tiktok": 1.0, "facebook": 0.8, "whatsapp": 0.9, "youtube": 0.5,
                        "pinterest": 0.5, "snapchat": 0.5, "x": 0.2, "linkedin": 0.05},
        "segments": [
            ("Young women 18-34", "18-34", "female", ["beauty", "makeup", "fashion"],
             "Driven by transformations and creators."),
            ("Professional women 30-50", "30-50", "female", ["wellness", "spa", "luxury"],
             "Value results, booking convenience."),
            ("Grooming-focused men", "18-40", "male", ["grooming", "fitness"], "Barber cuts, beard care."),
        ],
        "hooks": ["Before/after transformation", "Satisfying process close-up", "Price list reveal", "Client reaction"],
    },
    "real_estate": {
        "name": "Real estate & property",
        "keywords": ["house", "stand", "property", "rent", "land", "apartment", "estate", "realtor"],
        "purchase_cycle": "considered",
        "channel_fit": {"facebook": 1.0, "whatsapp": 1.0, "youtube": 0.8, "instagram": 0.7, "tiktok": 0.7,
                        "linkedin": 0.5, "x": 0.3, "pinterest": 0.2, "snapchat": 0.05},
        "segments": [
            ("First-time buyers", "27-40", "mixed", ["real estate", "mortgage", "personal finance"], "Need payment plans."),
            ("Diaspora investors", "30-60", "mixed", ["investing", "expat communities"], "Want title deeds and proof."),
            ("Investors and landlords", "35-65", "mixed", ["investing", "business"], "Care about yield and location."),
        ],
        "hooks": ["Walkthrough tour in 20 seconds", "'What $X buys you in <area>'", "Drone reveal", "Title deeds and payment plan"],
    },
    "auto": {
        "name": "Vehicles, parts & services",
        "keywords": ["car", "vehicle", "tyre", "tire", "parts", "garage", "mechanic", "auto"],
        "purchase_cycle": "considered",
        "channel_fit": {"facebook": 1.0, "tiktok": 0.8, "youtube": 0.8, "whatsapp": 0.9, "instagram": 0.6,
                        "x": 0.3, "linkedin": 0.2, "pinterest": 0.1, "snapchat": 0.2},
        "segments": [
            ("Men 25-50 car owners", "25-50", "male-leaning", ["cars", "motorsport", "technology"], "Want price and condition."),
            ("Families needing reliable transport", "28-50", "mixed", ["family"], "Value financing and trust."),
        ],
        "hooks": ["Walk-around with price on screen", "Engine start sound", "Before/after detailing"],
    },
    "electronics": {
        "name": "Phones, electronics & tech",
        "keywords": ["phone", "laptop", "iphone", "samsung", "tv", "solar", "inverter", "electronics", "gadget"],
        "purchase_cycle": "considered",
        "channel_fit": {"facebook": 0.9, "tiktok": 0.9, "youtube": 0.8, "whatsapp": 0.9, "instagram": 0.7,
                        "x": 0.5, "linkedin": 0.3, "pinterest": 0.2, "snapchat": 0.3},
        "segments": [
            ("Young tech buyers", "18-34", "male-leaning", ["technology", "gaming", "mobile phones"], "Compare specs and prices."),
            ("Homeowners needing solar/backup", "30-60", "mixed", ["home improvement", "energy"], "Pain-driven: outages."),
            ("Small businesses", "25-55", "mixed", ["small business"], "Bulk, warranty, invoices."),
        ],
        "hooks": ["Unboxing with price", "Problem/solution (power cut → lights stay on)", "Spec comparison"],
    },
    "services": {
        "name": "Professional & local services",
        "keywords": ["service", "cleaning", "repair", "training", "consult", "school", "tutor", "photography", "event"],
        "purchase_cycle": "considered",
        "channel_fit": {"facebook": 1.0, "whatsapp": 1.0, "linkedin": 0.6, "tiktok": 0.7, "instagram": 0.7,
                        "youtube": 0.5, "x": 0.3, "pinterest": 0.1, "snapchat": 0.1},
        "segments": [
            ("Local households", "25-55", "mixed", ["home", "family"], "Want reliability and fair price."),
            ("Small and medium businesses", "25-55", "mixed", ["small business", "entrepreneurship"], "Want proof of results."),
        ],
        "hooks": ["Before/after result", "Day-in-the-life of the team", "Client testimonial", "FAQ answered in 15 s"],
    },
    "general": {
        "name": "General retail",
        "keywords": [],
        "purchase_cycle": "impulse",
        "channel_fit": {"facebook": 0.9, "tiktok": 0.9, "instagram": 0.8, "whatsapp": 0.9, "youtube": 0.5,
                        "x": 0.3, "linkedin": 0.2, "pinterest": 0.3, "snapchat": 0.3},
        "segments": [
            ("Value shoppers", "22-45", "mixed", ["online shopping", "deals"], "Respond to price and offers."),
            ("Gift buyers", "25-50", "mixed", ["gifts", "holidays"], "Respond to seasonal hooks."),
        ],
        "hooks": ["Product in use in first second", "Price reveal", "Customer reaction", "Limited offer"],
    },
}

GOALS = {
    "messages": "WhatsApp / inbox messages (leads)",
    "sales": "Website or catalogue sales",
    "awareness": "Brand awareness & reach",
    "engagement": "Views, likes, shares & followers",
    "traffic": "Website / link clicks",
}


def detect_category(text: str) -> str:
    text = (text or "").lower()
    best, hits = "general", 0
    for key, cat in CATEGORIES.items():
        n = sum(1 for kw in cat["keywords"] if kw in text)
        if n > hits:
            best, hits = key, n
    return best


def audience_report(category: str, regions: list[str]) -> dict:
    cat = CATEGORIES.get(category, CATEGORIES["general"])
    region_objs = [REGIONS[r] for r in regions if r in REGIONS] or [REGIONS["global"]]
    segments = [
        {"name": n, "age": age, "gender": g, "interests": ints, "why": why}
        for n, age, g, ints, why in cat["segments"]
    ]
    # Diaspora segment is only relevant if they target diaspora
    if "diaspora" not in regions:
        segments = [s for s in segments if "diaspora" not in s["name"].lower()] or segments
    return {
        "category": category,
        "category_name": cat["name"],
        "purchase_cycle": cat["purchase_cycle"],
        "segments": segments,
        "hooks": cat["hooks"],
        "regions": [
            {"name": r["name"], "peak_times": r["peak_times"], "notes": r["notes"], "currency": r["currency_note"]}
            for r in region_objs
        ],
    }
