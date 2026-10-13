"""Glue: analyse an advert end to end, then render the chosen fixes and formats."""

from __future__ import annotations

import json
import shutil
import uuid
import zipfile
from dataclasses import asdict
from pathlib import Path

from . import ai, market, planner, virality
from .formats import ACTIONS, SPECS, Branding, RenderJob, render, targets_for_channels
from .media import analyze_media


def new_job(root: Path, upload_name: str) -> Path:
    job = root / uuid.uuid4().hex[:10]
    (job / "out").mkdir(parents=True)
    return job


def analyze(src: Path, business: dict, job_dir: Path, use_ai: bool = True) -> dict:
    media = analyze_media(src, job_dir / "work")
    category = business.get("category") or "auto"
    if category == "auto":
        category = market.detect_category(f"{business.get('product', '')} {business.get('ad_text', '')} "
                                          f"{business.get('name', '')}")
    regions = business.get("regions") or ["global"]

    vr = virality.score(media, business.get("ad_text", ""), business.get("price", ""))

    claude: dict | None = None
    if use_ai and ai.available():
        metrics = {k: (round(v, 2) if isinstance(v, float) else v) for k, v in media.to_dict().items()
                   if k not in ("frames", "frame_paths", "path")}
        metrics["rule_based_virality_score"] = vr.score
        claude = ai.analyze(media.frame_paths, business, metrics)
        if "error" not in claude and business.get("category", "auto") == "auto":
            category = claude.get("detected_category", category)

    score = vr.score
    if claude and "error" not in claude:
        # Blend: Claude judges content/emotion, the rules judge technical quality.
        score = int(round(0.55 * claude["virality_score"] + 0.45 * vr.score))

    audience = market.audience_report(category, regions)
    budget = float(business.get("budget") or 0)
    plan = planner.plan(
        budget=budget or 100.0,
        category=category,
        regions=regions,
        goal=business.get("goal", "messages"),
        days=int(business["days"]) if business.get("days") else None,
        orientation=media.orientation,
        virality_score=score,
    )
    plan["budget_given"] = bool(budget)

    recs = [asdict(r) for r in vr.recommendations]
    suggested_actions = sorted({r["action"] for r in recs if r["action"]} | {"enhance"})
    if media.kind == "image":
        suggested_actions = [a for a in suggested_actions if a not in ("trim", "normalize_audio")]

    hook = (claude or {}).get("hook_text") or business.get("hook") or (
        f"New: {business['product']}" if business.get("product") else "")
    cta = (claude or {}).get("cta_text") or (
        f"Order on WhatsApp {business['contact']}" if business.get("contact") else "Message us to order today")

    report = {
        "source": str(src),
        "kind": media.kind,
        "business": business,
        "category": category,
        "media": {k: v for k, v in media.to_dict().items() if k != "frames"},
        "virality": vr.to_dict(),
        "score": score,
        "claude": claude,
        "audience": audience,
        "plan": plan,
        "suggested_actions": suggested_actions,
        "suggested_targets": targets_for_channels([c["key"] for c in plan["channels"]] +
                                                  [o["key"] for o in plan["organic"]]),
        "branding": {"brand": business.get("name", ""), "hook": hook, "price": business.get("price", ""),
                     "cta": cta, "logo_path": business.get("logo_path")},
    }
    (job_dir / "report.json").write_text(json.dumps(report, indent=2, default=str))
    return report


def produce(job_dir: Path, actions: list[str], targets: list[str], branding: dict) -> dict:
    report = json.loads((job_dir / "report.json").read_text())
    from .media import MediaReport, FrameMetrics

    m = report["media"]
    fields = MediaReport.__dataclass_fields__.keys()
    media = MediaReport(**{k: m[k] for k in fields if k in m and k != "frames"})
    # Re-measure frames cheaply from saved stills so enhance settings match
    from PIL import Image
    from .media import frame_metrics
    media.frames = []
    for p in media.frame_paths:
        with Image.open(p) as im:
            media.frames.append(frame_metrics(im))
    if not media.frames:
        media.frames = [FrameMetrics(128, 50, 40, 300, 100, 0.1, 1.0)]

    out = job_dir / "out"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir()
    targets = [t for t in targets if t in SPECS]
    job = RenderJob(actions=set(a for a in actions if a in ACTIONS), targets=targets,
                    branding=Branding(**{k: v for k, v in branding.items() if k in Branding.__dataclass_fields__}))
    files = render(report["source"], media, job, out)
    labelled = [{"name": f.name, "label": SPECS[t].label} for f, t in zip(files, targets)]

    report["branding"] = branding
    (out / "campaign_plan.md").write_text(to_markdown(report))
    zpath = job_dir / "adlab_pack.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files + [out / "campaign_plan.md"]:
            z.write(f, f.name)
    return {"files": labelled, "zip": zpath.name, "plan": "campaign_plan.md"}


def to_markdown(r: dict) -> str:
    b = r["business"]
    p = r["plan"]
    lines = [f"# Campaign plan: {b.get('name') or 'My business'} - {b.get('product') or Path(r['source']).name}", ""]
    lines += [f"**Virality score:** {r['score']}/100 (grade {r['virality']['grade']}). {r['virality']['verdict']}", ""]
    c = r.get("claude") or {}
    if c and "error" not in c:
        lines += ["## What the AI sees", c["what_we_see"], "", c["virality_reasoning"], ""]
    lines += ["## Fixes", *[f"- [{x['priority']}] {x['text']}" for x in r["virality"]["recommendations"]]]
    if c and "error" not in c:
        lines += [*[f"- [{x['priority']}] {x['text']}" for x in c["recommendations"]]]
    lines += ["", "## Who to target"]
    auds = c.get("audiences") if c and "error" not in c else None
    if auds:
        for a in auds:
            lines.append(f"- **{a['name']}** - {a['age_range']}, {a['gender']}; interests: "
                         f"{', '.join(a['interests'])}; where: {', '.join(a['locations'])}. {a['angle']}")
    else:
        for s in r["audience"]["segments"]:
            lines.append(f"- **{s['name']}** - {s['age']}, {s['gender']}; interests: {', '.join(s['interests'])}. {s['why']}")
    lines += ["", f"## Budget: ${p['budget']:.0f} over {p['days']} days (${p['daily_total']:.2f}/day) - goal: {p['goal']}", "",
              "| Channel | Share | Total | Per day | Est. reach | Est. " + p["result_word"] + " | How |",
              "|---|---|---|---|---|---|---|"]
    for ch in p["channels"]:
        lines.append(f"| {ch['name']} | {ch['share_pct']}% | ${ch['budget']:.2f} | ${ch['daily']:.2f} | "
                     f"{ch['est_reach']:,} | {ch['est_results']} | {ch['how']} |")
    if p["organic"]:
        lines += ["", "**Post free on:** " + ", ".join(o["name"] for o in p["organic"])]
    lines += [f"- {x}" for x in p.get("skipped", [])]
    lines += ["", "### Schedule"] + [f"- **{ph['name']}** (day {ph['days']}): {ph['what']}" for ph in p["phases"]]
    lines += ["", "**Best posting times:** " + " | ".join(p["posting_times"]), ""]
    if c and "error" not in c:
        lines += ["## Ready-to-paste captions"]
        for k, v in c["captions"].items():
            lines += [f"**{k.title()}:**", v, ""]
        lines += ["**Hashtags:** " + " ".join(h if h.startswith("#") else "#" + h for h in c["hashtags"]), ""]
        if c.get("reshoot_ideas"):
            lines += ["## Ideas for the next shoot", *[f"- {x}" for x in c["reshoot_ideas"]], ""]
    else:
        lines += ["## Hook ideas for your next videos", *[f"- {h}" for h in r["audience"]["hooks"]], ""]
    lines += ["_" + " ".join(p["notes"]) + "_"]
    return "\n".join(lines)
