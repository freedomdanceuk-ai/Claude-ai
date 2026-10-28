# Hook Lab

Turn viral video hooks into your own. Paste in a hook that went viral and Hook Lab breaks it down: which kind of hook it is, the psychological triggers it uses, and what is said, shown on screen, heard and how fast it moves. It turns all of that into a fill-in-the-blank template. It then writes new hooks for your business that work for the same reasons but use your own words, products and audience.

## What it does

1. **Analyse a viral hook.** You enter the spoken words, the on-screen text and what happens on screen. Screenshots of the opening are optional. You get back:
   - the hook type (Curiosity Gap, Contrarian, Negative Hook, Result-First, etc.)
   - the psychological triggers and how each one is used
   - a breakdown of the spoken, on-screen text, visual, audio and pacing elements
   - a reusable **template** with `[SLOTS]`, e.g. `Stop [COMMON_ACTION]. Here's why.`
   - the open loop, why it works, and what *not* to copy
2. **Generate your hooks.** Hook Lab fills the template for your brand. Each hook comes with:
   - the line to say in the first 3 seconds
   - on-screen text, the opening shot and a short shot list
   - which principles it borrows, and how the rest of the video pays it off
3. **Iterate.** Add feedback ("more humour", "mention free delivery") and generate again.
4. **Swipe file.** Save the hooks you like. They stay in your browser.

Your brand details are saved in the browser. The form starts with Black Gold Furniture as an example; change them to your own.

## Run it

You need Node.js 20 or newer and a Claude API key from <https://platform.claude.com>.

```bash
cd hook-lab
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # Windows PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."
npm start
```

Open <http://localhost:3000>.

Set `PORT` to use a different port, or `HOOK_LAB_MODEL` to use a different Claude model. The default model is `claude-opus-5-5`.

## Tips for good results

- **Transcribe the first 3 seconds exactly.** The hook is usually the first line plus the first frame.
- **Describe the visuals.** Write what moves, what the first frame shows and any props. Better still, upload 2–4 screenshots from the opening.
- **Add performance numbers** (views, likes). They give Claude context on how well it did.
- **Be specific about your offer.** "Solid mukwa bed frames, delivered in Harare in 7 days" gives far better hooks than "furniture".

## How it works

- `server.js` is a small Express server with two endpoints, `POST /api/analyze` and `POST /api/generate`.
- `lib/hooklab.js` holds the prompts and the JSON schemas for both steps. It uses Claude structured outputs, so responses always match the schema. It also uses server-side refusal fallback (`fallbacks: "default"`): if the main model declines a request, the API retries it on a fallback model.
- `public/index.html` is the whole front end, with no build step.

The app does not download videos from links. Platforms block that, and re-uploading other people's videos causes copyright problems. The link field is only for your reference.

## Tests

```bash
npm test
```

The tests run the server against a mocked Claude API, so they need no API key and cost nothing.
