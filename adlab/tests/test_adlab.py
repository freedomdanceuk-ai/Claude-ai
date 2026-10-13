import json
import shutil
import subprocess

import pytest
from PIL import Image, ImageDraw

from adlab import market, pipeline, planner, virality
from adlab.app import app
from adlab.formats import SPECS
from adlab.media import analyze_media

HAS_FFMPEG = bool(shutil.which("ffmpeg"))


@pytest.fixture
def photo(tmp_path):
    im = Image.new("RGB", (1600, 1200), (70, 50, 40))
    d = ImageDraw.Draw(im)
    for i in range(0, 1600, 80):
        d.rectangle((i, 300, i + 40, 900), fill=(200, 150 + i % 100, 90))
    p = tmp_path / "sofa.jpg"
    im.save(p)
    return p


@pytest.fixture
def video(tmp_path):
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg not installed")
    p = tmp_path / "ad.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=6",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-c:v", "libx264", "-c:a", "aac",
                    "-shortest", str(p)], check=True)
    return p


def test_photo_metrics_and_score(photo):
    m = analyze_media(photo, photo.parent / "w")
    assert m.kind == "image" and m.orientation == "horizontal"
    r = virality.score(m)
    assert 0 <= r.score <= 100
    actions = {x.action for x in r.recommendations}
    assert {"reformat", "price_cta"} <= actions
    # Adding price + CTA must raise the score
    assert virality.score(m, "Order on WhatsApp today", "$650").score > r.score


def test_video_metrics(video):
    m = analyze_media(video, video.parent / "w")
    assert m.kind == "video" and m.has_audio
    assert 5.5 < m.duration < 6.5
    assert len(m.frames) >= 3


def test_category_detection():
    assert market.detect_category("7 seater lounge suite sofa") == "furniture"
    assert market.detect_category("chicken and chips special") == "food"
    assert market.detect_category("xyz") == "general"


def test_plan_respects_budget():
    p = planner.plan(200, "furniture", ["zimbabwe"], "messages", days=14)
    assert abs(sum(c["budget"] for c in p["channels"]) - 200) < 0.05
    assert p["channels"][0]["key"] in ("facebook", "tiktok")
    assert any(o["key"] == "whatsapp" for o in p["organic"])
    small = planner.plan(10, "furniture", ["zimbabwe"], "messages")
    assert small["days"] <= 4  # campaign shortened so daily spend meets the minimum


def test_full_photo_pipeline(photo, tmp_path):
    job = tmp_path / "job"
    job.mkdir()
    business = {"name": "Black Gold", "product": "sofa", "regions": ["zimbabwe"], "price": "$650",
                "contact": "0771 234 567", "budget": "100", "goal": "messages"}
    r = pipeline.analyze(photo, business, job, use_ai=False)
    assert r["category"] == "furniture"
    res = pipeline.produce(job, r["suggested_actions"], ["tiktok", "square"], r["branding"])
    sizes = {f["name"]: Image.open(job / "out" / f["name"]).size for f in res["files"]}
    assert sizes == {"sofa_tiktok.jpg": (1080, 1920), "sofa_square.jpg": (1080, 1080)}
    assert (job / "adlab_pack.zip").exists()
    assert "Campaign plan" in (job / "out" / "campaign_plan.md").read_text()


def test_full_video_pipeline(video, tmp_path):
    job = tmp_path / "job"
    job.mkdir()
    r = pipeline.analyze(video, {"name": "B", "regions": ["uk"], "price": "£20"}, job, use_ai=False)
    res = pipeline.produce(job, ["enhance", "hook_text", "price_cta", "normalize_audio"], ["instagram_reel"],
                           {**r["branding"], "hook": "Wait for it"})
    out = job / "out" / res["files"][0]["name"]
    info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(out)],
                                     capture_output=True, text=True).stdout)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    assert (v["width"], v["height"]) == (SPECS["instagram_reel"].width, SPECS["instagram_reel"].height)
    assert any(s["codec_type"] == "audio" for s in info["streams"])


def test_web_flow(photo, tmp_path, monkeypatch):
    monkeypatch.setattr("adlab.app.JOBS", tmp_path / "jobs")
    c = app.test_client()
    assert c.get("/").status_code == 200
    with open(photo, "rb") as f:
        resp = c.post("/analyze", data={"media": (f, "sofa.jpg"), "name": "BG", "product": "sofa",
                                        "regions": "zimbabwe", "budget": "50"},
                      content_type="multipart/form-data")
    assert resp.status_code == 302
    url = resp.headers["Location"]
    page = c.get(url)
    assert page.status_code == 200 and b"Virality potential" in page.data
    job_id = url.rstrip("/").split("/")[-1]
    resp = c.post(f"/job/{job_id}/produce", data={"actions": ["enhance", "price_cta"], "targets": ["tiktok"],
                                                  "brand": "BG", "price": "$50", "cta": "WhatsApp 0771 234 567",
                                                  "hook": "", "color": "#F5B700"})
    assert resp.status_code == 302
    page = c.get(f"/job/{job_id}")
    assert b"Your adverts are ready" in page.data
    assert c.get(f"/job/{job_id}/file/adlab_pack.zip").status_code == 200
    assert c.get("/job/../../etc/file/passwd").status_code == 404


def test_price_banner_suggested_even_if_caption_has_cta(photo, tmp_path):
    job = tmp_path / "job"
    job.mkdir()
    r = pipeline.analyze(photo, {"product": "sofa", "price": "$650", "contact": "0771",
                                 "ad_text": "WhatsApp to order! $650"}, job, use_ai=False)
    assert {"price_cta", "hook_text"} <= set(r["suggested_actions"])
