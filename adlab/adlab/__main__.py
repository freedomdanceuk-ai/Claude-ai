"""Entry point.

    python -m adlab                       # open the web app
    python -m adlab analyze ad.mp4 ...    # command line, see --help
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def cli(argv: list[str]) -> None:
    from . import pipeline
    from .market import CATEGORIES, GOALS, REGIONS

    ap = argparse.ArgumentParser(prog="adlab analyze", description="Analyse an advert and make platform versions.")
    ap.add_argument("file")
    ap.add_argument("--name", default="", help="business / brand name")
    ap.add_argument("--product", default="")
    ap.add_argument("--category", default="auto", choices=["auto", *CATEGORIES])
    ap.add_argument("--region", action="append", choices=list(REGIONS), help="repeatable; default zimbabwe")
    ap.add_argument("--price", default="")
    ap.add_argument("--contact", default="", help="WhatsApp / phone number for the call to action")
    ap.add_argument("--text", default="", help="caption you plan to post")
    ap.add_argument("--goal", default="messages", choices=list(GOALS))
    ap.add_argument("--budget", type=float, default=0)
    ap.add_argument("--days", type=int)
    ap.add_argument("--logo")
    ap.add_argument("--out", default="adlab_output")
    ap.add_argument("--no-ai", action="store_true", help="skip the Claude review")
    ap.add_argument("--no-render", action="store_true", help="only analyse, don't create files")
    a = ap.parse_args(argv)

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    business = {"name": a.name, "product": a.product, "category": a.category, "regions": a.region or ["zimbabwe"],
                "price": a.price, "contact": a.contact, "ad_text": a.text, "goal": a.goal,
                "budget": a.budget or "", "days": a.days or "", "logo_path": a.logo}
    print("Analysing", a.file, "...")
    r = pipeline.analyze(Path(a.file).resolve(), business, out, use_ai=not a.no_ai)
    if r.get("claude") and r["claude"].get("error"):
        print("Note:", r["claude"]["error"])
    if not a.no_render:
        print("Creating formats:", ", ".join(r["suggested_targets"]))
        res = pipeline.produce(out, r["suggested_actions"], r["suggested_targets"], r["branding"])
        print(f"Done. {len(res['files'])} files + campaign plan in {out / 'out'} (zip: {out / res['zip']})")
    else:
        (out / "campaign_plan.md").write_text(pipeline.to_markdown(r))
    print()
    print(pipeline.to_markdown(r))


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "analyze":
        cli(sys.argv[2:])
    else:
        from .app import main as web

        web()


if __name__ == "__main__":
    main()
