/**
 * Translation integrity test (repository-native validation, Issue #382).
 *
 * FloCafe manages translations directly in Git — no Crowdin/Weblate/Tolgee.
 * This suite is the safety gate for every component migration and community
 * translation contribution. It verifies, on every run:
 *
 *   1. Registry ↔ file consistency: every language in
 *      `frontend/src/lib/i18n/languages.ts` has a message JSON file and vice
 *      versa; locale tags are valid BCP-47 and directions are ltr/rtl.
 *   2. Exact nested leaf key parity with `en.json` as the canonical schema:
 *      every leaf key path in en.json must exist in es/fr/pt/fa (zero missing)
 *      and no locale may carry orphan extra keys.
 *   3. String leaf validity: every leaf must be a non-empty string (reject
 *      null, boolean, numeric, object, array), with no corrupted leaf
 *      strings (raw newlines, trailing JSON syntax leftovers, unbalanced
 *      braces) and no empty object/array nodes.
 *   4. ICU syntax validation: every message parses with
 *      `@formatjs/icu-messageformat-parser` (malformed plural rules, invalid
 *      case selectors, unclosed brackets, and syntax errors all fail).
 *   5. ICU variable and placeholder parity: every locale uses the same
 *      argument names as English, and plural/select selector variables match.
 *   6. Rich-text & tag placeholder parity: `{tag}`-style formatting tags
 *      (e.g. `<bold>`, `<link>`) used by English are preserved by every
 *      locale.
 *   7. TypeScript key safety: `t('...')` literal keys used in the frontend
 *      are all defined; template-literal `t(`prefix.${var}`)` calls must
 *      carry an exhaustively typed key cast (`as 'a' | 'b'`); the
 *      `use-intl` AppConfig augmentation in `messages.d.ts` is present.
 *   8. Thai safeguards: th.json values never contain placeholders, malformed
 *      replacement characters, or non-NFC text, and only documented shared
 *      values may remain identical to English.
 *
 * Negative tests at the bottom feed broken fixture data into each validator
 * and assert it is caught, so a regression in the validators themselves
 * fails CI.
 *
 * Run: npm run test:translations  (also wired into `npm test` and
 * `npm run i18n:check`)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  parse,
  isArgumentElement,
  isDateElement,
  isNumberElement,
  isTimeElement,
  isPluralElement,
  isSelectElement,
  isTagElement,
  type MessageFormatElement,
} from '@formatjs/icu-messageformat-parser';
import { LANGUAGES } from '../frontend/src/lib/i18n/languages';
import { walkTypeScriptFiles, collectCalledKeys } from './helpers/i18n-scanner';

const ROOT = path.join(__dirname, '..');
const I18N_DIR = path.join(ROOT, 'frontend/src/lib/i18n/messages');
const FRONTEND_SRC = path.join(ROOT, 'frontend/src');
const MESSAGES_DTS = path.join(ROOT, 'frontend/src/lib/i18n/messages.d.ts');
const FILES = (Object.keys(LANGUAGES) as Array<keyof typeof LANGUAGES>).map((lang) => ({
  lang,
  file: path.join(I18N_DIR, `${lang}.json`),
}));

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

/**
 * Recursively flatten a nested message tree into flat dotted leaf keys
 * (e.g. `{ auth: { signIn: "Sign In" } }` → `{ "auth.signIn": "Sign In" }`).
 * This is the canonical view used for cross-locale parity and value checks.
 */
function flattenLeaves(
  node: unknown,
  prefix = '',
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
    for (const [k, v] of Object.entries(node)) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        flattenLeaves(v, full, out);
      } else {
        out[full] = v;
      }
    }
  }
  return out;
}

/**
 * Scan raw JSON for duplicate keys scoped to their own object. JSON.parse
 * silently drops duplicates, so walk the text ourselves: read string tokens
 * (skipping escapes), treat a string followed by `:` as a key, and track
 * `{`/`}` nesting so the same leaf name is allowed in different namespaces
 * while a repeat inside one object is flagged.
 */
function findDuplicateKeys(raw: string): string[] {
  const dups: string[] = [];
  const stack: Array<Set<string>> = [new Set()];
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      let j = i + 1;
      let str = '';
      while (j < raw.length) {
        if (raw[j] === '\\') {
          if (raw[j + 1] === 'u') {
            str += raw.slice(j, j + 6);
            j += 6;
          } else {
            str += raw[j] + raw[j + 1];
            j += 2;
          }
          continue;
        }
        if (raw[j] === '"') break;
        str += raw[j];
        j += 1;
      }
      i = j + 1;
      let k = i;
      while (k < raw.length && /\s/.test(raw[k])) k += 1;
      if (raw[k] === ':') {
        const key = JSON.parse(`"${str}"`);
        const top = stack[stack.length - 1];
        if (top.has(key)) dups.push(key);
        else top.add(key);
        i = k + 1;
      }
    } else if (c === '{') {
      stack.push(new Set());
      i += 1;
    } else if (c === '}') {
      if (stack.length > 1) stack.pop();
      i += 1;
    } else {
      i += 1;
    }
  }
  return dups;
}

/** Value-shape checks that only apply to string leaves. */
function isMalformedValue(value: unknown): string | null {
  if (typeof value !== 'string') return `non-string value (${typeof value})`;
  if (value.trim().length === 0) return 'empty or whitespace-only';

  if (/["`,]$/.test(value)) return 'trailing JSON artifact (\", `, `,` or `$)';

  if (value.includes('\n')) return 'contains a real newline character';

  const opens = (value.match(/\{/g) || []).length;
  const closes = (value.match(/\}/g) || []).length;
  if (opens !== closes) {
    return `unbalanced braces (${opens} '{' vs ${closes} '}')`;
  }

  return null;
}

/**
 * Structural walk of the raw message tree. Flags anything that is not a
 * non-empty string leaf: empty objects (a namespace that produces zero
 * leaves would otherwise silently vanish from parity checks), arrays, and
 * null/boolean/numeric values at any depth.
 */
function findStructuralErrors(tree: Record<string, unknown>, lang: string): string[] {
  const errors: string[] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      errors.push(`[${lang}] ${prefix} — array value at non-leaf position`);
      return;
    }
    const entries = Object.entries(node as Record<string, unknown>);
    if (entries.length === 0) {
      errors.push(`[${lang}] ${prefix} — empty object (no leaf keys)`);
      return;
    }
    for (const [k, v] of entries) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object') {
        if (Array.isArray(v)) {
          errors.push(`[${lang}] ${full} — array value (must be a string leaf)`);
        } else if (Object.keys(v as Record<string, unknown>).length === 0) {
          errors.push(`[${lang}] ${full} — empty object (must be a string leaf)`);
        } else {
          walk(v, full);
        }
      } else if (typeof v !== 'string' || v.trim().length === 0) {
        errors.push(`[${lang}] ${full} — non-string or empty leaf (${JSON.stringify(v)})`);
      }
    }
  };
  walk(tree, '');
  return errors;
}

/* ------------------------------------------------------------------ *
 * ICU helpers — argument / selector / tag extraction from the parser *
 * AST. Used for syntax validation and English-parity comparisons.    *
 * ------------------------------------------------------------------ */

interface IcuInfo {
  args: Set<string>;
  selectors: Map<string, 'plural' | 'select'>;
  tags: Set<string>;
}

/**
 * Parse an ICU message and collect the argument names, plural/select
 * selector variables, and rich-text tag names it uses. Throws a SyntaxError
 * on malformed ICU (unclosed brackets, missing `other`, invalid selectors).
 */
function icuInfo(message: string): IcuInfo {
  const ast = parse(message);
  const info: IcuInfo = { args: new Set(), selectors: new Map(), tags: new Set() };
  const walk = (els: MessageFormatElement[]): void => {
    for (const el of els) {
      if (isArgumentElement(el)) {
        info.args.add(el.value);
      } else if (isNumberElement(el) || isDateElement(el) || isTimeElement(el)) {
        info.args.add(el.value);
      } else if (isPluralElement(el) || isSelectElement(el)) {
        info.args.add(el.value);
        info.selectors.set(el.value, isPluralElement(el) ? 'plural' : 'select');
        for (const opt of Object.values(el.options)) walk(opt.value);
      } else if (isTagElement(el)) {
        info.tags.add(el.value);
        walk(el.children);
      }
    }
  };
  walk(ast);
  return info;
}

/** Try to parse a message; returns the syntax error text or null. */
function icuSyntaxError(message: string): string | null {
  try {
    parse(message);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/* ---------------------------------------------------------------- *
 * Validators — each takes plain data so the negative tests at the  *
 * bottom can feed broken fixtures. Returns an array of error       *
 * strings; empty array means valid.                                *
 * ---------------------------------------------------------------- */

function registryConsistencyErrors(
  registry: Record<string, { locale: string; direction: string; selectable: boolean }>,
  filesOnDisk: string[],
): string[] {
  const errors: string[] = [];
  const langs = Object.keys(registry);
  const fileSet = new Set(filesOnDisk);

  for (const lang of langs) {
    if (!fileSet.has(`${lang}.json`)) {
      errors.push(`registry language "${lang}" has no messages/${lang}.json file`);
    }
    const cfg = registry[lang];
    try {
      const canonical = new Intl.Locale(cfg.locale).toString();
      if (canonical !== cfg.locale) {
        errors.push(
          `language "${lang}" locale "${cfg.locale}" is not canonical BCP-47 (expected "${canonical}")`,
        );
      }
    } catch {
      errors.push(`language "${lang}" has invalid BCP-47 locale tag "${cfg.locale}"`);
    }
    if (cfg.direction !== 'ltr' && cfg.direction !== 'rtl') {
      errors.push(
        `language "${lang}" has invalid direction "${cfg.direction}" (expected ltr or rtl)`,
      );
    }
    if (typeof cfg.selectable !== 'boolean') {
      errors.push(`language "${lang}" selectable must be a boolean`);
    }
  }

  for (const f of filesOnDisk) {
    const lang = f.replace(/\.json$/, '');
    if (!langs.includes(lang)) {
      errors.push(`messages/${f} has no matching entry in the languages.ts registry`);
    }
  }

  return errors;
}

/** Locales kept complete; every other catalogue may lag behind en.json and fall back to English. */
const FULLY_MAINTAINED_LOCALES: ReadonlySet<string> = new Set(['th']);

function keyParityErrors(enKeys: Set<string>, localeKeys: Set<string>, lang: string): string[] {
  const errors: string[] = [];
  const missing = [...enKeys].filter((k) => !localeKeys.has(k));
  const orphan = [...localeKeys].filter((k) => !enKeys.has(k));
  for (const k of missing) errors.push(`[${lang}] missing key: ${k}`);
  for (const k of orphan) errors.push(`[${lang}] orphan extra key (not in en.json): ${k}`);
  return errors;
}

function leafStringErrors(flat: Record<string, unknown>, lang: string): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(flat)) {
    const reason = isMalformedValue(v);
    if (reason) errors.push(`[${lang}] ${k} — ${reason}`);
  }
  return errors;
}

function icuSyntaxErrors(flat: Record<string, string>, lang: string): string[] {
  const errors: string[] = [];
  for (const [k, v] of Object.entries(flat)) {
    const err = icuSyntaxError(v);
    if (err) errors.push(`[${lang}] ${k} — invalid ICU syntax: ${err}`);
  }
  return errors;
}

function icuParityErrors(
  enFlat: Record<string, string>,
  localeFlat: Record<string, string>,
  lang: string,
): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const localeVal = localeFlat[k];
    if (localeVal === undefined) continue; // missing keys reported by keyParityErrors
    const en = icuInfo(enFlat[k]);
    const loc = icuInfo(localeVal);

    const enOnlyArgs = [...en.args].filter((a) => !loc.args.has(a));
    const locOnlyArgs = [...loc.args].filter((a) => !en.args.has(a));
    if (enOnlyArgs.length || locOnlyArgs.length) {
      errors.push(
        `[${lang}] ${k} — placeholder argument mismatch: EN-only=[${enOnlyArgs.join(',')}] ${lang}-only=[${locOnlyArgs.join(',')}]`,
      );
    }

    const enOnlySel = [...en.selectors.entries()].filter(([name]) => !loc.selectors.has(name));
    const locOnlySel = [...loc.selectors.entries()].filter(([name]) => !en.selectors.has(name));
    const typeMismatch = [...en.selectors.entries()].filter(
      ([name, type]) => loc.selectors.get(name) && loc.selectors.get(name) !== type,
    );
    if (enOnlySel.length || locOnlySel.length || typeMismatch.length) {
      errors.push(
        `[${lang}] ${k} — plural/select selector mismatch: EN=[${[...en.selectors.entries()].map(([n, t]) => `${n}(${t})`).join(',')}] ${lang}=[${[...loc.selectors.entries()].map(([n, t]) => `${n}(${t})`).join(',')}]`,
      );
    }
  }
  return errors;
}

function tagParityErrors(
  enFlat: Record<string, string>,
  localeFlat: Record<string, string>,
  lang: string,
): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const localeVal = localeFlat[k];
    if (localeVal === undefined) continue;
    const enTags = icuInfo(enFlat[k]).tags;
    const locTags = icuInfo(localeVal).tags;
    const missing = [...enTags].filter((t) => !locTags.has(t));
    const extra = [...locTags].filter((t) => !enTags.has(t));
    if (missing.length || extra.length) {
      errors.push(
        `[${lang}] ${k} — rich-text tag mismatch: EN tags=[${[...enTags].join(',')}] ${lang} tags=[${[...locTags].join(',')}]`,
      );
    }
  }
  return errors;
}

/** Thai translation safeguards. */
const TH_INTENTIONAL_IDENTICAL = new Set<string>([
  'promotionDraft.draft',
  'promotionDraft.kindAutomatic',
  'promotionDraft.kindBundle',
  'promotionDraft.kindCoupon',
  'promotionDraft.kindMember',
  'promotionDraft.previewTitle',
  'marketingPromo.branch.example',
  'marketingPromo.bundle.name',
  'marketingPromo.firstVisit.example',
  'marketingPromo.flash.name',
  'marketingPromo.happyHour.condition',
  'marketingPromo.happyHour.name',
  'marketingPromo.memberTier.example',
  'marketingPromo.winBack.example',
  'auth.emailPlaceholder',
  'common.appTitle',
  'common.brandName',
  'common.logoAlt',
  'dashboard.exportCsv',
  'dashboard.exportPdf',
  'dashboard.exportXlsx',
  'dashboard.ticketMethodCount',
  'kds.emptyColumn',
  'nav.kds',
  'nav.pos',
  'nav.whatsapp',
  'pos.addonPrice',
  'pos.loadingEllipsis',
  'pos.tagCount',
  'pos.taxLine',
  'printTest.escpos',
  'print.hsn',
  'print.zReport.paymentCount',
  'products.addonSelectionRange',
  'products.fieldSku',
  'products.saleUnitCl',
  'products.saleUnitFlOz',
  'products.saleUnitG',
  'products.saleUnitKg',
  'products.saleUnitL',
  'products.saleUnitLb',
  'products.saleUnitMl',
  'products.saleUnitOz',
  'products.skuLabel',
  'serverApp.emailPlaceholder',
  'serverApp.title',
  'settings.apiKeyInputPlaceholder',
  'settings.connectionUsb',
  'settings.instagramPlaceholder',
  'settings.ipAddressPlaceholder',
  'settings.kds',
  'settings.paymentMethodUpi',
  'settings.portPlaceholder',
  'settings.registrationEmailPlaceholder',
  'settings.registrationLastError',
  'settings.revflo',
  'settings.serverApp',
  'settings.tabOrderflow',
  'settings.tabWhatsapp',
  'settings.unicode',
  'settings.whatsapp',
  'setup.finedineLabel',
  'setup.ownerEmailPlaceholder',
  'setup.pinLabel',
  'setup.qsrLabel',
  'tax.auditCreateOverride',
  'tax.auditUpdateOverride',
  'update.downloadingBadge',
  'whatsapp.connect.pairingPhonePlaceholder',
]);

function thFallbackErrors(
  thFlat: Record<string, string>,
  enFlat: Record<string, string>,
): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(enFlat)) {
    const thVal = thFlat[k];
    if (thVal === undefined) continue;
    if (thVal.startsWith('[TH]') || thVal.startsWith('[TODO]')) {
      errors.push(`th.json ${k} — placeholder prefix found: "${thVal}"`);
    } else if (thVal === enFlat[k] && !TH_INTENTIONAL_IDENTICAL.has(k)) {
      errors.push(`th.json ${k} — identical to English value (renders as English for Thai users)`);
    } else if (thVal !== thVal.normalize('NFC')) {
      errors.push(`th.json ${k} — value must use Unicode NFC`);
    } else if (thVal.includes('\uFFFD')) {
      errors.push(`th.json ${k} — value contains a Unicode replacement character`);
    }
  }
  return errors;
}

/** Keys whose `{number}` placeholder names an order number that must stay
 * introduced by punctuation (for example `#` or `№`) or a space, never welded
 * onto the end of a verb-final clause. */
const ORDER_NUMBER_PLACEHOLDER_KEYS = ['pos.addingItemsToOrder', 'pos.itemsAddedToOrder'] as const;
const WORD_CHARACTER_RE = /[\p{L}\p{M}]/u;

/** Order numbers must not be glued to a word, in any locale or script. */
function orderNumberPlaceholderErrors(
  flatByLang: Record<string, Record<string, string>>,
): string[] {
  const errors: string[] = [];
  for (const [lang, messages] of Object.entries(flatByLang)) {
    for (const key of ORDER_NUMBER_PLACEHOLDER_KEYS) {
      const value = messages[key];
      if (value === undefined) {
        errors.push(`${lang}.json is missing ${key}`);
        continue;
      }
      // Every occurrence is checked: a message may legally carry {number} more
      // than once, and checking only the first would let a later welded one
      // through. Argument-name parity does not catch this, because it compares
      // names rather than occurrence counts.
      const matches = [...value.matchAll(/\{number\}/g)];
      if (matches.length === 0) {
        errors.push(`${lang}.json ${key} must contain the {number} placeholder, got "${value}"`);
        continue;
      }
      for (const match of matches) {
        const preceding = value[match.index - 1] ?? '';
        if (WORD_CHARACTER_RE.test(preceding)) {
          errors.push(
            `${lang}.json ${key} — {number} at position ${match.index} is welded to the preceding letter/mark ` +
              `(…${preceding}{number}); the order number must be introduced by punctuation or a space, got "${value}"`,
          );
        }
      }
    }
  }
  return errors;
}

/* ------------------------------------------------------------ *
 * Frontend source scans (TypeScript key safety, Issue #382 §6). *
 * ------------------------------------------------------------ */

/**
 * Find unsafe template-literal translation calls: `t(\`prefix.${var}\`)`
 * without an exhaustively typed `as 'key1' | 'key2'` cast. Dynamic keys must
 * be pinned to a closed set of valid message keys so a typo or an
 * unexpected runtime value cannot render a raw key string in the UI.
 */
function collectUnsafeDynamicKeys(
  dir: string = FRONTEND_SRC,
): Array<{ file: string; line: number; code: string }> {
  const hits: Array<{ file: string; line: number; code: string }> = [];
  for (const file of walkTypeScriptFiles(dir)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      // `t(` immediately followed by a backtick template containing `${`
      // and NOT followed (after the closing backtick) by ` as `.
      const re = /(?:^|[^\w$.])t\(\s*`([^`]*\$\{[^}]*\}[^`]*)`(?!\s*as\s+)/;
      if (re.test(line)) {
        hits.push({ file: path.relative(ROOT, file), line: idx + 1, code: line.trim() });
      }
    });
  }
  return hits;
}

/** Prevent new frontend consumers from depending on the bridge removed by #381. */
function legacyImportErrors(dir: string = FRONTEND_SRC): string[] {
  const errors: string[] = [];
  const allowed = new Set([path.normalize(path.join(dir, 'lib/i18n.ts'))]);
  for (const file of walkTypeScriptFiles(dir)) {
    if (allowed.has(path.normalize(file))) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/\buseI18n\b/.test(source)) {
      errors.push(`${path.relative(ROOT, file)} uses the legacy useI18n bridge`);
    }
    if (/\bformatIcuPlural\b/.test(source)) {
      errors.push(`${path.relative(ROOT, file)} uses the legacy formatIcuPlural helper`);
    }
    if (
      /import\s*\{[\s\S]*?\b(?:t|translate)\b[\s\S]*?\}\s*from\s*['"]@\/lib\/i18n['"]/.test(source)
    ) {
      errors.push(`${path.relative(ROOT, file)} imports the legacy t() bridge`);
    }
  }
  return errors;
}

/** The `use-intl` AppConfig augmentation must stay wired (Issue #382 §6). */
function messagesDtsErrors(): string[] {
  const errors: string[] = [];
  if (!fs.existsSync(MESSAGES_DTS)) {
    errors.push('frontend/src/lib/i18n/messages.d.ts is missing (use-intl AppConfig augmentation)');
    return errors;
  }
  const content = fs.readFileSync(MESSAGES_DTS, 'utf8');
  if (!content.includes("declare module 'use-intl'"))
    errors.push("messages.d.ts must declare module 'use-intl'");
  if (!content.includes('interface AppConfig'))
    errors.push('messages.d.ts must declare interface AppConfig');
  if (!/Messages\s*:/.test(content)) errors.push('messages.d.ts AppConfig must type Messages');
  if (!/Locale\s*:/.test(content)) errors.push('messages.d.ts AppConfig must type Locale');
  return errors;
}

/* ----------------------------------------------------------------- *
 * Live repository checks — run against the real message files.      *
 * ----------------------------------------------------------------- */

async function run(): Promise<void> {
  const langs = FILES.map((f) => f.lang);
  console.log(`Translation integrity: ${langs.join(' <-> ')}`);

  // 1. Registry ↔ file consistency.
  const filesOnDisk = fs
    .readdirSync(I18N_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const registryErrors = registryConsistencyErrors(LANGUAGES, filesOnDisk);
  if (registryErrors.length) {
    for (const e of registryErrors) console.error(`  - ${e}`);
    assert(false, 'languages.ts registry is inconsistent with messages/ files');
  }
  console.log(
    `  ✓ registry ↔ files consistent (${langs.length} languages, ${filesOnDisk.length} files)`,
  );

  const sets = new Map<string, Set<string>>();
  const dups = new Map<string, string[]>();
  const loaded = new Map<string, Record<string, unknown>>();
  const loadedStrings = new Map<string, Record<string, string>>();
  const rawTrees = new Map<string, Record<string, unknown>>();

  for (const { lang, file } of FILES) {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const data = flattenLeaves(parsed);
    loaded.set(lang, data);
    loadedStrings.set(lang, data as Record<string, string>);
    rawTrees.set(lang, parsed);

    const keys = Object.keys(data);
    sets.set(lang, new Set(keys));

    const dupesRaw = findDuplicateKeys(raw);
    if (dupesRaw.length) dups.set(lang, dupesRaw);

    console.log(`  ${lang}.json: ${keys.length} leaf keys`);
  }

  if (dups.size) {
    console.error(`\nDuplicate keys detected in translation files:`);
    for (const [lang, dupList] of dups.entries()) {
      for (const d of dupList) console.error(`  - [${lang}] duplicate key: "${d}"`);
    }
    assert(false, 'duplicate keys found in translation JSON');
  }
  console.log('  ✓ no duplicate keys within translation files');

  const enKeys = sets.get('en');
  if (!enKeys) throw new Error('languages registry must include the canonical en locale');

  // 2. Nested leaf key parity — en.json is canonical. Fully maintained locales
  // must match it exactly; the others may lag (their missing keys render the
  // English text) but may never carry orphan keys.
  const parityErrors: string[] = [];
  for (const { lang } of FILES) {
    if (lang === 'en') continue;
    const errors = keyParityErrors(enKeys, sets.get(lang)!, lang);
    if (FULLY_MAINTAINED_LOCALES.has(lang)) {
      parityErrors.push(...errors);
    } else {
      parityErrors.push(...errors.filter((error) => !error.includes('] missing key: ')));
      const lagging =
        errors.length - errors.filter((error) => !error.includes('] missing key: ')).length;
      if (lagging > 0)
        console.log(`  · ${lang}: ${lagging} keys not yet translated (English shown)`);
    }
  }
  if (parityErrors.length) {
    console.error(`\nKey parity violations vs en.json (${parityErrors.length}):`);
    for (const e of parityErrors.slice(0, 100)) console.error(`  - ${e}`);
    if (parityErrors.length > 100) console.error(`  … and ${parityErrors.length - 100} more`);
    assert(false, 'translation key parity vs en.json violated');
  }
  console.log('  ✓ leaf key parity with en.json (en/th complete, no orphan keys anywhere)');

  // 3a. Structural leaf validation: only non-empty string leaves, no empty
  // objects / arrays / null / booleans / numbers anywhere.
  const structuralErrors: string[] = [];
  for (const { lang } of FILES) {
    structuralErrors.push(...findStructuralErrors(rawTrees.get(lang)!, lang));
  }
  if (structuralErrors.length) {
    console.error(`\nStructural leaf violations (${structuralErrors.length}):`);
    for (const e of structuralErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'non-string or empty leaves detected');
  }
  console.log(
    '  ✓ all leaves are non-empty strings (no empty objects/arrays/null/booleans/numbers)',
  );

  // 3b. Malformed string values (empty, JSON leftovers, unbalanced braces,
  // real newlines).
  const malformed: string[] = [];
  for (const { lang } of FILES) {
    malformed.push(...leafStringErrors(loaded.get(lang)!, lang));
  }
  if (malformed.length) {
    console.error(`\nMalformed translation values (${malformed.length}):`);
    for (const e of malformed.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'malformed translation values detected');
  }
  console.log('  ✓ no malformed values');

  // 4. ICU syntax validation across all locales.
  const icuErrors: string[] = [];
  for (const { lang } of FILES) {
    icuErrors.push(...icuSyntaxErrors(loadedStrings.get(lang)!, lang));
  }
  if (icuErrors.length) {
    console.error(`\nICU syntax errors (${icuErrors.length}):`);
    for (const e of icuErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'ICU syntax errors detected');
  }
  console.log('  ✓ all messages parse as valid ICU (plurals, selects, brackets)');

  // 5. ICU variable and placeholder parity vs en.json (args + selectors).
  const icuParity: string[] = [];
  for (const { lang } of FILES) {
    if (lang === 'en') continue;
    icuParity.push(...icuParityErrors(loadedStrings.get('en')!, loadedStrings.get(lang)!, lang));
  }
  if (icuParity.length) {
    console.error(`\nICU placeholder/selector mismatches vs en.json (${icuParity.length}):`);
    for (const e of icuParity.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'ICU placeholder parity vs en.json violated');
  }
  console.log('  ✓ placeholder arguments and plural/select selectors match en.json in all locales');

  // 6. Rich-text tag parity vs en.json.
  const tagParity: string[] = [];
  for (const { lang } of FILES) {
    if (lang === 'en') continue;
    tagParity.push(...tagParityErrors(loadedStrings.get('en')!, loadedStrings.get(lang)!, lang));
  }
  if (tagParity.length) {
    console.error(`\nRich-text tag mismatches vs en.json (${tagParity.length}):`);
    for (const e of tagParity.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'rich-text tag parity vs en.json violated');
  }
  console.log('  ✓ rich-text tags match en.json in all locales');

  // 7a. Every literal t('...') key used in the frontend is defined.
  const union = new Set<string>();
  for (const s of sets.values()) for (const k of s) union.add(k);
  const called = collectCalledKeys();
  const undefinedKeys = [...called].filter((k) => !union.has(k));
  if (undefinedKeys.length) {
    console.error(`\nKeys used in t() but missing from all locales (${undefinedKeys.length}):`);
    for (const k of undefinedKeys) console.error(`  - ${k}`);
    assert(false, 'untranslated t() keys referenced in the frontend');
  }
  console.log(`  ✓ no undefined keys (${called.size} literal t() calls covered)`);

  // 7b. No unsafe template-literal t(`prefix.${var}`) calls without an
  // exhaustively typed cast.
  const unsafe = collectUnsafeDynamicKeys();
  if (unsafe.length) {
    console.error(`\nUnsafe dynamic t() template-literal calls (${unsafe.length}):`);
    for (const u of unsafe) console.error(`  - ${u.file}:${u.line} — ${u.code}`);
    console.error(
      "  Add an exhaustively typed cast: t(`prefix.${var}` as 'prefix.a' | 'prefix.b')",
    );
    assert(false, 'unsafe dynamic translation keys found in the frontend');
  }
  console.log('  ✓ no unsafe template-literal t() calls (all dynamic keys exhaustively cast)');

  // 7c. No active frontend component may add a dependency on the bridge
  // scheduled for deletion in #381.
  const legacyErrors = legacyImportErrors();
  if (legacyErrors.length) {
    for (const e of legacyErrors) console.error(`  - ${e}`);
    assert(false, 'legacy i18n bridge imports found in active frontend source');
  }
  console.log('  ✓ no active frontend consumers import the legacy i18n bridge');

  // 7d. The use-intl AppConfig augmentation is wired (compile-time key checks).
  const dtsErrors = messagesDtsErrors();
  if (dtsErrors.length) {
    for (const e of dtsErrors) console.error(`  - ${e}`);
    assert(false, 'use-intl AppConfig augmentation broken');
  }
  console.log('  ✓ messages.d.ts AppConfig augmentation present (compile-time key checks active)');

  // 8. th.json values must be complete, NFC text without malformed characters.
  const thMessages = loadedStrings.get('th');
  if (!thMessages) throw new Error('languages registry must include the maintained th locale');
  const thErrors = thFallbackErrors(thMessages, loadedStrings.get('en')!);
  if (thErrors.length) {
    console.error(`\nth.json values with errors (${thErrors.length}):`);
    for (const e of thErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(
      false,
      'th.json contains untranslated, placeholder, non-NFC, or replacement-character values',
    );
  }
  assert(
    thMessages['receipt.cashReceived'] === 'รับเงิน',
    'th.json receipt.cashReceived must preserve the canonical cash-received label',
  );
  assert(
    thMessages['pos.tagVeg'] === 'มังสวิรัติ' && thMessages['products.tagVeg'] === 'มังสวิรัติ',
    'th.json vegetarian product tags must use the vegetarian Thai term, not an unrelated homograph',
  );
  assert(
    thMessages['pos.tagNonVeg'] === 'ไม่มังสวิรัติ' && thMessages['products.tagNonVeg'] === 'ไม่มังสวิรัติ',
    'th.json non-vegetarian product tags must negate the vegetarian Thai term',
  );
  assert(
    thMessages['orders.takeaway'] === thMessages['pos.orderTypeTakeaway'],
    'th.json takeaway labels must match the reviewed Thai pickup term',
  );
  assert(
    thMessages['dashboard.payIn'] === 'เติมเงิน' && thMessages['dashboard.payOut'] === 'จ่ายออก',
    'th.json cash-movement labels must match the Z-report terminology',
  );
  // The setup card only offers optional product-update and marketing opt-ins, so the
  // mandatory-notice clause must read "cannot be disabled" (ปิดไม่ได้), matching en.json.
  assert(
    thMessages['setup.emailCommunicationDescription'].includes('ปิดไม่ได้ในขั้นตอนนี้'),
    'th.json must tell Thai users that essential notices cannot be disabled at setup',
  );
  assert(
    !thMessages['setup.emailCommunicationDescription'].includes('ปิดได้ในขั้นตอนนี้'),
    'th.json must not tell Thai users that essential notices can be disabled at setup',
  );
  console.log(
    `  ✓ no untranslated th.json values (${TH_INTENTIONAL_IDENTICAL.size} intentional shared values; NFC verified)`,
  );

  // 9. No locale may weld an order number onto a word: a trailing "{number}"
  // glued to a letter reads as part of the word.
  const orderNumberErrors = orderNumberPlaceholderErrors(Object.fromEntries(loadedStrings));
  if (orderNumberErrors.length) {
    console.error(`\norder-number placeholder errors (${orderNumberErrors.length}):`);
    for (const e of orderNumberErrors.slice(0, 100)) console.error(`  - ${e}`);
    assert(false, 'an order-number placeholder is glued to a preceding word');
  }
  console.log(
    `  ✓ no locale welds an order number onto a word (${Object.keys(Object.fromEntries(loadedStrings)).length} locales checked)`,
  );

  console.log('\n✅ All translation integrity checks passed.');
}

/* ----------------------------------------------------------------- *
 * Negative tests — feed broken fixtures to each validator and       *
 * assert the failure mode is detected. A validator that stops       *
 * catching its class of bug fails CI here.                          *
 * ----------------------------------------------------------------- */

function expectDetected(name: string, errors: string[]): void {
  assert(errors.length > 0, `negative test "${name}" — validator failed to detect the violation`);
}

function runNegativeTests(): void {
  console.log('\nNegative tests (fixture-based):');

  // 1. Registry consistency.
  expectDetected(
    'registry: missing file for language',
    registryConsistencyErrors({ xx: { locale: 'xx', direction: 'ltr', selectable: true } }, [
      'en.json',
    ]),
  );
  expectDetected(
    'registry: orphan file without registry entry',
    registryConsistencyErrors({ en: { locale: 'en', direction: 'ltr', selectable: true } }, [
      'en.json',
      'zz.json',
    ]),
  );
  expectDetected(
    'registry: invalid BCP-47 locale',
    registryConsistencyErrors({ en: { locale: 'not a tag', direction: 'ltr', selectable: true } }, [
      'en.json',
    ]),
  );
  expectDetected(
    'registry: non-canonical BCP-47 locale',
    registryConsistencyErrors({ en: { locale: 'EN_us', direction: 'ltr', selectable: true } }, [
      'en.json',
    ]),
  );
  expectDetected(
    'registry: invalid direction',
    registryConsistencyErrors({ en: { locale: 'en', direction: 'sideways', selectable: true } }, [
      'en.json',
    ]),
  );

  // 2. Key parity: missing and orphan keys.
  expectDetected(
    'parity: missing key in locale',
    keyParityErrors(new Set(['a.b', 'a.c']), new Set(['a.b']), 'es'),
  );
  expectDetected(
    'parity: orphan extra key in locale',
    keyParityErrors(new Set(['a.b']), new Set(['a.b', 'a.zzz']), 'es'),
  );

  // 3. Leaf validity: non-string leaves, empty objects, arrays, malformed strings.
  expectDetected('leaf: numeric leaf', findStructuralErrors({ a: 42 }, 'es'));
  expectDetected('leaf: null leaf', findStructuralErrors({ a: null }, 'es'));
  expectDetected('leaf: empty object namespace', findStructuralErrors({ a: {} }, 'es'));
  expectDetected('leaf: array value', findStructuralErrors({ a: ['x'] }, 'es'));
  expectDetected('leaf: empty string', findStructuralErrors({ a: '   ' }, 'es'));
  expectDetected('leaf: trailing JSON artifact', leafStringErrors({ 'a.b': 'value",' }, 'es'));
  expectDetected('leaf: real newline', leafStringErrors({ 'a.b': 'line1\nline2' }, 'es'));
  expectDetected('leaf: unbalanced braces', leafStringErrors({ 'a.b': 'one { two' }, 'es'));
  expectDetected('leaf: duplicate keys', findDuplicateKeys('{"a": {"b": 1, "b": 2}}'));

  // 4. ICU syntax.
  expectDetected('icu: unclosed bracket', icuSyntaxErrors({ 'a.b': 'Hello {name' }, 'es'));
  expectDetected(
    'icu: plural missing other clause',
    icuSyntaxErrors({ 'a.b': '{count, plural, one {# item}}' }, 'es'),
  );
  expectDetected(
    'icu: select missing other clause',
    icuSyntaxErrors({ 'a.b': '{gender, select, male {He} female {She}}' }, 'es'),
  );

  // 5. Placeholder parity: renamed argument, and selector dropped/renamed.
  expectDetected(
    'icu parity: renamed placeholder arg',
    icuParityErrors({ 'a.b': 'Hello {count}' }, { 'a.b': 'Hola {total}' }, 'es'),
  );
  expectDetected(
    'icu parity: plural selector dropped',
    icuParityErrors(
      { 'a.b': '{count, plural, one {# item} other {# items}}' },
      { 'a.b': '{count} items' },
      'es',
    ),
  );
  expectDetected(
    'icu parity: plural selector renamed',
    icuParityErrors(
      { 'a.b': '{count, plural, one {# item} other {# items}}' },
      { 'a.b': '{total, plural, one {# item} other {# items}}' },
      'es',
    ),
  );

  // 6. Rich-text tag parity.
  expectDetected(
    'tag parity: renamed tag',
    tagParityErrors(
      { 'a.b': 'Click <bold>here</bold>' },
      { 'a.b': 'Click <link>aquí</link>' },
      'es',
    ),
  );
  expectDetected(
    'tag parity: dropped tag',
    tagParityErrors({ 'a.b': 'Click <bold>here</bold>' }, { 'a.b': 'Click here' }, 'es'),
  );
  expectDetected(
    'th: English-identical value',
    thFallbackErrors({ 'a.b': 'Same value' }, { 'a.b': 'Same value' }),
  );
  expectDetected(
    'th: placeholder prefix value',
    thFallbackErrors({ 'a.b': '[TH] Placeholder value' }, { 'a.b': 'Different value' }),
  );
  expectDetected(
    'th: Unicode replacement character',
    thFallbackErrors({ 'a.b': 'กา�แฟ' }, { 'a.b': 'กาแฟ' }),
  );
  expectDetected(
    'order number: placeholder welded to a preceding word',
    // Both keys are supplied so the only errors the validator can report are the
    // welds; a missing key would otherwise mask whether the weld was detected.
    orderNumberPlaceholderErrors({
      ne: {
        'pos.addingItemsToOrder': 'अर्डर # मा वस्तुहरू थप्दै{number}',
        'pos.itemsAddedToOrder': 'अर्डर # मा वस्तुहरू थपियो{number}',
      },
    }),
  );
  expectDetected(
    'order number: weld reported against the key that owns it',
    // One healthy key and one welded key, so the validator must identify the
    // welded one rather than merely reporting that some weld exists.
    orderNumberPlaceholderErrors({
      en: {
        'pos.addingItemsToOrder': 'Adding items to order #{number}',
        'pos.itemsAddedToOrder': 'Items added to order{number}',
      },
    }).filter((error) => error.includes('pos.itemsAddedToOrder')),
  );
  expectDetected(
    'order number: every occurrence is checked, not only the first',
    // Both keys carry a correctly introduced occurrence, so the only error the
    // validator can report is the weld on the second {number}. Checking only
    // the first occurrence finds nothing and this fixture fails. Argument-name
    // parity cannot catch it, because both are named {number}.
    orderNumberPlaceholderErrors({
      en: {
        'pos.addingItemsToOrder': 'Adding items to order #{number} and again{number}',
        'pos.itemsAddedToOrder': 'Items added to order #{number}',
      },
    }),
  );
  // A space before {number} is legitimate (Persian and Arabic use
  // "شماره {number}"), so only a letter or combining mark is a violation.
  // There is deliberately no "missing separator" fixture: that case is healthy
  // and asserting it would contradict the validator's actual contract.
  expectDetected(
    'order number: key missing from a locale',
    orderNumberPlaceholderErrors({
      en: { 'pos.addingItemsToOrder': 'Adding items to order #{number}' },
    }),
  );
  expectDetected(
    'order number: placeholder entirely absent',
    orderNumberPlaceholderErrors({
      en: { 'pos.addingItemsToOrder': 'Adding items to order', 'pos.itemsAddedToOrder': 'Added' },
    }),
  );
  assert(
    orderNumberPlaceholderErrors({
      en: {
        'pos.addingItemsToOrder': 'Adding items to order #{number}',
        'pos.itemsAddedToOrder': 'Items added to order #{number}',
      },
      ne: {
        'pos.addingItemsToOrder': 'अर्डर #{number} मा वस्तुहरू थप्दैछन्',
        'pos.itemsAddedToOrder': 'अर्डर #{number} मा वस्तुहरू थपियो',
      },
      ru: {
        'pos.addingItemsToOrder': 'Добавление товаров в заказ №{number}',
        'pos.itemsAddedToOrder': 'Товары добавлены в заказ №{number}',
      },
      fa: {
        'pos.addingItemsToOrder': 'در حال افزودن کالاها به سفارش شماره {number}',
        'pos.itemsAddedToOrder': 'کالاها به سفارش شماره {number} افزوده شدند',
      },
      te: {
        'pos.addingItemsToOrder': 'ఆర్డర్ #{number} కు ఐటెమ్లు జోడించబడుతున్నాయి',
        'pos.itemsAddedToOrder': 'ఆర్డర్ #{number} కు ఐటెమ్లు జోడించబడ్డాయి',
      },
    }).length === 0,
    'order-number validator must not flag healthy English, Nepali, Russian, Persian, or Telugu values',
  );

  // 8. TypeScript key safety.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'i18n-negative-'));
  try {
    fs.writeFileSync(
      path.join(tmp, 'fixture.ts'),
      [
        "const bad = t('does.not.exist');",
        "const tPos = useTranslations('pos');",
        "const badScoped = tPos('doesNotExistScoped');",
        'const unsafe = t(`prefix.${value}`);',
        "const safe = t(`prefix.${value}` as 'prefix.a' | 'prefix.b');",
        "import { useI18n } from '@/hooks/useI18n';",
        "const legacyPlural = formatIcuPlural('items', 5);",
      ].join('\n'),
    );

    const called = collectCalledKeys(tmp);
    expectDetected(
      'ts: invalid literal key',
      [...called].filter((k) => !new Set(['prefix.a', 'prefix.b']).has(k)),
    );

    const unsafe = collectUnsafeDynamicKeys(tmp);
    expectDetected(
      'ts: unsafe template-literal t() call',
      unsafe.map((u) => u.code),
    );
    expectDetected('ts: legacy i18n bridge import', legacyImportErrors(tmp));
    const flaggedLines = unsafe.map((u) => u.line);
    assert(
      flaggedLines.length === 1 && flaggedLines[0] === 4,
      `ts: exhaustively cast dynamic key must NOT be flagged (flagged lines: ${flaggedLines.join(',')})`,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('  ✓ all negative fixtures detected by their validators');
}

async function main(): Promise<void> {
  await run();
  runNegativeTests();
  console.log('\n✅ All translation integrity checks + negative tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
