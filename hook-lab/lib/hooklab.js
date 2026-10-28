import { z } from "zod";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

export const MODEL = process.env.HOOK_LAB_MODEL || "claude-opus-5-5";

// ---------- Schemas ----------

export const AnalysisSchema = z.object({
  hook_summary: z.string().describe("One sentence: what happens in the first 1-3 seconds"),
  video_format: z.string().describe("e.g. talking head, POV, before/after, street interview, product demo"),
  hook_types: z
    .array(z.string())
    .describe("Named hook archetypes used, e.g. Curiosity Gap, Contrarian, Negative Hook, Result-First, POV, Challenge, Secret Reveal, Mistake Callout, Price Shock, Transformation"),
  psychological_triggers: z.array(
    z.object({
      trigger: z.string().describe("e.g. curiosity, fear of missing out, social proof, identity, pattern interrupt, loss aversion"),
      how_it_is_used: z.string(),
    }),
  ),
  elements: z.object({
    spoken: z.string().describe("What is said and how (delivery, word choice)"),
    on_screen_text: z.string().describe("Text overlays and why they work"),
    visual: z.string().describe("Opening frame, motion, framing, props"),
    audio: z.string().describe("Music, sound effects, voice energy"),
    pacing: z.string().describe("Cut speed, how fast the point lands"),
  }),
  structure_template: z
    .string()
    .describe("The hook rewritten as a reusable fill-in-the-blank template with [SLOT_NAMES] in square brackets"),
  slots: z.array(
    z.object({
      slot: z.string().describe("Slot name exactly as in the template, without brackets"),
      role: z.string().describe("What job this slot does in the hook"),
      original_value: z.string().describe("What the original video put here"),
    }),
  ),
  open_loop: z.string().describe("The question the viewer needs answered, and when/if it gets paid off"),
  why_it_works: z.string(),
  strength_score: z.number().describe("1-10 rating of hook strength"),
  do_not_copy: z.string().describe("Parts that are specific to the original creator and should NOT be copied (wording, catchphrases, likeness)"),
});

export const GenerationSchema = z.object({
  hooks: z.array(
    z.object({
      title: z.string().describe("Short internal name for this hook idea"),
      spoken_line: z.string().describe("Exactly what to say in the first 3 seconds"),
      on_screen_text: z.string().describe("Text overlay for the first frame"),
      opening_visual: z.string().describe("What the camera shows in the first frame"),
      shot_list: z.array(z.string()).describe("2-5 quick shots for the first ~5 seconds"),
      template_fill: z.array(
        z.object({
          slot: z.string(),
          value: z.string(),
        }),
      ),
      principles_borrowed: z.array(z.string()),
      payoff: z.string().describe("How the rest of the video delivers on the hook's promise"),
      why_it_should_work: z.string(),
      strength_score: z.number().describe("1-10 predicted hook strength"),
    }),
  ),
  filming_tips: z.array(z.string()),
});

// ---------- Prompts ----------

const ANALYST_SYSTEM = `You are a short-form video strategist who reverse-engineers why viral hooks work on TikTok, Instagram Reels, YouTube Shorts and Facebook Reels.

Break a hook down into transferable principles: the archetype, the psychological triggers, the spoken / on-screen / visual / audio elements, the pacing, and a reusable fill-in-the-blank template. Be concrete and specific to the material you are given; do not pad with generic advice. If the information is thin, analyse what is there and say what is missing.`;

const WRITER_SYSTEM = `You are a short-form video hook writer. You take the structure and psychology of a proven viral hook and apply it to a different business, so the new hook earns attention for the same reasons without copying the original's wording, catchphrases, or identity.

Rules:
- Keep the structure and triggers; change the words, subject, and visuals to fit the brand.
- Every hook must be filmable by a small business with a phone.
- The hook must make a promise the rest of the video can honestly keep. No fake claims, fake prices, or bait the business cannot deliver.
- Write the spoken line the way people actually talk. Short. Under ~15 words when possible.
- Make the hooks meaningfully different from each other (different angles: price, quality, story, mistake, transformation, local pride, etc.).
- Use the local context of the audience (places, currency, everyday situations) when it is given.`;

function describeOriginal(original) {
  const parts = [];
  if (original.platform) parts.push(`Platform: ${original.platform}`);
  if (original.url) parts.push(`Link (for reference only, not fetched): ${original.url}`);
  if (original.performance) parts.push(`Performance: ${original.performance}`);
  if (original.spoken) parts.push(`Spoken words in the first seconds:\n${original.spoken}`);
  if (original.onScreenText) parts.push(`On-screen text:\n${original.onScreenText}`);
  if (original.visual) parts.push(`What is on screen / what happens:\n${original.visual}`);
  if (original.notes) parts.push(`Extra notes:\n${original.notes}`);
  return parts.join("\n\n");
}

function describeBrand(brand) {
  const rows = [
    ["Business", brand.name],
    ["Niche / industry", brand.niche],
    ["Product or offer to feature", brand.offer],
    ["Target audience", brand.audience],
    ["Location / market", brand.location],
    ["Tone of voice", brand.tone],
    ["Goal of the video", brand.goal],
    ["Platform", brand.platform],
  ];
  return rows
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

// Images arrive from the browser as data URLs; convert them to image blocks.
function imageBlocks(images = []) {
  const blocks = [];
  for (const dataUrl of images.slice(0, 6)) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(dataUrl);
    if (!match) continue;
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: match[1], data: match[2] },
    });
  }
  return blocks;
}

// ---------- Claude calls ----------

async function callStructured(client, { system, content, schema, effort }) {
  // create() rather than parse(): parse() validates before we can see a refusal.
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system,
    output_config: { effort, format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content }],
  });

  if (response.stop_reason === "refusal") {
    throw new HookLabError("Claude declined this request. Try rephrasing the hook description.", 422);
  }
  if (response.stop_reason === "max_tokens") {
    throw new HookLabError("The response was cut off. Try asking for fewer hooks.", 502);
  }
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  let parsed;
  try {
    parsed = schema.safeParse(JSON.parse(text));
  } catch {
    parsed = { success: false };
  }
  if (!parsed.success) {
    throw new HookLabError("Claude returned a response that could not be parsed. Please try again.", 502);
  }
  return parsed.data;
}

export class HookLabError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function analyzeHook(client, original) {
  const text = describeOriginal(original);
  const images = imageBlocks(original.images);
  if (!text && images.length === 0) {
    throw new HookLabError("Describe the viral hook (spoken words, on-screen text, or visuals) or upload a screenshot.");
  }
  return callStructured(client, {
    system: ANALYST_SYSTEM,
    effort: "medium",
    schema: AnalysisSchema,
    content: [
      ...images,
      {
        type: "text",
        text: `Analyse this viral video hook.${images.length ? " The images are screenshots from the opening seconds." : ""}\n\n${text}`,
      },
    ],
  });
}

export async function generateHooks(client, { analysis, brand, count = 5, feedback = "" }) {
  if (!analysis) throw new HookLabError("Analyse a hook first.");
  const brandText = describeBrand(brand || {});
  if (!brandText) throw new HookLabError("Tell us about your business so the hooks fit it.");
  const n = Math.min(Math.max(Number(count) || 5, 1), 10);

  let prompt = `Here is the breakdown of a viral hook:\n\n${JSON.stringify(analysis, null, 2)}\n\nHere is the business we are writing for:\n\n${brandText}\n\nWrite ${n} original hooks for this business that use the same structure template and psychological triggers. Fill every slot in the template for each hook.`;
  if (feedback && feedback.trim()) {
    prompt += `\n\nFeedback on the previous batch, apply it:\n${feedback.trim()}`;
  }

  return callStructured(client, {
    system: WRITER_SYSTEM,
    effort: "high",
    schema: GenerationSchema,
    content: prompt,
  });
}
