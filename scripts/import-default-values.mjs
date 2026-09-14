/**
 * Import the Commission's official CBAM default-value table into
 * data/default-values.json.
 *
 * WHY THIS EXISTS
 * ---------------
 * The legally binding definitive-period default values live in Commission
 * Implementing Regulation (EU) 2025/2621 (corrected by (EU) 2026/1740), and the
 * Commission publishes a companion spreadsheet ("Default values definitive
 * period", XLSX) for information. Hand-transcribing ~600 KB of values is
 * error-prone; this script ingests the authoritative export directly so the
 * numbers in data/default-values.json come from the source, not from typing.
 *
 * INPUT FORMATS
 * -------------
 * To stay dependency-light (the `$0` stack), the script reads a CSV by default —
 * export the Commission XLSX sheet to CSV (or use the CSV the build pipeline
 * produces) — and needs NO external packages. If you point it at an .xlsx file it
 * will try to use the optional `xlsx` package if installed, otherwise it prints a
 * clear instruction to convert to CSV first.
 *
 * Expected columns (case-insensitive; configurable via --map):
 *   cnCode | good | sector | country | value
 * - `country` is optional/blank for the good-level fallback (rest-of-world /
 *   top-10-highest-emitters average); a country value (ISO2 or name) becomes a
 *   `byCountry` entry.
 * - Multiple rows for the same good are merged: the blank-country row sets
 *   `factor`; country rows populate `byCountry`.
 *
 * USAGE
 * -----
 *   node scripts/import-default-values.mjs <input.csv|input.xlsx> \
 *     [--version dv-2026.2] [--out data/default-values.json] [--dry-run]
 *     [--map cnCode=CN_CODE,good=Goods,sector=Sector,country=Country,value=DefaultValue]
 *
 * The output conforms to schemas/default-value.schema.json; run `npm run validate`
 * afterwards (the build gate will reject anything malformed), then bump
 * meta.datasetVersions.defaultValues to match --version.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const SECTORS = ["iron-steel", "aluminium", "cement", "fertilisers", "hydrogen", "electricity"];

// ISO2 helpers so a "country" column may be a code or a common name.
const NAME_TO_ISO2 = {
  "china": "CN", "india": "IN", "turkey": "TR", "türkiye": "TR", "russia": "RU",
  "ukraine": "UA", "united kingdom": "GB", "uk": "GB", "united states": "US",
  "usa": "US", "south korea": "KR", "korea": "KR", "brazil": "BR", "norway": "NO",
  "iceland": "IS", "liechtenstein": "LI", "switzerland": "CH"
};

function parseArgs(argv) {
  const args = { _: [], map: {}, out: "data/default-values.json", version: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--version") args.version = argv[++i];
    else if (a === "--map") {
      for (const pair of argv[++i].split(",")) {
        const [k, v] = pair.split("=");
        if (k && v) args.map[k.trim()] = v.trim();
      }
    } else args._.push(a);
  }
  return args;
}

/** Minimal, dependency-free CSV parser (handles quotes, commas, CRLF). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* ignore */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

async function readTable(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === ".csv") return parseCsv(readFileSync(inputPath, "utf8"));
  if (ext === ".xlsx" || ext === ".xls") {
    let xlsx;
    try { xlsx = (await import("xlsx")).default ?? (await import("xlsx")); }
    catch {
      throw new Error(
        `Reading ${ext} needs the optional 'xlsx' package. Either run\n` +
        `  npm i -D xlsx\n` +
        `or export the sheet to CSV and pass the .csv file instead.`
      );
    }
    const wb = xlsx.readFile(inputPath);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return xlsx.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
  }
  throw new Error(`Unsupported input extension: ${ext} (use .csv or .xlsx)`);
}

function normHeader(h) { return String(h || "").trim().toLowerCase(); }

function resolveColumns(header, map) {
  const idx = {};
  const want = { cnCode: ["cncode", "cn code", "cn"], good: ["good", "goods", "product"],
    sector: ["sector", "aggregated goods category", "category"],
    country: ["country", "country of origin", "origin"],
    value: ["value", "defaultvalue", "default value", "specific embedded emissions", "see"] };
  header.forEach((h, i) => {
    const n = normHeader(h);
    for (const key of Object.keys(want)) {
      if (map[key] && normHeader(map[key]) === n) idx[key] = i;
      else if (idx[key] == null && want[key].includes(n)) idx[key] = i;
    }
  });
  return idx;
}

function toSector(raw) {
  const n = normHeader(raw).replace(/\s+/g, "-");
  if (SECTORS.includes(n)) return n;
  if (/steel|iron/.test(n)) return "iron-steel";
  if (/alumin/.test(n)) return "aluminium";
  if (/cement/.test(n)) return "cement";
  if (/fertil/.test(n)) return "fertilisers";
  if (/hydrogen/.test(n)) return "hydrogen";
  if (/electric/.test(n)) return "electricity";
  return null;
}

function toIso2(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return NAME_TO_ISO2[s.toLowerCase()] || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args._[0];
  if (!input) {
    console.error("Usage: node scripts/import-default-values.mjs <input.csv|input.xlsx> [--version dv-2026.2] [--out ...] [--dry-run] [--map ...]");
    process.exit(2);
  }
  if (!existsSync(input)) { console.error(`Input not found: ${input}`); process.exit(2); }

  const table = await readTable(input);
  if (table.length < 2) { console.error("Input has no data rows."); process.exit(1); }

  const idx = resolveColumns(table[0], args.map);
  for (const req of ["good", "sector", "value"]) {
    if (idx[req] == null) {
      console.error(`Could not find a '${req}' column. Headers seen: ${table[0].join(" | ")}\n` +
        `Use --map to point at the right columns, e.g. --map good=Goods,sector=Category,value=DefaultValue`);
      process.exit(1);
    }
  }

  const byGood = new Map(); // good -> { good, sector, factor, byCountry, unit }
  let rowsIn = 0, skipped = 0;
  for (let r = 1; r < table.length; r++) {
    const row = table[r];
    const good = String(row[idx.good] ?? "").trim();
    const sector = toSector(row[idx.sector]);
    const valueRaw = String(row[idx.value] ?? "").replace(",", ".").trim();
    const value = Number(valueRaw);
    if (!good || !sector || !(value >= 0) || Number.isNaN(value)) { skipped++; continue; }
    rowsIn++;
    const entry = byGood.get(good) || { good, sector, factor: null, unit: "tCO2e/t", byCountry: {} };
    const iso2 = idx.country != null ? toIso2(row[idx.country]) : null;
    if (iso2) entry.byCountry[iso2] = value;
    else entry.factor = value; // blank-country row = good-level fallback
    byGood.set(good, entry);
  }

  // Any good that only had country rows: fall back to the max country value so a
  // fallback always exists (documented; reconcile if the source defines otherwise).
  const values = [];
  for (const e of byGood.values()) {
    if (e.factor == null) {
      const vals = Object.values(e.byCountry);
      e.factor = vals.length ? Math.max(...vals) : null;
    }
    const out = { good: e.good, sector: e.sector, factor: e.factor, unit: e.unit };
    if (Object.keys(e.byCountry).length) out.byCountry = e.byCountry;
    values.push(out);
  }

  const version = args.version || `dv-import-${new Date().toISOString().slice(0, 10)}`;
  const doc = {
    version,
    source: "Commission Implementing Regulation (EU) 2025/2621 (imported from official default-value spreadsheet)",
    sourceUrl: "https://eur-lex.europa.eu/eli/reg_impl/2025/2621/oj",
    effectiveDate: "2026-01-01",
    note: `Imported by scripts/import-default-values.mjs from ${path.basename(input)} on ${new Date().toISOString()}. Verify against the binding Regulation/Excel before production use.`,
    values
  };

  console.log(`Parsed ${rowsIn} value rows (${skipped} skipped) → ${values.length} goods, version ${version}.`);
  if (args.dryRun) {
    console.log(JSON.stringify(doc, null, 2).slice(0, 2000) + "\n... (--dry-run, not written)");
    return;
  }
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(root, args.out);
  writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n");
  console.log(`Wrote ${path.relative(root, outPath)}. Next: bump meta.datasetVersions.defaultValues to "${version}" and run 'npm run validate'.`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
