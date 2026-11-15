"""Entry point for hosting online (gunicorn wsgi:app). Refuses to start without a password."""
import app as flipbot

if not flipbot.PASSWORD:
    raise SystemExit("Set FLIPBOT_PASSWORD before hosting the dashboard online.")

flipbot.start_auto_scan()
app = flipbot.app
