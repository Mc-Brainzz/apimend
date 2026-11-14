/** Identifier-name helpers for impact scanning. */

const COMMON_NAMES = new Set([
  'id', 'ids', 'name', 'type', 'data', 'status', 'value', 'values', 'items',
  'object', 'url', 'code', 'error', 'message', 'created', 'updated', 'result',
  'results', 'count', 'key', 'text', 'title', 'description',
]);

function leafOf(name: string): string {
  const dot = name.lastIndexOf('.');
  let leaf = dot >= 0 ? name.slice(dot + 1) : name;
  while (leaf.endsWith('[]')) leaf = leaf.slice(0, -2);
  return leaf;
}

function toCamel(s: string): string {
  // Go through snake_case so PascalCase input ("RetrieveThing") also lands on
  // lower camel ("retrieveThing").
  const parts = toSnake(s)
    .split('_')
    .filter((p) => p.length > 0);
  if (parts.length === 0) return s;
  return parts
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('');
}

function toSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/-+/g, '_')
    .toLowerCase();
}

/** `[as written, camelCase, snake_case]` of the leaf of a field path, de-duplicated. */
export function nameVariants(name: string): string[] {
  const leaf = leafOf(name);
  if (leaf.length === 0) return [];
  const out = [leaf, toCamel(leaf), toSnake(leaf)];
  return out.filter((v, i) => out.indexOf(v) === i);
}

export function isCommonName(leaf: string): boolean {
  return leaf.length < 5 || COMMON_NAMES.has(leaf.toLowerCase());
}

/**
 * A multi-word or long name ("customer_email", "latestCharge") is unlikely to
 * appear in a repo by coincidence, so a bare mention is worth more.
 */
export function isDistinctiveName(leaf: string): boolean {
  if (isCommonName(leaf)) return false;
  return /[_-]/.test(leaf) || /[a-z][A-Z]/.test(leaf) || leaf.length >= 10;
}

const accessPatterns = new Map<string, RegExp>();

function accessPattern(variant: string): RegExp {
  let re = accessPatterns.get(variant);
  if (re === undefined) {
    const n = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const end = '(?![A-Za-z0-9_$])';
    const q = '[\'"`]';
    re = new RegExp(
      [
        `\\.\\s*${n}${end}`, // obj.name, obj?.name
        `\\[\\s*${q}${n}${q}\\s*\\]`, // obj["name"]
        `\\.get\\(\\s*${q}${n}${q}`, // obj.get("name")
        `${q}${n}${q}\\s*:`, // "name": value
        `(?<![A-Za-z0-9_$.'"\`])${n}\\??\\s*(?::(?!:)|=(?![=>]))`, // name: value, name=value
        `[{,]\\s*${n}\\s*[,}]`, // { name }, { a, name }
      ].join('|'),
    );
    accessPatterns.set(variant, re);
  }
  return re;
}

/**
 * True when a variant is used as a field on the line: read off an object,
 * used as a key or keyword argument, or destructured. A bare mention in prose
 * or as a string value ("mode: 'subscription'") does not count — on a real
 * repo those outnumbered true uses by more than ten to one.
 */
export function matchFieldAccess(line: string, variants: string[]): boolean {
  for (const v of variants) {
    if (v.length > 0 && line.includes(v) && accessPattern(v).test(line)) return true;
  }
  return false;
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/** True when any variant occurs as a whole identifier on the line. */
export function matchName(line: string, variants: string[]): boolean {
  for (const v of variants) {
    if (v.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = line.indexOf(v, from);
      if (at < 0) break;
      if (!isIdentChar(line[at - 1]) && !isIdentChar(line[at + v.length])) return true;
      from = at + 1;
    }
  }
  return false;
}
