# AdLab: make your adverts go further

Drop in a **photo or video advert** and AdLab will:

1. **Score its viral potential** (0-100) and explain why: hook strength in the first second, vertical format, length, pacing, picture quality, colour, sound, and whether the price and call to action are clear.
2. **Analyse your market**: who to target (age, gender, interests, locations) for your type of business and region, the best times to post, and local buying habits (Zimbabwe, South Africa, Nigeria, Kenya, UK, USA, diaspora).
3. **Give recommendations and apply them**: auto-fix exposure/colour, sharpen, add a bold text hook, a price + WhatsApp call-to-action banner and your logo, trim long videos and level the sound.
4. **Choose your channels and budget**: splits your budget across TikTok, Facebook, Instagram, YouTube and others (respecting each platform's minimum daily spend), recommends how many days to run, and gives a test → cut → scale schedule with estimated reach and results.
5. **Make every format**: TikTok, Reels, Stories, WhatsApp Status, Facebook/Instagram feed, square, YouTube, X, LinkedIn, Pinterest and Snapchat, at the right size and length, with nothing important cut off.
6. **Write your captions and hashtags** (with the optional AI review).

You get a download pack (.zip) with every version plus a `campaign_plan.md` you can follow step by step.

## Install (one time)

You need **Python 3.10+** and **ffmpeg** (for video).

| | Python | ffmpeg |
|---|---|---|
| Windows | [python.org/downloads](https://www.python.org/downloads/) (tick "Add Python to PATH") | `winget install ffmpeg` |
| macOS | `brew install python` | `brew install ffmpeg` |
| Linux | `sudo apt install python3 python3-pip` | `sudo apt install ffmpeg` |

Then in this folder:

```bash
pip install -r requirements.txt
```

## Run it

- **Windows:** double-click `start.bat`
- **macOS / Linux:** `./start.sh`
- or: `python -m adlab`

Your browser opens at http://127.0.0.1:5000. Upload your advert, fill in your business details and budget, press **Analyse**, review the report, then press **Create my adverts**. Everything is saved in an `AdLab` folder in your home directory.

### Turn on the AI review (recommended)

Without a key AdLab uses its built-in rules. With a Claude API key it also *looks at* your advert and gives a much more specific review: what works, what doesn't, tailored audiences, hook and call-to-action text, ready-to-paste captions for TikTok/Instagram/Facebook/WhatsApp, hashtags and ideas for your next shoot.

1. Get a key at https://console.anthropic.com
2. Set it before starting AdLab:
   - Windows (PowerShell): `$env:ANTHROPIC_API_KEY="sk-ant-..."`
   - macOS/Linux: `export ANTHROPIC_API_KEY=sk-ant-...`

Each analysis costs a few US cents.

## Command line

```bash
python -m adlab analyze sofa_ad.mp4 \
  --name "Black Gold Furniture" --product "7-seater corner lounge suite" \
  --price "From \$650" --contact "0771 234 567" \
  --region zimbabwe --region diaspora --goal messages --budget 150
```

This prints the full report and writes all formats plus the zip into `adlab_output/`. Add `--no-render` to only analyse, or `--no-ai` to skip the Claude review. `python -m adlab analyze --help` lists every option.

## Good to know

- The virality score is a guide, not a guarantee. Use it to compare versions of the same ad, then let real numbers decide: post organically first and only put money behind posts that beat your usual views in the first 24 hours.
- Budget and reach figures are planning estimates from public benchmarks. Ads Manager shows the live estimate for your exact audience.
- Non-vertical footage is placed on a blurred background rather than cropped, so nothing gets cut off. Filming vertically in the first place always looks best.
- Videos take a little while to render (roughly 10-40 seconds per format, depending on your computer and the video length).

## Development

```bash
pip install pytest
python -m pytest tests
```

Code layout: `media.py` (measurements), `virality.py` (score and fixes), `market.py` (audiences, regions, channels), `planner.py` (budget), `formats.py` (rendering), `ai.py` (Claude review), `pipeline.py` (glue), `app.py` + `templates/` (web app).
