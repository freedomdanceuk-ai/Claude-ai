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
