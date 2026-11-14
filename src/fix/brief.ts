import type { BreakingChange, ChangeGroup, ImpactSite } from '../types.js';
import { groupChanges } from '../diff/group.js';

const DEFAULT_MAX_SITES = 60;

const tick = (s: string): string => s.replace(/`/g, "'");

function suffix(c: BreakingChange): string {
  if (c.before !== undefined && c.after !== undefined) return ` (${c.before} → ${c.after})`;
  if (c.values !== undefined && c.values.length > 0) return ` (values: ${c.values.join(', ')})`;
  return '';
}

function describe(c: BreakingChange): string {
  if (c.kind === 'endpoint-removed') return 'endpoint removed';
  const name = c.name === undefined ? '' : ` \`${tick(c.name)}\``;
  if (c.in === 'query' || c.in === 'header' || c.in === 'cookie') return `${c.in} parameter${name}`;
  if (c.in === 'request') return `request field${name}`;
  if (c.in === 'response') return `response${c.status === undefined ? '' : ` ${c.status}`} field${name}`;
  return `${c.kind}${name}`;
}

function groupText(g: ChangeGroup): string {
  const first = g.changes[0];
  if (first === undefined) return '';
  if (g.schema !== undefined) {
    const dot = g.schema.indexOf('.');
    const comp = dot < 0 ? g.schema : g.schema.slice(0, dot);
    const field = dot < 0 ? '' : `, field \`${tick(g.schema.slice(dot + 1))}\``;
    const ops = [...new Set(g.changes.map((c) => `${c.method} ${c.path}`))];
    const shown = ops.slice(0, 5).join(', ');
    const more = ops.length > 5 ? ` (+${ops.length - 5} more)` : '';
    const noun = ops.length === 1 ? 'operation' : 'operations';
    return `schema \`${tick(comp)}\`${field}${suffix(first)}; in ${ops.length} ${noun}: ${shown}${more}`;
  }
  const opId = first.operationId !== undefined && first.operationId !== '' ? ` (operationId: ${first.operationId})` : '';
  return `${first.method} ${first.path}${opId}: ${describe(first)}${suffix(first)}`;
}

function changesSection(groups: ChangeGroup[]): string[] {
  return [
    '## Breaking changes',
    '',
    ...groups.map((g, i) => `${i + 1}. [${g.severity}] ${g.kind} — ${groupText(g)}`),
  ];
}

function sitesSection(
  groups: ChangeGroup[],
  sites: ImpactSite[],
  maxSites: number,
): string[] {
  const out: string[] = ['## Candidate sites', ''];
  if (sites.length === 0) {
    out.push('No candidate sites were found by search.');
    return out;
  }
  out.push('These come from a text search and include false positives. Verify each one.');

  const numberById = new Map<string, number>();
  groups.forEach((g, i) => {
    for (const c of g.changes) if (!numberById.has(c.id)) numberById.set(c.id, i + 1);
  });

  const shown = sites.slice(0, maxSites);
  const byFile = new Map<string, string[]>();
  for (const s of shown) {
    const nums = [...new Set(s.changeIds.map((id) => numberById.get(id)).filter((n): n is number => n !== undefined))]
      .sort((a, b) => a - b);
    const ref = nums.length > 0 ? ` changes ${nums.join(', ')}` : '';
    const snippet = tick(s.snippet).replace(/[\r\n]+/g, ' ');
    const line = `- line ${s.line} (${s.signal}, ${s.confidence.toFixed(2)})${ref}: \`${snippet}\``;
    const list = byFile.get(s.file);
    if (list === undefined) byFile.set(s.file, [line]);
    else list.push(line);
  }
  for (const [file, lines] of byFile) out.push('', `### ${file}`, ...lines);
  if (sites.length > shown.length) out.push('', `(${sites.length - shown.length} more sites omitted)`);
  return out;
}

export function buildBrief(
  changes: BreakingChange[],
  sites: ImpactSite[],
  options?: { maxSites?: number; onlyGroupsWithSites?: boolean },
): string {
  const rawMax = options?.maxSites ?? DEFAULT_MAX_SITES;
  const maxSites = Number.isFinite(rawMax) ? Math.max(0, Math.floor(rawMax)) : DEFAULT_MAX_SITES;
  const all = groupChanges(changes);
  let groups = all;
  if (options?.onlyGroupsWithSites === true) {
    const touched = new Set(sites.flatMap((s) => s.changeIds));
    groups = all.filter((g) => g.changes.some((c) => touched.has(c.id)));
  }
  const omitted = all.length - groups.length;
  const note =
    omitted > 0
      ? ['', `(${omitted} other changes have no candidate site in this repository and are not listed.)`]
      : [];
  return [...changesSection(groups), ...note, '', ...sitesSection(groups, sites, maxSites)].join('\n');
}
