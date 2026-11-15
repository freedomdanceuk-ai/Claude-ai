"""Flip bot dashboard.  Run:  python app.py   then open http://localhost:5000"""
import hmac
import json
import os
import secrets
import threading
import time
import urllib.error

from flask import Flask, flash, redirect, render_template, request, session, url_for

import assess as assessor
import config
import db
import sources

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("FLIPBOT_HOSTED")),
    PERMANENT_SESSION_LIFETIME=60 * 60 * 24 * 30,
)
client = assessor.get_client()

# When set, the dashboard asks for this password. Always set it when hosting online.
PASSWORD = os.environ.get("FLIPBOT_PASSWORD", "")


@app.before_request
def require_login():
    if not PASSWORD or session.get("ok") or request.endpoint in ("login", "static", "health"):
        return None
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        if PASSWORD and hmac.compare_digest(request.form.get("password", "").encode(), PASSWORD.encode()):
            session.permanent = True
            session["ok"] = True
            return redirect(url_for("index"))
        time.sleep(2)  # slow down password guessing
        flash("Wrong password.", "error")
    return render_template("login.html")


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/health")
def health():
    return "ok"


def run_assessment(con, row):
    a, by = assessor.assess(client, row["title"], row["raw_text"], row["ask_price"], row["location"])
    db.save_assessment(con, row["id"], a, by)


def money(v):
    return "—" if v is None else f"${v:,.0f}"


app.jinja_env.filters["money"] = money


@app.route("/")
def index():
    con = db.connect()
    status = request.args.get("status", "new")
    rows = db.all_listings(con, None if status == "all" else status)
    deals = [dict(r, a=json.loads(r["assessment"] or "{}")) for r in rows]
    everything = db.all_listings(con)
    counts = {s: sum(1 for r in everything if r["status"] == s) for s in db.STATUSES}
    sold = [r for r in everything if r["status"] == "sold" and r["sold_price"] and r["paid_price"]]
    stats = {
        "waiting": sum(1 for r in everything if r["verdict"] == "flip" and r["status"] == "new"),
        "open_profit": sum(r["est_profit"] or 0 for r in everything
                           if r["verdict"] == "flip" and r["status"] in ("new", "advertised", "buyer_found", "bought")),
        "realised": sum(r["sold_price"] - r["paid_price"] for r in sold),
        "sold": len(sold),
    }
    return render_template("index.html", deals=deals, status=status, counts=counts, stats=stats,
                           statuses=db.STATUSES, has_password=bool(PASSWORD), ai_on=client is not None, total=len(everything))


def scan_once():
    """Fetch new listings and assess them. Returns (new count, error text or '')."""
    con = db.connect()
    new_ids = sources.scan(con)
    error = ""
    for lid in new_ids:
        try:
            run_assessment(con, db.get(con, lid))
        except RuntimeError as e:
            error = str(e)
    return len(new_ids), error


def scan_forever():
    while True:
        try:
            n, error = scan_once()
            print(f"[auto-scan] {n} new listing(s) {error}", flush=True)
        except Exception as e:  # keep the timer alive whatever one scan does
            print(f"[auto-scan] failed: {e}", flush=True)
        time.sleep(config.SCAN_EVERY_MINUTES * 60)


@app.post("/scan")
def scan():
    try:
        n, error = scan_once()
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        flash(f"Could not read the listings feed: {e}", "error")
        return redirect(url_for("index"))
    msg = f"Scan finished: {n} new listing(s)."
    if error:
        msg += f" Some could not be assessed: {error}"
    flash(msg, "error" if error else "ok")
    return redirect(url_for("index"))


@app.post("/add")
def add():
    title = request.form.get("title", "").strip()
    text = request.form.get("text", "").strip()
    if not title and not text:
        flash("Paste the listing text or give it a title.", "error")
        return redirect(url_for("index"))
    price = request.form.get("price", "").strip()
    con = db.connect()
    lid = db.add_listing(
        con, request.form.get("source", "").strip() or "pasted", title or text[:60],
        url=request.form.get("url", "").strip() or None, raw_text=text,
        ask_price=float(price) if price else None,
        location=request.form.get("location", "").strip(),
    )
    if lid is None:
        flash("That link is already on the dashboard.", "error")
        return redirect(url_for("index"))
    try:
        run_assessment(con, db.get(con, lid))
        flash("Listing added and assessed.", "ok")
    except RuntimeError as e:
        flash(f"Listing saved, but not assessed: {e}", "error")
    return redirect(url_for("index"))


@app.post("/listing/<int:lid>/update")
def update(lid):
    con = db.connect()
    f = request.form
    fields = {}
    if f.get("status") in db.STATUSES:
        fields["status"] = f["status"]
    for key in ("paid_price", "sold_price", "ask_price"):
        if f.get(key, "").strip():
            fields[key] = float(f[key])
    if "notes" in f:
        fields["notes"] = f["notes"]
    if f.get("extra_text", "").strip():
        fields["raw_text"] = (db.get(con, lid)["raw_text"] + "\n" + f["extra_text"]).strip()
    db.update_fields(con, lid, **fields)
    if "ask_price" in fields or "raw_text" in fields or f.get("reassess"):
        try:
            run_assessment(con, db.get(con, lid))
        except RuntimeError as e:
            flash(str(e), "error")
    return redirect(request.referrer or url_for("index"))


def start_auto_scan():
    if config.SCAN_EVERY_MINUTES:
        threading.Thread(target=scan_forever, daemon=True).start()


if __name__ == "__main__":
    start_auto_scan()
    # Without a password, only this computer can open the dashboard.
    app.run(host="0.0.0.0" if PASSWORD else "127.0.0.1", port=5000, debug=False)
