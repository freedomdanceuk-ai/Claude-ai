"""News feeds the Keeper's desk watches.

Each entry: (source name, RSS/Atom URL). Feeds come and go; if one stops
returning items the desk logs it and carries on. Add or remove freely.
"""

FEEDS = [
    # Zimbabwe: tabloid, courts and general news, where most local bizarre stories surface
    ("H-Metro", "https://www.hmetro.co.zw/feed/"),
    ("The Herald", "https://www.herald.co.zw/feed/"),
    ("NewsDay", "https://www.newsday.co.zw/feed/"),
    ("ZimLive", "https://www.zimlive.com/feed/"),
    ("Nehanda Radio", "https://nehandaradio.com/feed/"),
    ("Chronicle", "https://www.chronicle.co.zw/feed/"),
    # Southern Africa
    ("IOL", "https://www.iol.co.za/cmlink/1.640"),
    ("TimesLIVE", "https://www.timeslive.co.za/rss/"),
    # Global strange news
    ("UPI Odd News", "https://rss.upi.com/news/odd_news.rss"),
    ("Sky News Strange", "https://feeds.skynews.com/feeds/rss/strange.xml"),
    ("r/nottheonion", "https://www.reddit.com/r/nottheonion/top/.rss?t=day"),
    # Mysteries and legends (evergreen 🔴 material)
    ("r/UnresolvedMysteries", "https://www.reddit.com/r/UnresolvedMysteries/top/.rss?t=week"),
    ("r/AfricanFolklore", "https://www.reddit.com/r/africanfolklore/top/.rss?t=month"),
]
