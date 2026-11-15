import json
import sqlite3
from datetime import datetime, timezone

import config

STATUSES = ["new", "advertised", "buyer_found", "bought", "sold", "skipped"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    url TEXT UNIQUE,
    title TEXT NOT NULL,
    raw_text TEXT DEFAULT '',
    ask_price REAL,
    location TEXT DEFAULT '',
    category TEXT DEFAULT 'other',
    verdict TEXT DEFAULT 'needs_info',
    assessed_by TEXT DEFAULT '',
    assessment TEXT DEFAULT '{}',
    resale_price REAL,
    est_profit REAL,
    status TEXT DEFAULT 'new',
    paid_price REAL,
    sold_price REAL,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL
);
"""


def connect():
    con = sqlite3.connect(config.DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute(SCHEMA)
    return con


def add_listing(con, source, title, url=None, raw_text="", ask_price=None, location=""):
    """Insert a listing. Returns its id, or None if that URL is already stored."""
    try:
        cur = con.execute(
            "INSERT INTO listings (source, url, title, raw_text, ask_price, location, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (source, url, title, raw_text, ask_price, location,
             datetime.now(timezone.utc).isoformat(timespec="seconds")),
        )
    except sqlite3.IntegrityError:
        return None
    con.commit()
    return cur.lastrowid


def has_url(con, url):
    return con.execute("SELECT 1 FROM listings WHERE url=?", (url,)).fetchone() is not None


def save_assessment(con, listing_id, a, assessed_by):
    con.execute(
        "UPDATE listings SET title=?, ask_price=?, location=?, category=?, verdict=?,"
        " assessed_by=?, assessment=?, resale_price=?, est_profit=? WHERE id=?",
        (a["title"], a["ask_price_usd"], a["location"], a["category"], a["verdict"],
         assessed_by, json.dumps(a), a["resale_price_usd"], a["est_profit_usd"], listing_id),
    )
    con.commit()


def update_fields(con, listing_id, **fields):
    allowed = {"status", "paid_price", "sold_price", "notes", "ask_price", "raw_text"}
    fields = {k: v for k, v in fields.items() if k in allowed}
    if not fields:
        return
    sets = ", ".join(f"{k}=?" for k in fields)
    con.execute(f"UPDATE listings SET {sets} WHERE id=?", (*fields.values(), listing_id))
    con.commit()


def get(con, listing_id):
    return con.execute("SELECT * FROM listings WHERE id=?", (listing_id,)).fetchone()


def all_listings(con, status=None):
    q = "SELECT * FROM listings"
    args = ()
    if status:
        q += " WHERE status=?"
        args = (status,)
    q += " ORDER BY (verdict='flip') DESC, COALESCE(est_profit, -1e9) DESC, id DESC"
    return con.execute(q, args).fetchall()
