"""Pick channels and split an advertising budget across them."""

from __future__ import annotations

import math

from .market import CATEGORIES, CHANNELS, GOALS, REGIONS

# Conversion from a click to a sale, per purchase cycle.
RESULT_RATE = {"impulse": 0.03, "repeat": 0.025, "considered": 0.012}
# Results per impression relative to the channel's click rate, by goal.
GOAL_RATE = {"messages": 0.35, "traffic": 1.0, "sales": 1.0, "awareness": 1.0, "engagement": 3.0}


def recommend_days(purchase_cycle: str, goal: str) -> int:
    if goal in ("awareness", "engagement"):
        return 7
    return {"impulse": 10, "repeat": 14, "considered": 21}[purchase_cycle]


def plan(
    budget: float,
    category: str,
    regions: list[str],
    goal: str = "messages",
    days: int | None = None,
    orientation: str = "vertical",
    virality_score: int = 60,
) -> dict:
    cat = CATEGORIES.get(category, CATEGORIES["general"])
    regs = [REGIONS[r] for r in regions if r in REGIONS] or [REGIONS["global"]]
    cycle = cat["purchase_cycle"]
    days_fixed = bool(days)
    days = days or recommend_days(cycle, goal)

    # Score every channel: audience size x business fit x goal fit x creative fit
    rows = []
    for ch in CHANNELS.values():
        reach = sum(r["reach"].get(ch.key, 0.2) for r in regs) / len(regs)
        fit = cat["channel_fit"].get(ch.key, 0.3)
        goal_fit = 1.0 if goal in ch.best_for else 0.6
        # AdLab outputs every size, so orientation only nudges the choice slightly.
        creative = 1.0 if (ch.vertical_first == (orientation == "vertical")) else 0.92
        s = reach * fit * goal_fit * creative
        rows.append((s, ch))
    rows.sort(key=lambda x: x[0], reverse=True)

    organic = [ch for s, ch in rows if not ch.paid and s > 0.4]
    paid_rows = [(s, ch) for s, ch in rows if ch.paid]

    # Keep as many top paid channels as the budget can feed at their minimum daily spend
    daily = budget / days
    chosen: list[tuple[float, object]] = []
    skipped: list[str] = []
    for s, ch in paid_rows:
        if s < 0.25 or len(chosen) >= 4:
            break
        if sum(c.min_daily for _, c in chosen) + ch.min_daily <= daily or not chosen:
            chosen.append((s, ch))
            continue
        need = sum(c.min_daily for _, c in chosen) + ch.min_daily
        if s >= 0.5 and not days_fixed and int(budget // need) >= max(5, int(days * 0.6)):
            days = int(budget // need)  # a slightly shorter campaign that can afford this channel
            daily = budget / days
            chosen.append((s, ch))
            continue
        # Swap out weaker channels if that makes room for this stronger one.
        weaker = [(ws, wc) for ws, wc in chosen if ws < s * 0.8]
        while weaker and sum(c.min_daily for _, c in chosen) + ch.min_daily > daily:
            drop = min(weaker, key=lambda x: x[0])
            weaker.remove(drop)
            chosen.remove(drop)
            skipped.append(f"{drop[1].name} was left out so the budget can feed {ch.name}; add budget to run both.")
        if sum(c.min_daily for _, c in chosen) + ch.min_daily <= daily:
            chosen.append((s, ch))
        elif s >= 0.5:
            extra = sum(c.min_daily for _, c in chosen) + ch.min_daily - daily
            skipped.append(f"{ch.name} is a strong fit but needs about ${ch.min_daily:.0f}/day. Add roughly "
                           f"${extra * days:.0f} to the budget (or shorten the campaign) to include it; until then, "
                           f"post there for free.")

    # If even one channel's minimum isn't affordable, shorten the campaign.
    if chosen and daily < chosen[0][1].min_daily:
        days = max(3, int(budget // chosen[0][1].min_daily))
        daily = budget / days

    weight_sum = sum(s for s, _ in chosen) or 1
    cpm_mult = sum(r["cpm_mult"] for r in regs) / len(regs)
    quality = 0.7 + 0.6 * (virality_score / 100)  # better creative -> cheaper results

    # Every channel first gets its minimum daily spend; the rest follows the scores.
    floor_total = sum(ch.min_daily for _, ch in chosen) * days
    spare = max(0.0, budget - floor_total)
    channels = []
    for s, ch in chosen:
        if floor_total <= budget:
            spend = ch.min_daily * days + spare * s / weight_sum
        else:
            spend = budget * s / weight_sum
        share = spend / budget if budget else 0
        cpm = ch.base_cpm * cpm_mult / quality
        impressions = spend / cpm * 1000 if cpm else 0
        clicks = impressions * ch.base_ctr * quality
        results = clicks * GOAL_RATE.get(goal, 1.0)
        if goal == "sales":
            results *= RESULT_RATE[cycle]
        channels.append({
            "key": ch.key,
            "name": ch.name,
            "share_pct": round(share * 100),
            "budget": round(spend, 2),
            "daily": round(spend / days, 2),
            "est_cpm": round(cpm, 2),
            "est_impressions": int(impressions),
            "est_reach": int(impressions / 1.8),
            "est_results": f"{int(results * 0.6)}-{int(math.ceil(results * 1.4))}",
            "how": ch.ad_tool,
            "formats": list(ch.formats),
        })

    test_days = min(4, max(2, days // 4))
    phases = [
        {"name": "Test", "days": f"1-{test_days}",
         "spend": round(budget * 0.3, 2),
         "what": "Run 3-5 versions (different hooks/thumbnails) at equal budget. Do not touch them for 72 hours."},
        {"name": "Cut", "days": f"{test_days + 1}",
         "spend": 0,
         "what": "Switch off anything with cost per result 50% above the average, or under 1% click rate."},
        {"name": "Scale", "days": f"{test_days + 1}-{days}",
         "spend": round(budget * 0.7, 2),
         "what": "Move the remaining budget to the 1-2 winners. Raise budgets by at most 20-30% per day."},
    ]

    result_word = {"messages": "conversations", "sales": "sales", "traffic": "link clicks",
                   "awareness": "clicks", "engagement": "engagements"}[goal]
    return {
        "budget": budget,
        "days": days,
        "daily_total": round(budget / days, 2),
        "goal": GOALS.get(goal, goal),
        "result_word": result_word,
        "channels": channels,
        "organic": [{"key": c.key, "name": c.name, "how": c.ad_tool} for c in organic],
        "phases": phases,
        "posting_times": [r["peak_times"] for r in regs],
        "skipped": skipped,
        "notes": [
            "Figures are planning estimates from public benchmarks; real costs depend on your audience and creative.",
            "Post organically first. Only put money behind posts that beat your normal views in the first 24 hours.",
        ],
    }
