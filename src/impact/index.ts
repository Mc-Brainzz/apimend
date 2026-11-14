import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BreakingChange, ImpactOptions, ImpactSite } from '../types.js';
import { listSourceFiles } from './files.js';
import { isCorroborated, scanFile } from './scan.js';

function cmp(a: ImpactSite, b: ImpactSite): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

export async function findImpact(
  repoDir: string,
  changes: BreakingChange[],
  options: ImpactOptions = {},
): Promise<ImpactSite[]> {
  if (changes.length === 0) return [];

  const files = await listSourceFiles(repoDir);
  const texts: Array<{ file: string; text: string }> = [];
  for (const file of files) {
    try {
      texts.push({ file, text: await readFile(path.join(repoDir, file), 'utf8') });
    } catch {
      // unreadable file: skip
    }
  }

  const repoHasCorroboration = texts.some((t) => isCorroborated(t.text, options));
  const ctx = { options, repoHasCorroboration };
  const all: ImpactSite[] = [];
  for (const t of texts) all.push(...scanFile(t.file, t.text, changes, ctx));

  const cap = options.maxSitesPerChange ?? 40;
  const keep = new Map<ImpactSite, Set<string>>();
  for (const change of changes) {
    const top = all
      .filter((s) => s.changeIds.includes(change.id))
      .sort(cmp)
      .slice(0, Math.max(0, cap));
    for (const s of top) {
      const set = keep.get(s) ?? new Set<string>();
      set.add(change.id);
      keep.set(s, set);
    }
  }

  const result: ImpactSite[] = [];
  for (const s of all) {
    const ids = keep.get(s);
    if (!ids) continue;
    result.push({ ...s, changeIds: s.changeIds.filter((id) => ids.has(id)) });
  }
  return result.sort(cmp);
}
