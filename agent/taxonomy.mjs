import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const INDUSTRIES = JSON.parse(
  readFileSync(join(__dirname, "taxonomy.json"), "utf8")
);

export function getIndustry(id) {
  return INDUSTRIES.find((i) => i.id === id);
}

export function getNiche(industryId, nicheId) {
  return getIndustry(industryId)?.niches.find((n) => n.id === nicheId);
}

/**
 * Resolves a scan/subscription object containing { industry_id, niche_id, industries, niches, geo }
 * into verified labels from taxonomy.json.
 */
export function resolveScan(input) {
  const {
    industry_id,
    niche_id,
    industries = [],
    niches = [],
    geo = [],
  } = input;

  if (industry_id && niche_id) {
    const ind = getIndustry(industry_id);
    if (!ind) throw new Error(`Unknown industry_id: "${industry_id}"`);

    const niche = getNiche(industry_id, niche_id);
    if (!niche) {
      throw new Error(
        `Unknown niche_id "${niche_id}" for industry "${industry_id}"`
      );
    }

    const industryLabel = ind.isCustom ? industries[0] || "" : ind.label;
    const nicheLabel = niche.isCustom ? niches[0] || "" : niche.label;

    if (!industryLabel || !nicheLabel) {
      throw new Error(
        `Custom industry/niche selected (${industry_id}/${niche_id}) but custom label is empty.`
      );
    }

    return {
      industry_id: ind.id,
      industry: industryLabel,
      niche_id: niche.id,
      niches: [nicheLabel],
      geo,
    };
  }

  // Fallback for legacy scans without IDs
  return {
    industry_id: null,
    industry: industries[0] || "",
    niche_id: null,
    niches,
    geo,
  };
}