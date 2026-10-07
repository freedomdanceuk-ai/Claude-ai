# The Keeper's news desk

Finds bizarre, taboo and mysterious stories every day and drafts scripts for The Keeper.

```
feeds  ──►  Claude picks + rates 🟢🟡🔴  ──►  Claude drafts Keeper script  ──►  out/YYYY-MM-DD.md  ──►  human editor
```

Nothing is published automatically. Each story in the review queue has an editor checklist
that must be ticked before recording.

## Setup

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...   # from console.anthropic.com
```

## Run

```bash
python keeper_desk.py --dry-run   # check which feeds work, no API calls
python keeper_desk.py             # draft up to 5 stories
python keeper_desk.py --max 8
```

Run it once a day (morning works best for evening uploads). Items already seen are
remembered in `state/seen.json`, so each run only looks at new stories.

## How it decides

- Channel rules and the truth-rating system come from `../the-keeper.md`. Edit that file
  and the desk follows the new rules on its next run.
- 🟢 CONFIRMED needs court/police records or two independent outlets; 🟡 REPORTED is one
  outlet; 🔴 LEGEND is folklore, forums and unresolved mysteries. When unsure it rates lower.
- Private people accused of witchcraft, curses or unproven crimes are never named.
- Gore, harm to children and sexual violence are skipped.

## Feeds

Edit `feeds.py`. Feed addresses change; `--dry-run` shows which ones return stories.

## Cost

Uses Claude Opus 5.5 (one call to choose stories, one per drafted script). A daily run of
5 stories is typically well under $1.
