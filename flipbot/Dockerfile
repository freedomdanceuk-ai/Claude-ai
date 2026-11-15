FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV FLIPBOT_HOSTED=1 FLIPBOT_DB=/data/flipbot.db PORT=10000
# One worker so the auto-scan timer runs exactly once.
CMD ["sh", "-c", "gunicorn wsgi:app --workers 1 --threads 4 --timeout 300 --bind 0.0.0.0:$PORT"]
