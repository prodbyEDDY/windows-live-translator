// i18n key-parity check: ru.json and en.json must have an identical set of
// (deeply-nested) keys. Exits non-zero and prints the diff on mismatch.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ru = JSON.parse(readFileSync(resolve(here, "../src/i18n/ru.json"), "utf8"));
const en = JSON.parse(readFileSync(resolve(here, "../src/i18n/en.json"), "utf8"));

/** Flatten an object into a sorted list of dot-paths to leaf (string) values. */
function flatten(obj, prefix = "") {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      keys.push(...flatten(v, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

const ruKeys = new Set(flatten(ru));
const enKeys = new Set(flatten(en));

const missingInEn = [...ruKeys].filter((k) => !enKeys.has(k)).sort();
const missingInRu = [...enKeys].filter((k) => !ruKeys.has(k)).sort();

if (missingInEn.length === 0 && missingInRu.length === 0) {
  console.log(`i18n parity OK — ${ruKeys.size} keys in each locale.`);
  process.exit(0);
}

if (missingInEn.length) console.error("Keys in ru.json but MISSING in en.json:\n  " + missingInEn.join("\n  "));
if (missingInRu.length) console.error("Keys in en.json but MISSING in ru.json:\n  " + missingInRu.join("\n  "));
process.exit(1);
