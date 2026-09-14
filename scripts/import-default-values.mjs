/**
 * Import the Commission's official CBAM default-value workbook into
 * data/default-values.json.
 *
 * WHY THIS EXISTS
 * ---------------
 * The legally binding definitive-period default values are in Commission
 * Implementing Regulation (EU) 2025/2621 (corrected by (EU) 2026/1740). The
 * Commission publishes the same values as an XLSX ("Default values definitive
 * period" / "DV correcting act") with ONE SHEET PER COUNTRY plus an
 * "_Other Countries and Territories" fallback sheet. Each sheet lists, per CN /
 * TARIC code: direct, indirect and TOTAL default emissions (tCO2e per tonne).
 *
 * This script parses that workbook directly (no third-party deps — it uses the
 * system `unzip` to open the .xlsx zip, then reads the XML) and produces a
 * CN-code-keyed default-values.json where:
 *   - `factor` (good-level fallback) = the "_Other Countries and Territories" total
 *   - `byCountry` = per-country total for every country sheet that lists the code
 *
 * USAGE
 * -----
 *   node scripts/import-default-values.mjs <workbook.xlsx> \
 *     [--version dv-2026.3] [--out data/default-values.json] [--emissions total|direct]
 *     [--dry-run]
 *
 * Download the workbook from:
 *   https://taxation-customs.ec.europa.eu/carbon-border-adjustment-mechanism/cbam-legislation-and-guidance_en
 * (link "Default values definitive period" / "DV correcting act ... .xlsx").
 *
 * After import, bump meta.datasetVersions.defaultValues to --version and run
 * `npm run validate` (the build gate rejects anything malformed).
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const COUNTRY_TO_ISO2 = {
  "albania": "AL", "algeria": "DZ", "angola": "AO", "argentina": "AR", "armenia": "AM",
  "australia": "AU", "azerbaijan": "AZ", "bangladesh": "BD", "bahrain": "BH", "belarus": "BY",
  "benin": "BJ", "bolivia": "BO", "bosnia and herzegovina": "BA", "brazil": "BR", "brunei": "BN",
  "cambodia": "KH", "cameroon": "CM", "canada": "CA", "chile": "CL", "china": "CN",
  "colombia": "CO", "congo": "CG", "congo, democratic republic of": "CD", "costa rica": "CR",
  "cuba": "CU", "curaçao": "CW", "dominican republic": "DO", "ecuador": "EC", "egypt": "EG",
  "el salvador": "SV", "equatorial guinea": "GQ", "eritrea": "ER", "eswatini": "SZ",
  "ethiopia": "ET", "gabon": "GA", "georgia": "GE", "ghana": "GH", "guatemala": "GT",
  "haiti": "HT", "honduras": "HN", "hong kong": "HK", "india": "IN", "indonesia": "ID",
  "iran, islamic republic of": "IR", "iraq": "IQ", "israel": "IL", "ivory coast": "CI",
  "jamaica": "JM", "japan": "JP", "jordan": "JO", "kazakhstan": "KZ", "kenya": "KE",
  "korea, republic of (south korea": "KR", "kuwait": "KW", "kyrgyzstan": "KG", "laos": "LA",
  "lebanon": "LB", "liberia": "LR", "libya": "LY", "madagascar": "MG", "malaysia": "MY",
  "mali": "ML", "mauritania": "MR", "mauritius": "MU", "mexico": "MX", "moldova, republic of": "MD",
  "mongolia": "MN", "montenegro": "ME", "morocco": "MA", "mozambique": "MZ", "myanmar": "MM",
  "namibia": "NA", "nepal": "NP", "new caledonia and dependencies": "NC", "new zealand": "NZ",
  "nicaragua": "NI", "niger": "NE", "nigeria": "NG", "north korea (democratic people’": "KP",
  "north macedonia": "MK", "oman": "OM", "pakistan": "PK", "panama": "PA", "papua new guinea": "PG",
  "paraguay": "PY", "peru": "PE", "philippines": "PH", "qatar": "QA", "russian federation": "RU",
  "rwanda": "RW", "saudi arabia": "SA", "senegal": "SN", "serbia": "RS", "sierra leone": "SL",
  "singapore": "SG", "south africa": "ZA", "sri lanka": "LK", "sudan": "SD", "suriname": "SR",
  "syria": "SY", "taiwan": "TW", "tajikistan": "TJ", "tanzania, united republic of": "TZ",
  "thailand": "TH", "togo": "TG", "trinidad and tobago": "TT", "tunisia": "TN", "türkiye": "TR",
  "turkmenistan": "TM", "uganda": "UG", "ukraine": "UA", "united arab emirates": "AE",
  "united kingdom": "GB", "united states": "US", "uruguay": "UY", "uzbekistan": "UZ",
  "venezuela": "VE", "viet nam": "VN", "yemen": "YE", "zambia": "ZM", "zimbabwe": "ZW"
};

const SECTOR_HEADERS = {
  "cement": "cement", "fertilisers": "fertilisers", "fertilizers": "fertilisers",
  "iron and steel": "iron-steel", "iron & steel": "iron-steel", "aluminium": "aluminium",
  "hydrogen": "hydrogen", "electricity": "electricity"
};

function parseArgs(argv) {
  const args = { _: [], out: "data/default-values.json", version: null, dryRun: false, emissions: "total" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--version") args.version = argv[++i];
    else if (a === "--emissions") args.emissions = argv[++i];
    else args._.push(a);
  }
  return args;
}

const decode = (s) => String(s || "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#10;/g, " ").replace(/&#9;/g, " ").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

function readSharedStrings(dir) {
  const p = path.join(dir, "xl", "sharedStrings.xml");
  if (!existsSync(p)) return [];
  const xml = readFileSync(p, "utf8");
  return [...xml.matchAll(/<si>(.*?)<\/si>/gs)].map((m) =>
    decode([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((x) => x[1]).join("")));
}

function readCells(file, strings) {
  const xml = readFileSync(file, "utf8");
  const out = {};
  for (const c of xml.matchAll(/<c r="([A-Z]+)(\d+)"(?:[^>]*t="([^"]*)")?[^>]*>(?:<v>(.*?)<\/v>)?/g)) {
    if (c[4] == null) continue;
    const val = c[3] === "s" ? strings[+c[4]] : c[4];
    (out[+c[2]] = out[+c[2]] || {})[c[1]] = val;
  }
  return out;
}

/** Map sheet display name -> worksheet file path via workbook + rels. */
function sheetFileMap(dir) {
  const wb = readFileSync(path.join(dir, "xl", "workbook.xml"), "utf8");
  const rels = readFileSync(path.join(dir, "xl", "_rels", "workbook.xml.rels"), "utf8");
  const relMap = {};
  for (const m of rels.matchAll(/<Relationship [^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g)) relMap[m[1]] = m[2];
  const map = [];
  for (const m of wb.matchAll(/<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)) {
    const target = relMap[m[2]];
    if (target) map.push({ name: decode(m[1]), file: path.join(dir, "xl", target.replace(/^\//, "").replace(/^xl\//, "xl/")) });
  }
  return map;
}

const num = (raw) => {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/\u00a0/g, "").replace(",", ".");
  if (!/^[0-9]*\.?[0-9]+$/.test(s)) return null;
  return Number(s);
};
const normCn = (raw) => String(raw || "").replace(/[^0-9]/g, "");

/** Parse one country/fallback sheet into { cnCode -> { good, sector, value } }. */
function parseSheet(cells, emissionsCol) {
  const rows = Object.keys(cells).map(Number).sort((a, b) => a - b);
  const result = {};
  let sector = null;
  for (const r of rows) {
    const row = cells[r];
    const a = (row.A || "").trim();
    if (!a) continue;
    const lower = a.toLowerCase();
    if (SECTOR_HEADERS[lower]) { sector = SECTOR_HEADERS[lower]; continue; }
    if (lower.startsWith("product cn code") || lower.startsWith("other countries") ||
        /^[a-z ,()'’]+$/i.test(a) && !/[0-9]/.test(a) && a.length < 40 && !sector) continue;
    const cn = normCn(a);
    if (cn.length < 4) continue; // not a CN-code row (heading = 4 digits min)
    const value = num(row[emissionsCol]);
    if (value == null) continue; // "see below" group headers, etc.
    result[cn] = { good: decode(row.B || "").trim() || a, sector, value, code: cn };
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args._[0];
  if (!input) { console.error("Usage: node scripts/import-default-values.mjs <workbook.xlsx> [--version dv-2026.3] [--emissions total|direct] [--out ...] [--dry-run]"); process.exit(2); }
  if (!existsSync(input)) { console.error(`Input not found: ${input}`); process.exit(2); }
  const emissionsCol = args.emissions === "direct" ? "C" : "E"; // C=direct, E=total

  const work = mkdtempSync(path.join(tmpdir(), "cbam-dv-"));
  try {
    execFileSync("unzip", ["-o", "-q", path.resolve(input), "-d", work]);
    const strings = readSharedStrings(work);
    const sheets = sheetFileMap(work);

    // Fallback sheet first (good-level factor), then each country.
    const fallbackSheet = sheets.find((s) => /other countries/i.test(s.name));
    if (!fallbackSheet) { console.error("Could not find the '_Other Countries and Territories' fallback sheet."); process.exit(1); }
    const fallback = parseSheet(readCells(fallbackSheet.file, strings), emissionsCol);

    // Build the CN-keyed value map. Use the 8-digit CN as the calculator key
    // (declarations carry the CN subheading); collapse 10-digit TARIC rows onto
    // their 8-digit parent, keeping the first (or the more specific if unique).
    const byCn = new Map(); // code -> { good, sector, factor, byCountry }
    const put = (code, good, sector, country, value) => {
      let e = byCn.get(code);
      if (!e) { e = { good, sector, factor: null, byCountry: {} }; byCn.set(code, e); }
      if (!e.good && good) e.good = good;
      if (!e.sector && sector) e.sector = sector;
      if (country === null) { if (e.factor == null) e.factor = value; }
      else { if (e.byCountry[country] == null) e.byCountry[country] = value; }
    };
    for (const v of Object.values(fallback)) put(v.code, v.good, v.sector, null, v.value);

    let countrySheets = 0;
    for (const s of sheets) {
      if (["Overview", "Version History", "Annex IV"].includes(s.name)) continue;
      if (/other countries/i.test(s.name)) continue;
      const iso2 = COUNTRY_TO_ISO2[s.name.toLowerCase()];
      if (!iso2) continue; // skip anything we can't map to ISO2
      countrySheets++;
      const parsed = parseSheet(readCells(s.file, strings), emissionsCol);
      for (const v of Object.values(parsed)) put(v.code, v.good, v.sector, iso2, v.value);
    }

    const values = [];
    for (const [code, e] of byCn) {
      if (e.factor == null) {
        const vals = Object.values(e.byCountry);
        e.factor = vals.length ? Math.max(...vals) : null; // fallback if no _Other row
      }
      if (e.factor == null || !e.sector) continue;
      const out = { cnCode: code, good: e.good, sector: e.sector, factor: round3(e.factor), unit: "tCO2e/t" };
      if (Object.keys(e.byCountry).length) {
        out.byCountry = Object.fromEntries(Object.entries(e.byCountry).map(([k, v]) => [k, round3(v)]));
      }
      values.push(out);
    }
    values.sort((a, b) => a.cnCode.localeCompare(b.cnCode));

    const version = args.version || `dv-import-${new Date().toISOString().slice(0, 10)}`;
    const doc = {
      version,
      source: "Commission Implementing Regulation (EU) 2025/2621 (imported from the official default-value workbook, corrected act update)",
      sourceUrl: "https://eur-lex.europa.eu/eli/reg_impl/2025/2621/oj",
      effectiveDate: "2026-01-01",
      emissionsBasis: args.emissions === "direct" ? "direct" : "total (direct + indirect)",
      keyedBy: "cnCode",
      note: `Imported by scripts/import-default-values.mjs from ${path.basename(input)} on ${new Date().toISOString()}. factor = "_Other Countries and Territories" fallback; byCountry = per-country values. Values are the ${args.emissions === "direct" ? "direct" : "total"} default emissions (tCO2e/t) from the Commission workbook.`,
      values
    };

    console.log(`Parsed ${countrySheets} country sheets + fallback → ${values.length} CN codes.`);
    if (args.dryRun) { console.log(JSON.stringify(doc.values.slice(0, 6), null, 2)); console.log(`... (--dry-run; ${values.length} total, not written)`); return; }
    const outPath = path.isAbsolute(args.out) ? args.out : path.join(root, args.out);
    writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
    console.log(`Wrote ${path.relative(root, outPath)} (${values.length} CN codes, version ${version}).`);
    console.log(`Next: bump meta.datasetVersions.defaultValues to "${version}" and run 'npm run validate'.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function round3(n) { return Math.round(n * 1000) / 1000; }

main();
