import { createHash } from "node:crypto";

// Resolve short inventory labels to their company articles, not similarly named places.
const companyTitles = {
  carrier: "Carrier Global",
  lg: "LG Electronics",
  samsung: "Samsung Electronics",
  mitsubishi: "Mitsubishi Electric",
  midea: "Midea Group",
  gree: "Gree Electric",
  tcl: "TCL Technology",
};
const cache = new Map();

async function requestJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "AshcolInventory/1.0 (brand logo lookup)", Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Logo provider returned ${response.status}.`);
  return response.json();
}

// Wikipedia's summary API resolves the company to a Wikidata entity. P154 is
// the logo property, so a headquarters photo cannot accidentally become a logo.
export async function lookupBrandLogo(name, fetchImpl = fetch) {
  const key = name.trim().toLowerCase();
  if (key === "generic parts") return null;
  const title = companyTitles[key] || name.trim();
  const summary = await requestJson(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, fetchImpl,
  );
  const entityId = summary?.wikibase_item;
  if (!/^Q\d+$/.test(entityId || "")) return null;
  const data = await requestJson(
    `https://www.wikidata.org/wiki/Special:EntityData/${entityId}.json`, fetchImpl,
  );
  const claims = (data?.entities?.[entityId]?.claims?.P154 || [])
    .filter((claim) => claim.rank !== "deprecated" && typeof claim.mainsnak?.datavalue?.value === "string")
    .sort((a, b) => Number(b.rank === "preferred") - Number(a.rank === "preferred"));
  const filename = claims[0]?.mainsnak.datavalue.value.replace(/ /g, "_");
  if (!filename) return null;
  const hash = createHash("md5").update(filename).digest("hex");
  return {
    url: `https://upload.wikimedia.org/wikipedia/commons/${hash[0]}/${hash.slice(0, 2)}/${encodeURIComponent(filename)}`,
    sourceUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename)}`,
  };
}

// Cache and share in-flight lookups; failures expire quickly to allow retries.
export function getBrandLogo(name) {
  const key = name.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  const entry = { expires: Date.now() + 86400000 };
  entry.promise = lookupBrandLogo(name).then((logo) => {
    if (!logo) entry.expires = Date.now() + 300000;
    return logo;
  }).catch(() => {
    entry.expires = Date.now() + 60000;
    return null;
  });
  cache.set(key, entry);
  return entry.promise;
}
