"""AdLab web app. Run with:  python -m adlab  (then open http://127.0.0.1:5000)"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

from flask import Flask, abort, redirect, render_template, request, send_from_directory, url_for
from werkzeug.utils import secure_filename

from . import ai, pipeline
from .formats import ACTIONS, SPECS
from .market import CATEGORIES, GOALS, REGIONS
from .media import IMAGE_EXTS, VIDEO_EXTS

DATA = Path(os.environ.get("ADLAB_DATA", Path.home() / "AdLab"))
JOBS = DATA / "jobs"
JOB_ID = re.compile(r"^[0-9a-f]{10}$")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 1024 * 1024 * 1024  # 1 GB uploads


def _job(job_id: str) -> Path:
    if not JOB_ID.match(job_id):
        abort(404)
    d = JOBS / job_id
    if not (d / "report.json").exists():
        abort(404)
    return d


@app.get("/")
def index():
    jobs = []
    if JOBS.exists():
        for d in sorted(JOBS.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)[:12]:
            rp = d / "report.json"
            if rp.exists():
                r = json.loads(rp.read_text())
                jobs.append({"id": d.name, "name": Path(r["source"]).name, "score": r["score"],
                             "product": r["business"].get("product", "")})
    return render_template("index.html", categories=CATEGORIES, regions=REGIONS, goals=GOALS,
                           ai_on=ai.available(), jobs=jobs,
                           accept=",".join(sorted(IMAGE_EXTS | VIDEO_EXTS)))


@app.post("/analyze")
def analyze():
    f = request.files.get("media")
    if not f or not f.filename:
        return redirect(url_for("index"))
    name = secure_filename(f.filename) or "upload"
    if Path(name).suffix.lower() not in IMAGE_EXTS | VIDEO_EXTS:
        return render_template("error.html", message=f"{Path(name).suffix} files are not supported."), 400

    job = pipeline.new_job(JOBS, name)
    src = job / name
    f.save(src)

    logo_path = None
    logo = request.files.get("logo")
    if logo and logo.filename:
        logo_path = job / ("logo" + Path(secure_filename(logo.filename)).suffix.lower())
        logo.save(logo_path)

    form = request.form
    business = {
        "name": form.get("name", "").strip(),
        "product": form.get("product", "").strip(),
        "category": form.get("category", "auto"),
        "regions": form.getlist("regions") or ["global"],
        "price": form.get("price", "").strip(),
        "contact": form.get("contact", "").strip(),
        "ad_text": form.get("ad_text", "").strip(),
        "goal": form.get("goal", "messages"),
        "budget": form.get("budget", "").strip(),
        "days": form.get("days", "").strip(),
        "logo_path": str(logo_path) if logo_path else None,
    }
    try:
        pipeline.analyze(src, business, job, use_ai=form.get("use_ai") == "on")
    except Exception as e:  # show a friendly page instead of a stack trace
        return render_template("error.html", message=str(e)), 500
    return redirect(url_for("report", job_id=job.name))


@app.get("/job/<job_id>")
def report(job_id: str):
    d = _job(job_id)
    r = json.loads((d / "report.json").read_text())
    produced = json.loads((d / "produced.json").read_text()) if (d / "produced.json").exists() else None
    return render_template("report.html", r=r, job_id=job_id, actions=ACTIONS, specs=SPECS, produced=produced)


@app.post("/job/<job_id>/produce")
def produce(job_id: str):
    d = _job(job_id)
    r = json.loads((d / "report.json").read_text())
    form = request.form
    branding = {
        "brand": form.get("brand", ""), "hook": form.get("hook", ""), "price": form.get("price", ""),
        "cta": form.get("cta", ""), "logo_path": r["branding"].get("logo_path"),
        "color": form.get("color", "#F5B700"),
    }
    try:
        result = pipeline.produce(d, form.getlist("actions"), form.getlist("targets"), branding)
    except Exception as e:
        return render_template("error.html", message=str(e)), 500
    (d / "produced.json").write_text(json.dumps(result))
    return redirect(url_for("report", job_id=job_id) + "#downloads")


@app.get("/job/<job_id>/file/<path:name>")
def job_file(job_id: str, name: str):
    d = _job(job_id)
    if name.startswith("frame_"):
        return send_from_directory(d / "work" / "frames" if (d / "work" / "frames").exists() else d / "work", name)
    if name == "adlab_pack.zip":
        return send_from_directory(d, name, as_attachment=True)
    return send_from_directory(d / "out", name, as_attachment=request.args.get("dl") == "1")


def main() -> None:
    import argparse
    import webbrowser

    ap = argparse.ArgumentParser(description="AdLab web app")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    JOBS.mkdir(parents=True, exist_ok=True)
    url = f"http://{args.host}:{args.port}"
    print(f"AdLab running at {url}  (files saved in {DATA})")
    print("Claude AI analysis:", "ON" if ai.available() else "OFF (set ANTHROPIC_API_KEY to turn it on)")
    if not args.no_browser:
        webbrowser.open(url)
    app.run(host=args.host, port=args.port, debug=False)
