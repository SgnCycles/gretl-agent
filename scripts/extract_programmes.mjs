// Gretl - Stage 2: turn raw search results into clean programme rows (Gemini free tier)
//
// Run from the gretl-agent folder:
//   node scripts/extract_programmes.mjs

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { GoogleGenAI, Type } from "@google/genai";
import { resolveScan } from "../agent/taxonomy.mjs";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is missing. Check your .env file.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

// Free-tier models: 3.5 Flash primary, with 3.5 & 3.1 Flash-Lite fallbacks
const MODELS = [
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
  process.env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite",
].filter(Boolean);

// Rules from our extraction design
// const MIN_COMMISSION_PERCENT = 10;
// const MIN_COMMISSION_FIXED_USD = 20;
// const MIN_COOKIE_DAYS = 14;
// const BLOCKED_WORDS = ["casino", "gambling", "betting", "crypto", "forex", "binary options"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generateJson(contents, schema, maxAttempts = 2) {
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`  Calling ${model} (attempt ${attempt})...`);
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            responseMimeType: "application/json",
            responseSchema: schema,
            thinkingConfig: { thinkingLevel: "low" },
          },
        });
        return JSON.parse(response.text);
      } catch (err) {
        const msg = String(err?.message || err);
        const notFound = msg.includes("404") || msg.includes("NOT_FOUND");
        const retryable =
          msg.includes("429") ||
          msg.includes("503") ||
          msg.includes("504") ||
          msg.includes("DEADLINE_EXCEEDED") ||
          msg.includes("UNAVAILABLE") ||
          msg.includes("Timeout") ||
          msg.includes("aborted");

        if (notFound) {
          console.log(`  Model ${model} unavailable, switching to fallback...`);
          break;
        }
        if (!retryable) throw err;

        if (attempt === maxAttempts) {
          console.log(`  Model ${model} busy/timed out, switching to fallback...`);
          break;
        }
        const wait = 8000;
        console.log(`  ${model} busy/timed out, waiting ${wait / 1000}s and retrying...`);
        await sleep(wait);
      }
    }
  }
  throw new Error(`All free-tier Gemini models failed or exhausted quota: ${MODELS.join(", ")}`);
}

async function fetchPageText(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GretlBot/0.1; +https://gretl.app)",
      },
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const html = await response.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 200) return { ok: false, reason: "almost empty" };
    return { ok: true, text: text.slice(0, 6000) };
  } catch (err) {
    return { ok: false, reason: err.name === "TimeoutError" ? "timeout" : err.message };
  }
}

// ---------- Step 1: triage (1 Gemini call) ----------
const rawSearch = JSON.parse(
  readFileSync("scripts/output/search_results.json", "utf8")
);

const scan = rawSearch.scan
  ? rawSearch.scan
  : resolveScan({
      industry_id: "health-wellness",
      niche_id: "health-wellness-01",
      geo: ["US"],
    });

const results = Array.isArray(rawSearch) ? rawSearch : rawSearch.results || [];
console.log(
  `Loaded ${results.length} search results for ${scan.industry} (${scan.industry_id}) / ${scan.niches.join(", ")} (${scan.niche_id}).\n`
);

const triageSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      index: { type: Type.INTEGER },
      is_programme: { type: Type.BOOLEAN },
      brand_name: { type: Type.STRING },
      reason: { type: Type.STRING },
    },
    required: ["index", "is_programme", "brand_name", "reason"],
  },
};

const triageInput = results
  .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`)
  .join("\n\n");

console.log("Step 1: asking Gemini which pages are real affiliate programmes...");
const triage = await generateJson(
  `You are filtering search results for an affiliate marketing digest in "${scan.industry}" (${scan.niches.join(", ")}).
For each numbered result below, decide whether it is an actual brand's online affiliate/referral programme page or network listing (such as on FlexOffers, Sovrn, Impact, ShareASale, CJ) where creators/publishers can earn commissions (is_programme: true).
Set is_programme: false for:
- Blog listicles like "15 best fitness affiliate programs", forums, news articles, or general product pages with no affiliate info
- B2B physical gym/club licensing or franchise programs (e.g. gym studio licensing rather than online affiliate marketing)
If it is a real affiliate programme, set brand_name to the brand's name; otherwise set brand_name to "".

${triageInput}`,
  triageSchema
);

const candidates = triage
  .filter((t) => t.is_programme && results[t.index])
  .map((t) => ({ ...results[t.index], brand_guess: t.brand_name, triage_reason: t.reason }));

console.log(`Kept ${candidates.length} candidate pages out of ${results.length}:\n`);
candidates.forEach((c, i) => console.log(`  ${i + 1}. ${c.brand_guess || c.title} -> ${c.url}`));

// ---------- Step 2: fetch each candidate page & extract details ----------
const extractSchema = {
  type: Type.OBJECT,
  properties: {
    brand_name: { type: Type.STRING },
    programme_name: { type: Type.STRING },
    website: { type: Type.STRING },
    signup_link: { type: Type.STRING },
    commission_text: { type: Type.STRING },
    commission_percent: { type: Type.NUMBER, nullable: true },
    commission_fixed_usd: { type: Type.NUMBER, nullable: true },
    cookie_days: { type: Type.INTEGER, nullable: true },
    network: { type: Type.STRING },
    payment_terms: { type: Type.STRING },
    geo_availability: { type: Type.STRING },
    requirements: { type: Type.STRING },
    application_process: { type: Type.STRING },
    description: { type: Type.STRING },
    category: { type: Type.STRING },
  },
  required: [
    "brand_name",
    "programme_name",
    "website",
    "signup_link",
    "commission_text",
    "network",
    "payment_terms",
    "geo_availability",
    "requirements",
    "application_process",
    "description",
    "category",
  ],
};

console.log("\nStep 2: fetching each candidate page and extracting fields...\n");
const extracted = [];

for (const c of candidates) {
  process.stdout.write(`  Fetching ${c.url} ... `);
  const page = await fetchPageText(c.url);
  const body = page.ok ? page.text : `(Page could not be fetched: ${page.reason}. Use only the title and snippet.)`;
  console.log(page.ok ? `${page.text.length} chars` : `fallback (${page.reason})`);

  const record = await generateJson(
    `Extract structured affiliate programme facts from the page below.
Rules:
- Only use facts stated in the title, snippet, or page text. Never invent numbers.
- If a text field is not stated, return "".
- If a number field (commission_percent, commission_fixed_usd, cookie_days) is not stated, return null.
- For signup_link, use the direct application URL if shown, otherwise "${c.url}".
- For website, use the brand's main homepage URL (e.g. "https://example.com"). If the page is an affiliate network directory listing (like FlexOffers, Sovrn, CJ, Impact) and the brand's homepage URL isn't printed, use "${c.url}" so website is not empty.
- Keep description to 1-2 short factual sentences.

Search title: ${c.title}
Search URL: ${c.url}
Search snippet: ${c.snippet}
Brand hint: ${c.brand_guess}

Page text:
${body}`,
    extractSchema
  );

  extracted.push({ ...record, source_link: c.url });
  await sleep(4500);
}

// ---------- Step 3: apply our rules (keep vs skip) ----------
function applyRules(p) {
  const missing = [];
  if (!p.brand_name) missing.push("brand_name");
  if (!p.website) missing.push("website");
  if (!p.signup_link) missing.push("signup_link");
  if (!p.commission_text) missing.push("commission");

  const skipReason = missing.length ? `missing: ${missing.join(", ")}` : null;

  return {
    ...p,
    industry_id: scan.industry_id,
    niche_id: scan.niche_id,
    missing_fields: missing,
    decision: skipReason ? "skip" : "keep",
    skip_reason: skipReason,
  };
}

const evaluated = extracted.map(applyRules);
const kept = evaluated.filter((p) => p.decision === "keep");
const skipped = evaluated.filter((p) => p.decision === "skip");

console.log(`\n========== RESULT: ${kept.length} kept, ${skipped.length} skipped ==========\n`);
for (const p of kept) {
  console.log(`KEEP: ${p.brand_name} (${p.programme_name || "Affiliate Programme"})`);
  console.log(`  Commission : ${p.commission_text}`);
  console.log(`  Cookie     : ${p.cookie_days !== null ? p.cookie_days + " days" : "not stated"}`);
  console.log(`  Network    : ${p.network || "not stated"}`);
  console.log(`  Geo        : ${p.geo_availability || "not stated"}`);
  console.log(`  Signup     : ${p.signup_link}\n`);
}
for (const p of skipped) {
  console.log(`SKIP: ${p.brand_name || p.source_link} -> ${p.skip_reason}`);
}

writeFileSync("scripts/output/programmes.json", JSON.stringify(evaluated, null, 2));
console.log("\nFull output saved to scripts/output/programmes.json");