"""The Keeper's news desk.

Collects stories from the feeds, has Claude pick the ones that fit
Zvakavanzika, rates each 🟢/🟡/🔴, and drafts a script in The Keeper's
voice. Output is a review queue for the human editor; nothing is published
automatically.

Usage:
    python keeper_desk.py              # pick up to 5 stories
    python keeper_desk.py --max 8
    python keeper_desk.py --dry-run    # fetch and list feed items, no Claude calls
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import re
import sys
from enum import Enum
from pathlib import Path

import anthropic
import feedparser
from pydantic import BaseModel, Field

from feeds import FEEDS

MODEL = "claude-opus-5-5"
HERE = Path(__file__).resolve().parent
BIBLE = HERE.parent / "the-keeper.md"
STATE = HERE / "state" / "seen.json"
OUT = HERE / "out"
USER_AGENT = "ZvakavanzikaDesk/1.0 (+news review tool)"
MAX_ITEMS_PER_FEED = 25
MAX_SEEN = 5000


# ---------- Structured outputs ----------

class Segment(str, Enum):
    bizarre_desk = "The Bizarre Desk"
    unexplained = "Unexplained"
    taboo_talk = "Taboo Talk"
    legend_files = "Legend Files"
    then_vs_now = "Then vs Now"


class Rating(str, Enum):
    confirmed = "CONFIRMED"
    reported = "REPORTED"
    legend = "LEGEND"


class Pick(BaseModel):
    item_ids: list[int] = Field(description="IDs of every feed item covering this same story")
    segment: Segment
    rating: Rating
    rating_reason: str = Field(description="Why this rating, citing which sources support it")
    why_it_works: str = Field(description="One line: why Zvakavanzika viewers will care")
    risk_flags: list[str] = Field(description="Editorial/legal risks the editor must check; empty if none")


class Picks(BaseModel):
    picks: list[Pick]


class Script(BaseModel):
    headline: str = Field(description="Short on-screen title, max 8 words")
    hook: str = Field(description="First line The Keeper says; must stop the scroll in 3 seconds")
    script: str = Field(description="Full spoken script for The Keeper, 120-180 words, '...' for pauses")
    rating_line: str = Field(description="One spoken line telling viewers how verified this is")
    sources: list[str] = Field(description="URLs of the feed items used; only URLs provided to you")
    anonymisation: str = Field(description="Which names/places were removed or generalised, or 'none needed'")
    editor_checks: list[str] = Field(description="Specific facts the editor must verify before publishing")
    visuals: list[str] = Field(description="3-5 b-roll or illustration ideas; AI visuals only for LEGEND stories")


# ---------- Feeds ----------

def clean(text: str, limit: int) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", " ", text or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def item_key(link: str, title: str) -> str:
    return hashlib.sha1((link or title).encode()).hexdigest()[:16]


def fetch_items(seen: set[str]) -> list[dict]:
    items = []
    for source, url in FEEDS:
        feed = feedparser.parse(url, agent=USER_AGENT)
        if feed.bozo and not feed.entries:
            print(f"  ! {source}: no items ({feed.get('bozo_exception', 'unknown error')})", file=sys.stderr)
            continue
        count = 0
        for entry in feed.entries[:MAX_ITEMS_PER_FEED]:
            title = clean(entry.get("title", ""), 200)
            link = entry.get("link", "")
            key = item_key(link, title)
            if not title or key in seen:
                continue
            items.append({
                "key": key,
                "source": source,
                "title": title,
                "summary": clean(entry.get("summary", ""), 500),
                "link": link,
                "published": entry.get("published", ""),
            })
            count += 1
        print(f"  {source}: {count} new", file=sys.stderr)
    for i, item in enumerate(items):
        item["id"] = i
    return items


def load_seen() -> set[str]:
    try:
        return set(json.loads(STATE.read_text()))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def save_seen(seen: set[str], new_keys: list[str]) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    merged = list(seen) + [k for k in new_keys if k not in seen]
    STATE.write_text(json.dumps(merged[-MAX_SEEN:]))


# ---------- Claude ----------

def system_prompt() -> str:
    bible = BIBLE.read_text()
    return f"""You are the editorial desk for Zvakavanzika ("hidden things"), a channel for bizarre, taboo and mysterious stories, presented by an AI anchor called The Keeper. The audience is mainly Zimbabwean and Southern African, on TikTok, YouTube Shorts and WhatsApp.

The channel's anchor bible, including its truth-rating system and non-negotiable rules:

<bible>
{bible}
</bible>

Rating rules, applied strictly:
- CONFIRMED only when the story rests on court records, a police statement, or at least two independent outlets among the items provided.
- REPORTED when only one credible outlet reports it.
- LEGEND for folklore, myths, unexplained cases with no factual resolution, and anything sourced only from forums such as Reddit.
- When unsure, choose the lower rating.

Editorial rules:
- Never name or identify a private individual accused of witchcraft, curses, infidelity, or any crime not yet proven in court. Generalise to "a man in a village near Masvingo".
- Skip stories built on gore, harm to children, sexual violence, or mocking someone's disability or poverty.
- Treat spiritual beliefs (ngozi, n'anga, tokoloshe, ancestors) with respect; the tone is curious, never mocking.
- Avoid party politics unless the story is genuinely bizarre and not partisan.
- Never invent facts, quotes, names, dates or sources. Use only what the feed items say."""


def make_client() -> anthropic.Anthropic:
    return anthropic.Anthropic()


def call(client: anthropic.Anthropic, schema: type[BaseModel], prompt: str, effort: str):
    response = client.beta.messages.parse(
        model=MODEL,
        max_tokens=16000,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        cache_control={"type": "ephemeral"},
        system=system_prompt(),
        output_config={"effort": effort},
        output_format=schema,
        messages=[{"role": "user", "content": prompt}],
    )
    if response.stop_reason == "refusal":
        category = response.stop_details.category if response.stop_details else None
        raise RuntimeError(f"Claude declined this request (category: {category})")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("Response was cut off at max_tokens")
    return response.parsed_output


def pick_stories(client, items: list[dict], max_picks: int) -> list[Pick]:
    listing = "\n".join(
        f"[{it['id']}] ({it['source']}) {it['title']} | {it['summary']}" for it in items
    )
    prompt = f"""Here are today's new feed items:

{listing}

Choose up to {max_picks} stories that best fit Zvakavanzika. Prefer Zimbabwean and African stories, then the strongest global ones. Mix segments where possible. Group items covering the same story into one pick. Leave out ordinary news, anything that breaks the editorial rules, and anything too thin to build 60 seconds on. Fewer strong picks beat more weak ones."""
    picks = call(client, Picks, prompt, effort="medium").picks
    valid = {it["id"] for it in items}
    return [p for p in picks if p.item_ids and set(p.item_ids) <= valid][:max_picks]


def write_script(client, pick: Pick, items: list[dict]) -> Script:
    used = [items[i] for i in pick.item_ids]
    material = "\n\n".join(
        f"Source: {it['source']}\nURL: {it['link']}\nPublished: {it['published']}\nTitle: {it['title']}\nSummary: {it['summary']}"
        for it in used
    )
    prompt = f"""Write The Keeper's script for this story.

Segment: {pick.segment.value}
Rating: {pick.rating.value} ({pick.rating_reason})
Desk risk flags: {', '.join(pick.risk_flags) or 'none'}

Source material:
{material}

The Keeper's voice: calm, low, unhurried, knowing; speaks to one viewer; deliberate pauses ('...') before reveals; never shouts, never sensationalises; dignified and respectful of belief. Open with a hook, tell the story in plain spoken English, and end with the rating line and an invitation to share what the viewer believes. Stay within what the sources say."""
    return call(client, Script, prompt, effort="high")


# ---------- Output ----------

BADGE = {Rating.confirmed: "🟢 CONFIRMED", Rating.reported: "🟡 REPORTED", Rating.legend: "🔴 LEGEND"}


def render(date: str, results: list[tuple[Pick, Script]]) -> str:
    lines = [
        f"# Zvakavanzika review queue: {date}",
        "",
        "Nothing here is published until an editor ticks every box. Delete stories you reject.",
        "",
    ]
    for n, (pick, s) in enumerate(results, 1):
        lines += [
            f"## {n}. {s.headline}",
            "",
            f"**{BADGE[pick.rating]}** · {pick.segment.value}  ",
            f"**Why:** {pick.why_it_works}  ",
            f"**Rating reason:** {pick.rating_reason}",
            "",
            f"**Hook:** {s.hook}",
            "",
            "**Script:**",
            "",
            "> " + s.script.replace("\n", "\n> "),
            "",
            f"**Rating line:** {s.rating_line}",
            "",
            f"**Anonymisation:** {s.anonymisation}",
            "",
            "**Risk flags:** " + ("; ".join(pick.risk_flags) or "none"),
            "",
            "**Visuals:**",
            *[f"- {v}" for v in s.visuals],
            "",
            "**Sources:**",
            *[f"- {u}" for u in s.sources],
            "",
            "**Editor checklist:**",
            *[f"- [ ] {c}" for c in s.editor_checks],
            "- [ ] No private person is identifiable",
            "- [ ] Rating matches the evidence",
            "- [ ] Approved for recording",
            "",
        ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--max", type=int, default=5, help="maximum stories to draft")
    parser.add_argument("--dry-run", action="store_true", help="fetch feeds only, no Claude calls")
    args = parser.parse_args()

    seen = load_seen()
    print("Fetching feeds...", file=sys.stderr)
    items = fetch_items(seen)
    print(f"{len(items)} new items", file=sys.stderr)
    if args.dry_run:
        for it in items:
            print(f"[{it['id']}] ({it['source']}) {it['title']}")
        return 0
    if not items:
        print("Nothing new today.", file=sys.stderr)
        return 0

    client = make_client()
    try:
        print("Choosing stories...", file=sys.stderr)
        picks = pick_stories(client, items, args.max)
        results = []
        for pick in picks:
            print(f"Drafting: {items[pick.item_ids[0]]['title']}", file=sys.stderr)
            try:
                results.append((pick, write_script(client, pick, items)))
            except RuntimeError as e:
                print(f"  skipped: {e}", file=sys.stderr)
    except anthropic.AuthenticationError:
        print("No valid Anthropic API key. Set ANTHROPIC_API_KEY.", file=sys.stderr)
        return 1
    except anthropic.RateLimitError:
        print("Rate limited by the Anthropic API; try again in a few minutes.", file=sys.stderr)
        return 1
    except anthropic.APIConnectionError:
        print("Could not reach the Anthropic API; check the network.", file=sys.stderr)
        return 1
    except anthropic.APIStatusError as e:
        print(f"Anthropic API error {e.status_code}: {e.message}", file=sys.stderr)
        return 1

    date = dt.date.today().isoformat()
    OUT.mkdir(exist_ok=True)
    path = OUT / f"{date}.md"
    path.write_text(render(date, results))
    save_seen(seen, [it["key"] for it in items])
    print(f"Wrote {len(results)} stories to {path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
