import type { BreakingChange, ImpactOptions, ImpactSignal, ImpactSite } from '../types.js';
import { isCommonName, isDistinctiveName, matchFieldAccess, matchName, nameVariants } from './names.js';
import { matchPaths } from './path-match.js';

export type ScanContext = { options: ImpactOptions; repoHasCorroboration: boolean };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isCorroborated(text: string, options: ImpactOptions): boolean {
  const lower = text.toLowerCase();
  for (const h of options.hosts ?? []) {
    if (h.length > 0 && lower.includes(h.toLowerCase())) return true;
  }
  for (const pkg of options.sdkPackages ?? []) {
    if (pkg.length === 0) continue;
    const p = escapeRe(pkg);
    const patterns = [
      `(?:from|import)\\s*['"]${p}(?:/[^'"]*)?['"]`,
      `require\\(\\s*['"]${p}(?:/[^'"]*)?['"]\\s*\\)`,
      `^[ \\t]*import[ \\t]+${p}(?![\\w])`,
      `^[ \\t]*from[ \\t]+${p}(?:\\.[\\w.]+)?[ \\t]+import\\b`,
    ];
    if (new RegExp(patterns.join('|'), 'm').test(text)) return true;
  }
  return false;
}

const METHOD_WORDS = /\b(get|post|put|patch|delete|head|options)\b/gi;
const SIGNAL_RANK: Record<ImpactSignal, number> = { path: 3, operationId: 2, field: 1 };

function finish(score: number): number {
  return Math.round(Math.min(0.95, Math.max(0.05, score)) * 100) / 100;
}

function pascal(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Acc = { signal: ImpactSignal; confidence: number; ids: Set<string> };

export function scanFile(
  file: string,
  text: string,
  changes: BreakingChange[],
  ctx: ScanContext,
): ImpactSite[] {
  if (changes.length === 0) return [];
  const { options } = ctx;
  const corro: 'neutral' | 'yes' | 'no' = !ctx.repoHasCorroboration
    ? 'neutral'
    : isCorroborated(text, options)
      ? 'yes'
      : 'no';
  const templates = options.allPaths ?? [...new Set(changes.map((c) => c.path))];
  const lines = text.split(/\r?\n/);
  const acc = new Map<number, Acc>();

  const add = (idx: number, signal: ImpactSignal, score: number, id: string): void => {
    const conf = finish(score);
    const cur = acc.get(idx);
    if (!cur) {
      acc.set(idx, { signal, confidence: conf, ids: new Set([id]) });
      return;
    }
    cur.ids.add(id);
    if (conf > cur.confidence) cur.confidence = conf;
    if (SIGNAL_RANK[signal] > SIGNAL_RANK[cur.signal]) cur.signal = signal;
  };

  // Pass 1: path signal.
  const pathChanges = new Set<string>();
  const methodLower = (c: BreakingChange): string => c.method.toLowerCase();
  const byPath = new Map<string, BreakingChange[]>();
  for (const c of changes) {
    const list = byPath.get(c.path);
    if (list) list.push(c);
    else byPath.set(c.path, [c]);
  }
  const lineHasMethod = new Map<string, boolean[]>();
  const nearMethod = (method: string, idx: number): boolean => {
    let cache = lineHasMethod.get(method);
    if (!cache) {
      const re = new RegExp(`\\b${method}\\b`, 'i');
      cache = lines.map((l) => re.test(l));
      lineHasMethod.set(method, cache);
    }
    for (let j = Math.max(0, idx - 2); j <= Math.min(lines.length - 1, idx + 2); j++) {
      if (cache[j]) return true;
    }
    return false;
  };
  lines.forEach((line, idx) => {
    if (line.trim() === '') return;
    const hits = matchPaths(line, templates);
    if (hits.length === 0) return;
    const words = (line.match(METHOD_WORDS) ?? []).map((w) => w.toLowerCase());
    for (const hit of hits) {
      for (const c of byPath.get(hit.template) ?? []) {
        if (words.length > 0 && !words.includes(methodLower(c))) continue;
        let score = hit.matchedStatic >= 3 ? 0.8 : hit.matchedStatic === 2 ? 0.65 : 0.5;
        if (hit.droppedStatic > 0) score -= 0.1;
        if (corro === 'yes') score += 0.15;
        else if (corro === 'no') score -= 0.2;
        if (nearMethod(c.method, idx)) score += 0.05;
        add(idx, 'path', score, c.id);
        pathChanges.add(c.id);
      }
    }
  });

  // Pass 2: operationId and field signals.
  const opChanges = changes
    .filter((c) => c.operationId !== undefined && c.operationId.length >= 6)
    .map((c) => {
      const v = nameVariants(c.operationId ?? '');
      // PascalCase of every variant that has no separators (not of the snake form).
      const pascals = v.filter((s) => !/[_-]/.test(s)).map(pascal);
      return { id: c.id, variants: [...new Set([...v, ...pascals])].filter((s) => s !== '') };
    });
  const fieldChanges = changes
    .filter((c) => c.name !== undefined)
    .map((c) => ({ id: c.id, variants: nameVariants(c.name ?? '') }))
    .filter((f) => f.variants.length > 0);

  // Group by variant list so each distinct name is matched once per line.
  type NameGroup = { variants: string[]; ids: string[] };
  const groupBy = (items: { id: string; variants: string[] }[]): NameGroup[] => {
    const m = new Map<string, NameGroup>();
    for (const it of items) {
      const key = it.variants.join('\u0000');
      const g = m.get(key);
      if (g) g.ids.push(it.id);
      else m.set(key, { variants: it.variants, ids: [it.id] });
    }
    return [...m.values()];
  };
  const opGroups = groupBy(opChanges);
  const fieldGroups = groupBy(fieldChanges).map((g) => {
    const lead = g.variants[0] ?? '';
    // The value is often consumed far from the HTTP call, in a file that
    // never names the API. In a repo known to use it, a distinctive name
    // must still clear the default reporting threshold.
    let fallback: number | null = null;
    if (corro !== 'yes' && !isCommonName(lead)) {
      fallback = ctx.repoHasCorroboration && isDistinctiveName(lead) ? 0.35 : 0.2;
    }
    return { ...g, fallback };
  });
  const opScore = corro === 'yes' ? 0.6 : 0.35;

  lines.forEach((line, idx) => {
    if (line.trim() === '') return;
    for (const o of opGroups) {
      if (!matchName(line, o.variants)) continue;
      for (const id of o.ids) add(idx, 'operationId', opScore, id);
    }
    for (const f of fieldGroups) {
      if (!matchFieldAccess(line, f.variants)) continue;
      for (const id of f.ids) {
        let score: number | null;
        if (pathChanges.has(id)) score = 0.7;
        else if (corro === 'yes') score = 0.4;
        else score = f.fallback;
        if (score !== null) add(idx, 'field', score, id);
      }
    }
  });

  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([idx, a]) => ({
      file,
      line: idx + 1,
      snippet: (lines[idx] ?? '').trim().slice(0, 200),
      signal: a.signal,
      changeIds: [...a.ids].sort(),
      confidence: a.confidence,
    }));
}
