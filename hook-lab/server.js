import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { analyzeHook, generateHooks, HookLabError, MODEL } from "./lib/hooklab.js";

export function createApp(client = new Anthropic()) {
  const app = express();
  const here = path.dirname(fileURLToPath(import.meta.url));

  app.use(express.json({ limit: "25mb" }));
  app.use(express.static(path.join(here, "public")));

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req.body || {}));
    } catch (err) {
      res.status(errorStatus(err)).json({ error: errorMessage(err) });
    }
  };

  app.get("/api/health", (_req, res) => res.json({ ok: true, model: MODEL }));
  app.post("/api/analyze", handle((body) => analyzeHook(client, body.original || {})));
  app.post("/api/generate", handle((body) => generateHooks(client, body)));

  return app;
}

function errorStatus(err) {
  if (err instanceof HookLabError) return err.status;
  if (err instanceof Anthropic.APIError && err.status) return err.status >= 500 ? 502 : err.status;
  return 500;
}

function errorMessage(err) {
  if (err instanceof HookLabError) return err.message;
  if (err instanceof Anthropic.AuthenticationError) {
    return "Claude API key is missing or invalid. Set ANTHROPIC_API_KEY and restart the server.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Claude API error: ${err.message}`;
  console.error(err);
  return "Unexpected server error.";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => {
    console.log(`Hook Lab running at http://localhost:${port}`);
  });
}
