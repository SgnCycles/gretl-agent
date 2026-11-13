// Gretl - Stage 1: test the web search (Tavily free tier)
//
// Run from the gretl-agent folder:
//   node scripts/search_test.mjs

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolveScan } from "../agent/taxonomy.mjs";

const apiKey = process.env.TAVILY_API_KEY;
if (!apiKey) {
  console.error("TAVILY_API_KEY is missing. Check your .env file.");
  process.exit(1);
}

// ---- Change these IDs to test other industries/niches from agent/taxonomy.json ----
// const scan = resolveScan({
//   industry_id: "health-wellness",
//   niche_id: "health-wellness-01", // Resolves to "Fitness"
//   geo: ["US"],
// });
const scan = resolveScan({
  industry_id: "igaming-crypto",
  niche_id: "igaming-crypto-01", // Online Casinos
  geo: ["US"],
});
// -----------------------------------------------------------------------------------

const EXCLUDE = [
  "reddit.com",
  "youtube.com",
  "facebook.com",
  "pinterest.com",
  "instagram.com",
  "tiktok.com",
  "quora.com",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildQueries({ industry, niches, geo }) {
  const geoHint = geo.slice(0, 2).join(" ");
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

async function runSearch(query) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: 10,
      exclude_domains: EXCLUDE,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.warn(`  Search failed (${response.status}): ${text.slice(0, 200)}`);
    return [];
  }

  const data = await response.json();
  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

const queries = buildQueries(scan);
console.log(
  `Scan: ${scan.industry} (${scan.industry_id}) | ${scan.niches.join(", ")} (${scan.niche_id}) | ${scan.geo.join(", ")}`
);
console.log(`Running ${queries.length} searches (about ${queries.length} credits)...\n`);

const seen = new Map();
for (const query of queries) {
  const results = await runSearch(query);
  console.log(`"${query}" -> ${results.length} results`);
  for (const result of results) {
    if (!seen.has(result.url)) {
      seen.set(result.url, { ...result, foundBy: query });
    }
  }
  await sleep(1000);
}

const unique = [...seen.values()];
console.log(`\nTotal unique pages: ${unique.length}\n`);

if (unique.length === 0) {
  console.log("No results. Check your TAVILY_API_KEY and the messages above.");
} else {
  unique.slice(0, 15).forEach((r, i) => {
    console.log(`${i + 1}. ${r.title}`);
    console.log(`   ${r.url}`);
  });
  mkdirSync("scripts/output", { recursive: true });
  writeFileSync(
    "scripts/output/search_results.json",
    JSON.stringify({ scan, results: unique }, null, 2)
  );
  console.log("\nAll results saved to scripts/output/search_results.json");
}