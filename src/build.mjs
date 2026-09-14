/**
 * Static-tier build (R6, R8, R15.3). Emits dist/api/v1/* (served by the Node
 * service from one origin) plus the docs site + OpenAPI.
 *
 * BASE_PATH lets the endpoint catalogue reflect the public path prefix the API is
 * mounted under behind the shared proxy (e.g. "/cbam"). Empty by default.
 */
import { mkdir, writeFile, copyFile, cp, readdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const apiV1 = path.join(dist, "api", "v1");
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));

// Data validation gate first — build fails if data is invalid.
console.log("Running data validation gate...");
execSync("node src/validate-data.mjs", { cwd: root, stdio: "inherit" });

const meta = readJson("data/meta.json");
const sectors = readJson("data/sectors.json");
const cnCodes = readJson("data/cn-codes.json");
const defaultValues = readJson("data/default-values.json");
const countryFactors = readJson("data/country-factors.json");
const carbonPrice = readJson("data/carbon-price.json");
const markups = readJson("data/markups.json");

async function writeJson(rel, obj) {
  const target = path.join(dist, rel);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(obj, null, 2) + "\n");
}

console.log("Building dist/ ...");

// Reference documents.
await writeJson("api/v1/meta.json", meta);
await writeJson("api/v1/sectors.json", sectors);
await writeJson("api/v1/cn-codes.json", cnCodes);
await writeJson("api/v1/default-values.json", defaultValues);
await writeJson("api/v1/country-factors.json", countryFactors);
await writeJson("api/v1/carbon-price.json", carbonPrice);
await writeJson("api/v1/markups.json", markups);

// Per-CN-code documents: /api/v1/cn-codes/{code}.json (R6.2).
for (const c of cnCodes.codes) {
  await writeJson(`api/v1/cn-codes/${c.cnCode}.json`, {
    ...c,
    source: cnCodes.source,
    version: cnCodes.version
  });
}

// Schemas.
const schemasSrc = path.join(root, "schemas");
await mkdir(path.join(apiV1, "schemas"), { recursive: true });
for (const f of await readdir(schemasSrc)) {
  if (f.endsWith(".json")) await copyFile(path.join(schemasSrc, f), path.join(apiV1, "schemas", f));
}

// Endpoint catalogue. BASE_PATH reflects the public path prefix ("/cbam").
const BASE = (process.env.BASE_PATH || "").replace(/\/$/, "");
const index = {
  name: "CBAM Embedded Emissions API",
  version: "v1",
  basePath: BASE || "/",
  generatedAt: new Date().toISOString(),
  static: {
    base: `${BASE}/api/v1`,
    endpoints: [
      { method: "GET", path: `${BASE}/api/v1/index.json`, description: "This catalogue." },
      { method: "GET", path: `${BASE}/api/v1/meta.json`, description: "Regulation metadata, key dates, de-minimis, dataset versions, sources." },
      { method: "GET", path: `${BASE}/api/v1/sectors.json`, description: "The six in-scope CBAM sectors." },
      { method: "GET", path: `${BASE}/api/v1/cn-codes.json`, description: "CN code → CBAM good → sector mapping." },
      { method: "GET", path: `${BASE}/api/v1/cn-codes/{code}.json`, description: "A single CN-code mapping." },
      { method: "GET", path: `${BASE}/api/v1/default-values.json`, description: "Default embedded-emission values per good (tCO2e/t)." },
      { method: "GET", path: `${BASE}/api/v1/country-factors.json`, description: "Country adjustment factors." },
      { method: "GET", path: `${BASE}/api/v1/markups.json`, description: "Default-value mark-up table (by sector and year)." },
      { method: "GET", path: `${BASE}/api/v1/carbon-price.json`, description: "Current cached EU ETS carbon price." },
      { method: "GET", path: `${BASE}/api/v1/schemas/calculate-response.schema.json`, description: "Calculate response JSON Schema." },
      { method: "GET", path: `${BASE}/api/v1/schemas/calculation-record.schema.json`, description: "Calculation record JSON Schema." }
    ]
  },
  compute: {
    note: "Public/free. Anonymous access allowed; optional API key (Authorization: Bearer <key>) unlocks a higher budget and retained calculation history. Rate limited per client.",
    endpoints: [
      { method: "POST", path: `${BASE}/v1/calculate`, description: "Calculate one line → embedded emissions + certificates + cost + audit trail." },
      { method: "POST", path: `${BASE}/v1/declarations/calculate`, description: "Calculate many lines → per-line + aggregate." },
      { method: "GET", path: `${BASE}/v1/calculations/{recordId}`, description: "Fetch a retained calculation record (API-key holders)." },
      { method: "GET", path: `${BASE}/v1/usage`, description: "API key usage and quota." }
    ]
  }
};
await writeJson("api/v1/index.json", index);

// OpenAPI + docs site into dist.
if (existsSync(path.join(root, "openapi.yaml"))) {
  await copyFile(path.join(root, "openapi.yaml"), path.join(dist, "openapi.yaml"));
}
if (existsSync(path.join(root, "site"))) {
  await cp(path.join(root, "site"), dist, { recursive: true });
}
// Bundle the client library so the docs page can run the exact calculation engine
// client-side (site/index.html imports ./lib/calculate.mjs).
await cp(path.join(root, "packages", "lib", "src"), path.join(dist, "lib"), { recursive: true });
await writeFile(path.join(dist, ".nojekyll"), "");

// sitemap.xml — served at {BASE}/sitemap.xml via the site catch-all route.
const SITE_URL = (process.env.SITE_URL || "https://apis.allanninal.dev").replace(/\/$/, "");
const publicBase = SITE_URL + (BASE || "");
const today = new Date().toISOString().slice(0, 10);
const urls = [
  `${publicBase}/`,
  `${publicBase}/openapi.yaml`,
  `${publicBase}/api/v1/index.json`,
  `${publicBase}/api/v1/meta.json`
];
const sitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join("\n") +
  `\n</urlset>\n`;
await writeFile(path.join(dist, "sitemap.xml"), sitemap);

console.log(`✓ Built static API into ${path.relative(root, dist)}/ (basePath ${BASE || "/"})`);
