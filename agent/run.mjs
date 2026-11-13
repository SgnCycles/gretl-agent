// Gretl - Production Agent Runner (SOUL.md Compliant)
// Reads active subscriptions from Supabase, discovers & re-checks affiliate programmes,
// applies SOUL.md rules (ranking, 15-item cap, Skipped/Returned/Unchanged memory),
// saves the report to Supabase `reports`, and emails via Gmail SMTP if configured.
//
// Run from the gretl-agent folder:
//   node agent/run.mjs

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { GoogleGenAI, Type } from "@google/genai";
import { resolveScan } from "./taxonomy.mjs";
import nodemailer from "nodemailer";

// 1. Check required keys
const tavilyKey = process.env.TAVILY_API_KEY;
const geminiKey = process.env.GEMINI_API_KEY;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const gmailUser = process.env.GMAIL_USER || "";
const gmailAppPassword = process.env.GMAIL_APP_PASSWORD || "";

if (!tavilyKey || !geminiKey || !supabaseUrl || !supabaseServiceKey) {
  console.error(
    "Missing required keys in .env: TAVILY_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey);
const ai = new GoogleGenAI({ apiKey: geminiKey });

const MODELS = [
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
  process.env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite",
].filter(Boolean);

const EXCLUDE_DOMAINS = [
  "reddit.com",
  "youtube.com",
  "facebook.com",
  "pinterest.com",
  "instagram.com",
  "tiktok.com",
  "quora.com",
];

const MAX_REPORT_ITEMS = 15;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const todayISO = () => new Date().toISOString().slice(0, 10);

// Monday of the current week (YYYY-MM-DD) for reports.week_start
function getWeekStartISO() {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff));
  return monday.toISOString().slice(0, 10);
}

// ---------- Helper: Call Gemini with fallback & retry ----------
async function generateJson(contents, schema, maxAttempts = 2) {
  for (const model of MODELS) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`    Calling ${model} (attempt ${attempt})...`);
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
          console.log(`    Model ${model} unavailable, switching to fallback...`);
          break;
        }
        if (!retryable) throw err;

        if (attempt === maxAttempts) {
          console.log(`    Model ${model} busy/timed out, switching to fallback...`);
          break;
        }
        console.log(`    ${model} busy/timed out, waiting 8s and retrying...`);
        await sleep(8000);
      }
    }
  }
  throw new Error(`All Gemini models failed: ${MODELS.join(", ")}`);
}

// ---------- Helper: Build Tavily search queries ----------
function buildQueries({ industry, niches, geo }) {
  const geoHint = (geo || ["Global"]).slice(0, 2).join(" ");
  const queries = [];
  for (const niche of niches) {
    queries.push(`${niche} affiliate program commission rate cookie duration`);
    queries.push(`${niche} become an affiliate apply`);
    queries.push(`${niche} app OR online program affiliate program`);
    queries.push(`${niche} brand partner affiliate program`);
    queries.push(`site:flexoffers.com OR site:merchants.sovrn.com ${niche} affiliate program`);
  }
  queries.push(`${industry} affiliate programs ${geoHint}`);
  queries.push(`${industry} best affiliate programs high commission ${geoHint}`);
  return queries;
}

// ---------- Helper: Search Tavily ----------
async function runSearch(query) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tavilyKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: 10,
      exclude_domains: EXCLUDE_DOMAINS,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.warn(`    Search failed (${response.status}): ${text.slice(0, 150)}`);
    return { ok: false, results: [] };
  }

  const data = await response.json();
  return {
    ok: true,
    results: (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
    })),
  };
}

// ---------- Helper: Fetch webpage text ----------
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

// ---------- Schemas for Gemini ----------
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

const extractSchema = {
  type: Type.OBJECT,
  properties: {
    brand_name: { type: Type.STRING },
    programme_name: { type: Type.STRING },
    website: { type: Type.STRING },
    signup_link: { type: Type.STRING },
    contact_status: {
      type: Type.STRING,
      description: 'Must be exactly one of: "Apply online", "Private contact required", or "Not found"',
    },
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
    "contact_status",
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

// ---------- SOUL.md Rule Helpers ----------
function cleanVal(val, fallback = "Not found") {
  if (!val || typeof val !== "string") return fallback;
  const trimmed = val.trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown" || trimmed.toLowerCase() === "n/a") {
    return fallback;
  }
  return trimmed;
}

function normalizeContactStatus(raw, signupLink) {
  const s = (raw || "").toLowerCase();
  if (s.includes("private")) return "Private contact required";
  if (s.includes("apply") || (signupLink && signupLink.startsWith("http"))) {
    return "Apply online";
  }
  return "Not found";
}

// SOUL.md Rule 4: Skip programmes with too much missing information
function checkRule4Qualifies(rec) {
  const hasName = Boolean(rec.programme_name && rec.programme_name !== "Not found");
  const hasContact =
    rec.contact_status === "Apply online" || rec.contact_status === "Private contact required";

  // Count how many of the 8 details are filled in
  const details = [
    rec.network,
    rec.commission_text,
    rec.cookie_days !== null && rec.cookie_days !== undefined ? `${rec.cookie_days} days` : "Not found",
    rec.payment_terms,
    rec.requirements,
    rec.description,
    rec.application_process,
    rec.geo_availability,
  ];
  const filledCount = details.filter((d) => d && d !== "Not found").length;

  return {
    qualifies: hasName && hasContact && filledCount >= 3,
    filledCount,
  };
}

// SOUL.md Rule 6: Compare the 4 tracked fields for Returned status
const CONTACT_RANK = {
  "Not found": 0,
  "Private contact required": 1,
  "Apply online": 2,
};

function detectChanges(oldRow, newRec) {
  const changes = [];

  if (oldRow.status === "Skipped") {
    changes.push("Now has enough information");
    return changes;
  }

  const oldComm = cleanVal(oldRow.commission_text);
  const newComm = cleanVal(newRec.commission_text);
  if (oldComm !== newComm && newComm !== "Not found") {
    changes.push(`Commission changed (${oldComm} -> ${newComm})`);
  }

  if (
    newRec.cookie_days !== null &&
    newRec.cookie_days !== undefined &&
    oldRow.cookie_days !== newRec.cookie_days
  ) {
    changes.push(
      `Cookie changed (${oldRow.cookie_days ?? "Not found"}d -> ${newRec.cookie_days}d)`
    );
  }

  const oldRank = CONTACT_RANK[oldRow.contact_status] ?? 0;
  const newRank = CONTACT_RANK[newRec.contact_status] ?? 0;
  if (newRank > oldRank) {
    changes.push(`Contact improved to ${newRec.contact_status}`);
  }

  const oldLink = cleanVal(oldRow.signup_link);
  const newLink = cleanVal(newRec.signup_link);
  if (oldLink !== newLink && newLink !== "Not found") {
    changes.push("Signup link updated");
  }

  return changes;
}

// SOUL.md Rule 5: Rank highest commission % -> highest fixed USD -> unspecified -> longest cookie
function rankProgrammes(list) {
  return [...list].sort((a, b) => {
    const aPct = typeof a.commission_percent === "number" ? a.commission_percent : -1;
    const bPct = typeof b.commission_percent === "number" ? b.commission_percent : -1;
    if (aPct !== bPct) return bPct - aPct;

    const aFix = typeof a.commission_fixed === "number" ? a.commission_fixed : -1;
    const bFix = typeof b.commission_fixed === "number" ? b.commission_fixed : -1;
    if (aFix !== bFix) return bFix - aFix;

    const aCookie = typeof a.cookie_days === "number" ? a.cookie_days : -1;
    const bCookie = typeof b.cookie_days === "number" ? b.cookie_days : -1;
    return bCookie - aCookie;
  });
}

// ---------- Build SOUL.md Email HTML ----------
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildEmailHtml(subName, rankedItems, hadFailedSources) {
  if (rankedItems.length === 0) {
    const failureLine = hadFailedSources
      ? `<p style="color:#666;font-size:13px;margin-top:16px;">Note: One or more sources could not be reached during this scan.</p>`
      : "";
    return `
      <div style="font-family:sans-serif;color:#1a1a1a;max-width:720px;margin:0 auto;line-height:1.5;">
        <p><strong>${escapeHtml(subName)}</strong></p>
        <p>No new opportunities this week.</p>
        ${failureLine}
      </div>
    `;
  }

  const rowsHtml = rankedItems
    .map((p, idx) => {
      const cookieStr = p.cookie_days ? `${p.cookie_days} days` : "Not found";
      const howToApply =
        p.contact_status === "Apply online" && p.signup_link && p.signup_link !== "Not found"
          ? `<a href="${escapeHtml(p.signup_link)}">Apply online</a>`
          : escapeHtml(p.application_process || p.contact_status);
      const statusLabel =
        p.status === "Returned" && p.change_note
          ? `Returned: ${escapeHtml(p.change_note)}`
          : escapeHtml(p.status);

      return `
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;">${idx + 1}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;"><strong>${escapeHtml(p.brand_name)}</strong></td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(p.commission_text)}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(cookieStr)}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(p.payment_terms)}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${escapeHtml(p.requirements)}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${howToApply}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${statusLabel}</td>
        </tr>
      `;
    })
    .join("");

  const summariesHtml = rankedItems
    .map((p, idx) => {
      const links = (p.source_links || [])
        .map((u) => `<a href="${escapeHtml(u)}">${escapeHtml(u)}</a>`)
        .join(", ");
      return `
        <p style="margin:6px 0;font-size:14px;">
          <strong>${idx + 1}. ${escapeHtml(p.brand_name)}:</strong> ${escapeHtml(p.description)}
          <span style="color:#555;">(Source: ${links})</span>
        </p>
      `;
    })
    .join("");

  const failureLine = hadFailedSources
    ? `<p style="color:#666;font-size:13px;margin-top:20px;">Note: One or more sources could not be reached during this scan.</p>`
    : "";

  return `
    <div style="font-family:sans-serif;color:#1a1a1a;max-width:900px;margin:0 auto;line-height:1.5;">
      <p>Here are ${rankedItems.length} affiliate programme ${rankedItems.length === 1 ? "opportunity" : "opportunities"} for <strong>${escapeHtml(subName)}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;">
        <thead>
          <tr style="background:#f9fafb;text-align:left;">
            <th style="padding:8px;border:1px solid #e5e7eb;">#</th>
            <th style="padding:8px;border:1px solid #e5e7eb;">Brand</th>
            <th style="padding:8px;border:1px solid #e5e7eb;">Commission</th>
            <th style="padding:8px;border:1px solid #e5e7eb;">Cookie</th>
            <th style="padding:8px;border:1px solid #e5e7eb;">Payment terms</th>
            <th style="padding:8px;border:1px solid #e5e7eb;">Requirements</th>
            <th style="padding:8px;border:1px solid #e5e7eb;">How to apply</th>
            <th style="padding:8px;border:1px solid #e5e7eb;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
      <div style="margin-top:16px;">
        ${summariesHtml}
      </div>
      ${failureLine}
    </div>
  `;
}

// ---------- Send Email via Gmail SMTP ----------
async function sendGmailEmail(toEmail, subject, html) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: gmailUser,
      pass: gmailAppPassword,
    },
  });

  await transporter.sendMail({
    from: `Gretl <${gmailUser}>`,
    to: toEmail,
    subject,
    html,
  });
}

// ---------- Main Subscription Processor ----------
async function processSubscription(sub) {
  const today = todayISO();
  const weekStart = getWeekStartISO();
  const subLabel = sub.name || "Affiliate Digest";
  let hadFailedSources = false;

  const scan = resolveScan({
    industry_id: sub.industry_id,
    niche_id: sub.niche_id || (Array.isArray(sub.niche_ids) ? sub.niche_ids[0] : null),
    niche_ids: sub.niche_ids,
    niches: sub.niches,
    geo: Array.isArray(sub.geo) && sub.geo.length > 0 ? sub.geo : ["Global"],
  });

  console.log(`\n==================================================`);
  console.log(`Subscription: "${subLabel}" (User: ${sub.user_id})`);
  console.log(`Target: ${scan.industry} | ${scan.niches.join(", ")} | Geo: ${scan.geo.join(", ")}`);
  console.log(`==================================================`);

  // 1. Load existing memory from programmes_seen
  const { data: existingRows, error: existingErr } = await supabase
    .from("programmes_seen")
    .select("*")
    .eq("subscription_id", sub.id);

  if (existingErr) {
    console.error(`  Failed to load programmes_seen: ${existingErr.message}`);
    return;
  }

  const seenUrls = new Set();
  const seenByBrand = new Map();
  const skippedToRecheck = [];

  for (const row of existingRows || []) {
    if (row.status === "Skipped") {
      // Rule 6: Save Skipped rows so we can re-check them on future scans
      const recheckUrl =
        (Array.isArray(row.source_links) && row.source_links[0]) || row.signup_link || row.website;
      if (recheckUrl && recheckUrl.startsWith("http")) {
        skippedToRecheck.push({
          url: recheckUrl,
          title: row.programme_name || row.brand_name,
          snippet: row.description || "",
          brand_guess: row.brand_name,
          existingRow: row,
        });
      }
    } else {
      if (row.website) seenUrls.add(row.website.toLowerCase());
      if (row.signup_link) seenUrls.add(row.signup_link.toLowerCase());
      if (Array.isArray(row.source_links)) {
        row.source_links.forEach((u) => seenUrls.add(u.toLowerCase()));
      }
    }
    if (row.brand_name) {
      seenByBrand.set(row.brand_name.trim().toLowerCase(), row);
    }
  }

  console.log(
    `  Memory: ${existingRows?.length || 0} total (${skippedToRecheck.length} Skipped leads queued for re-check).`
  );

  // 2. Run Tavily searches
  const queries = buildQueries(scan);
  console.log(`  Running ${queries.length} Tavily searches...`);
  const foundPages = new Map();

  for (const query of queries) {
    const searchRes = await runSearch(query);
    if (!searchRes.ok) hadFailedSources = true;
    for (const r of searchRes.results) {
      if (!foundPages.has(r.url)) {
        foundPages.set(r.url, r);
      }
    }
    await sleep(1000);
  }

  const freshResults = [...foundPages.values()].filter(
    (r) => !seenUrls.has(r.url.toLowerCase())
  );
  console.log(`  Found ${foundPages.size} unique pages (${freshResults.length} new URLs).`);

  // 3. Gemini Triage on fresh URLs
  let newCandidates = [];
  if (freshResults.length > 0) {
    const triageInput = freshResults
      .map((r, i) => `[${i}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`)
      .join("\n\n");

    console.log("  Asking Gemini which pages are real affiliate programmes...");
    const triage = await generateJson(
      `You are filtering search results for an affiliate marketing digest in "${scan.industry}" (${scan.niches.join(", ")}).
User's chosen geo locations: ${scan.geo.join(", ")}.
For each numbered result below, decide whether it is an actual brand's online affiliate/referral programme page or network listing (such as on FlexOffers, Sovrn, Impact, ShareASale, CJ) where creators/publishers can earn commissions (is_programme: true).
Set is_programme: false for:
- Blog listicles like "15 best affiliate programs", forums, news articles, or general product pages with no affiliate info
- Programmes that explicitly exclude all of the user's chosen geo locations (${scan.geo.join(", ")})
If it is a real affiliate programme, set brand_name to the brand's name; otherwise set brand_name to "".

${triageInput}`,
      triageSchema
    );

    newCandidates = triage
      .filter((t) => t.is_programme && freshResults[t.index])
      .map((t) => ({ ...freshResults[t.index], brand_guess: t.brand_name }));
  }

  // Combine previously Skipped leads (to re-check) + newly discovered candidates
  const allCandidates = [...skippedToRecheck, ...newCandidates];
  console.log(
    `  Processing ${allCandidates.length} candidates (${skippedToRecheck.length} re-checks + ${newCandidates.length} new)...`
  );

  const reportCandidates = []; // Holds New + Returned programmes eligible for the report
  let skippedSavedCount = 0;
  let unchangedCount = 0;

  // 4. Extract & evaluate each candidate
  for (const c of allCandidates) {
    process.stdout.write(`  Fetching ${c.url} ... `);
    const page = await fetchPageText(c.url);
    if (!page.ok) hadFailedSources = true;
    const body = page.ok
      ? page.text
      : `(Page could not be fetched: ${page.reason}. Use only the title and snippet.)`;
    console.log(page.ok ? `${page.text.length} chars` : `fallback (${page.reason})`);

    const raw = await generateJson(
      `Extract structured affiliate programme facts from the page below.
Strict SOUL.md Rules:
- Never invent information. If a text detail is not stated, return "Not found".
- If a number field (commission_percent, commission_fixed_usd, cookie_days) is not stated, return null.
- contact_status MUST be one of: "Apply online", "Private contact required", or "Not found".
- If direct contact is required, explain what to ask for in application_process.
- For signup_link, use the direct application URL if shown, otherwise "${c.url}" if an online signup exists, or "Not found" if none.
- For website, use the brand's main homepage URL (e.g. "https://example.com"). If it is a network listing and homepage isn't shown, use "${c.url}".
- Keep description to 1 short factual sentence with zero hype.

User's target geo locations: ${scan.geo.join(", ")}
Search title: ${c.title}
Search URL: ${c.url}
Search snippet: ${c.snippet}
Brand hint: ${c.brand_guess}

Page text:
${body}`,
      extractSchema
    );

    const brandName = cleanVal(raw.brand_name, cleanVal(c.brand_guess, "Not found"));
    if (brandName === "Not found") {
      console.log(`    SKIP (no brand name identified): ${c.url}`);
      await sleep(4500);
      continue;
    }

    const signupLink = cleanVal(raw.signup_link);
    const contactStatus = normalizeContactStatus(raw.contact_status, signupLink);

    const normalized = {
      brand_name: brandName,
      website: cleanVal(raw.website, c.url),
      programme_name: cleanVal(raw.programme_name, `${brandName} Affiliate Programme`),
      signup_link: signupLink,
      network: cleanVal(raw.network),
      category: cleanVal(raw.category, scan.niches[0] || scan.industry),
      commission_text: cleanVal(raw.commission_text),
      commission_percent: typeof raw.commission_percent === "number" ? raw.commission_percent : null,
      commission_fixed: typeof raw.commission_fixed_usd === "number" ? raw.commission_fixed_usd : null,
      cookie_days: typeof raw.cookie_days === "number" ? raw.cookie_days : null,
      payment_terms: cleanVal(raw.payment_terms),
      requirements: cleanVal(raw.requirements),
      description: cleanVal(raw.description),
      application_process: cleanVal(raw.application_process),
      geo_availability: cleanVal(raw.geo_availability),
      contact_status: contactStatus,
      source_links: [c.url],
    };

    const { qualifies, filledCount } = checkRule4Qualifies(normalized);
    const brandKey = brandName.toLowerCase();
    const existingRow = c.existingRow || seenByBrand.get(brandKey);

    // Case A: Fails Rule 4 -> Save/Update as "Skipped" so we re-check next week
    if (!qualifies) {
      if (existingRow) {
        await supabase
          .from("programmes_seen")
          .update({
            ...normalized,
            status: "Skipped",
            last_seen: today,
          })
          .eq("id", existingRow.id);
      } else {
        const { data: insSkipped } = await supabase
          .from("programmes_seen")
          .insert({
            user_id: sub.user_id,
            subscription_id: sub.id,
            ...normalized,
            status: "Skipped",
            change_note: null,
            first_seen: today,
            last_seen: today,
          })
          .select("*")
          .single();
        if (insSkipped) seenByBrand.set(brandKey, insSkipped);
      }
      console.log(`    SAVED AS SKIPPED (re-check next week): ${brandName} (${filledCount}/8 fields)`);
      skippedSavedCount++;
      await sleep(4500);
      continue;
    }

    // Case B: Passes Rule 4 and already existed in memory
    if (existingRow) {
      const changes = detectChanges(existingRow, normalized);
      if (changes.length > 0) {
        const changeNote = changes.join("; ");
        const { data: updatedRow } = await supabase
          .from("programmes_seen")
          .update({
            ...normalized,
            status: "Returned",
            change_note: changeNote,
            last_seen: today,
          })
          .eq("id", existingRow.id)
          .select("*")
          .single();

        console.log(`    RETURNED: ${brandName} (${changeNote})`);
        if (updatedRow) reportCandidates.push(updatedRow);
      } else {
        // Rule 6: Quietly update description/requirements, keep status Unchanged
        await supabase
          .from("programmes_seen")
          .update({
            requirements: normalized.requirements,
            description: normalized.description,
            status: "Unchanged",
            last_seen: today,
          })
          .eq("id", existingRow.id);

        console.log(`    UNCHANGED: ${brandName}`);
        unchangedCount++;
      }
    } else {
      // Case C: Passes Rule 4 and is brand new!
      const { data: insertedRow, error: insErr } = await supabase
        .from("programmes_seen")
        .insert({
          user_id: sub.user_id,
          subscription_id: sub.id,
          ...normalized,
          status: "New",
          change_note: null,
          first_seen: today,
          last_seen: today,
        })
        .select("*")
        .single();

      if (insErr) {
        console.error(`    Failed to insert ${brandName}: ${insErr.message}`);
      } else {
        console.log(`    NEW CANDIDATE: ${brandName} (${normalized.commission_text})`);
        seenByBrand.set(brandKey, insertedRow);
        reportCandidates.push(insertedRow);
      }
    }

    await sleep(4500);
  }

  // 5. Rank candidates (Rule 5) and cap at 15 opportunities (Rule 7)
  const rankedReportItems = rankProgrammes(reportCandidates).slice(0, MAX_REPORT_ITEMS);

  // Mark last_sent = today for the items included in this report
  if (rankedReportItems.length > 0) {
    const sentIds = rankedReportItems.map((r) => r.id);
    await supabase
      .from("programmes_seen")
      .update({ last_sent: today })
      .in("id", sentIds);
  }
// 6. Save (or update) report in `reports` table BEFORE emailing (Definition of Done #9)
  const emailHtml = buildEmailHtml(subLabel, rankedReportItems, hadFailedSources);
  const { data: savedReport, error: repErr } = await supabase
    .from("reports")
    .upsert(
      {
        user_id: sub.user_id,
        subscription_id: sub.id,
        week_start: weekStart,
        content: {
          subscription_name: subLabel,
          geo: scan.geo,
          count: rankedReportItems.length,
          programmes: rankedReportItems,
        },
        email_html: emailHtml,
        sent: false,
        sent_at: null,
      },
      { onConflict: "subscription_id,week_start" }
    )
    .select("id")
    .single();

  if (repErr) {
    console.error(`  Failed to save report to Supabase: ${repErr.message}`);
    return;
  }
  console.log(`  Report saved to Supabase (ID: ${savedReport.id}) with ${rankedReportItems.length} item(s).`);

  // 7. Send email via Gmail SMTP if configured
  if (gmailUser && gmailAppPassword) {
    const { data: authData, error: authErr } = await supabase.auth.admin.getUserById(sub.user_id);
    const userEmail = authData?.user?.email;

    if (authErr || !userEmail) {
      console.warn(`  Could not find email for user ${sub.user_id}: ${authErr?.message || "no email"}`);
    } else {
      try {
        const subject =
          rankedReportItems.length > 0
            ? `Gretl: ${rankedReportItems.length} affiliate ${rankedReportItems.length === 1 ? "programme" : "programmes"} for ${subLabel}`
            : `Gretl: No new opportunities this week (${subLabel})`;

        await sendGmailEmail(userEmail, subject, emailHtml);
        await supabase
          .from("reports")
          .update({ sent: true, sent_at: new Date().toISOString() })
          .eq("id", savedReport.id);

        console.log(`  Email sent to ${userEmail}!`);
      } catch (emailErr) {
        console.error(`  Email send failed: ${emailErr.message}`);
      }
    }
  } else {
    console.log("  GMAIL_USER / GMAIL_APP_PASSWORD not set yet — report saved in Supabase, skipping email send.");
  }

  console.log(
    `\nSummary for "${subLabel}": ${rankedReportItems.length} in report (capped at 15), ${skippedSavedCount} saved as Skipped to re-check later, ${unchangedCount} Unchanged.`
  );
}

// ---------- Entry Point ----------
async function main() {
  console.log("Starting Gretl Agent...");

  const { data: subscriptions, error } = await supabase
    .from("subscriptions")
    .select("*")
    .eq("active", true);

  if (error) {
    console.error("Error reading subscriptions from Supabase:", error.message);
    process.exit(1);
  }

  if (!subscriptions || subscriptions.length === 0) {
    console.log("No active subscriptions found in Supabase.");
    return;
  }

  console.log(`Found ${subscriptions.length} active subscription(s).`);

  for (const sub of subscriptions) {
    await processSubscription(sub);
  }

  console.log("\nAll active subscriptions processed!");
}

main();