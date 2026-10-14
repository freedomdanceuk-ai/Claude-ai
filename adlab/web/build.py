"""Build the single-file browser version of AdLab (web/dist/adlab.html).

The browser app shares its market data, platform sizes and fix names with the
Python package, so they are injected here instead of being copied by hand.

    python web/build.py
"""

import json
import sys
from dataclasses import asdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from adlab.formats import ACTIONS, SPECS  # noqa: E402
from adlab.market import CATEGORIES, CHANNELS, GOALS, REGIONS  # noqa: E402

data = {
    "channels": {k: asdict(c) for k, c in CHANNELS.items()},
    "regions": REGIONS,
    "categories": CATEGORIES,
    "goals": GOALS,
    "specs": {k: asdict(s) for k, s in SPECS.items()},
    "actions": ACTIONS,
}
src = (HERE / "app.html").read_text()
out = src.replace("/*__ADLAB_DATA__*/null", json.dumps(data, separators=(",", ":")))
(HERE / "dist").mkdir(exist_ok=True)
(HERE / "dist" / "adlab.html").write_text(out)
print("wrote", HERE / "dist" / "adlab.html", f"({len(out) // 1024} KB)")

# Standalone website (GitHub Pages serves /docs): a full document with the head split out.
head, body = out.split('<div class="wrap">', 1)
site = (
    "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
    "<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
    "body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n"
    + head + "</head>\n<body>\n<div class=\"wrap\">" + body + "\n</body></html>\n"
)
docs = HERE.parent.parent / "docs"
docs.mkdir(exist_ok=True)
(docs / "index.html").write_text(site)
(docs / ".nojekyll").write_text("")
print("wrote", docs / "index.html")
