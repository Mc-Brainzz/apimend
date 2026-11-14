import type { BreakingChange, ChangeGroup, ImpactSite } from '../types.js';
import { groupChanges } from '../diff/group.js';

function location(c: BreakingChange): string {
  const parts: string[] = [];
  if (c.in !== undefined) parts.push(c.in);
  if (c.status !== undefined) parts.push(c.status);
  if (c.name !== undefined) parts.push(c.name);
  return parts.join(' ');
}

function suffix(c: BreakingChange): string {
  if (c.before !== undefined || c.after !== undefined) {
    return ` (${c.before ?? ''} → ${c.after ?? ''})`;
  }
  if (c.values !== undefined && c.values.length > 0) return ` (${c.values.join(', ')})`;
  return '';
}

function groupText(g: ChangeGroup): string {
  const first = g.changes[0];
  if (first === undefined) return '';
  if (g.schema !== undefined) {
    const ops = new Set(g.changes.map((c) => `${c.method} ${c.path}`)).size;
    return `${g.schema}${suffix(first)}  (${ops} ${ops === 1 ? 'operation' : 'operations'})`;
  }
  const loc = location(first);
  return `${first.method} ${first.path}${loc === '' ? '' : `  ${loc}`}${suffix(first)}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function formatChanges(changes: BreakingChange[]): string {
  if (changes.length === 0) return 'No breaking changes.';
  const groups = groupChanges(changes);
  const lines = groups.map((g) => `${`[${g.severity}]`.padEnd(10)} ${g.kind}  ${groupText(g)}`);
  const breaking = groups.filter((g) => g.severity === 'breaking').length;
  const warnings = groups.length - breaking;
  let summary = `${breaking} breaking, ${plural(warnings, 'warning')}`;
  if (groups.length < changes.length) {
    summary += ` (${groups.length} groups from ${changes.length} changes)`;
  }
  lines.push('', summary);
  return lines.join('\n');
}

export function formatSites(sites: ImpactSite[]): string {
  if (sites.length === 0) return 'No affected code found.';
  const lines: string[] = [];
  let current: string | undefined;
  for (const s of sites) {
    if (s.file !== current) {
      if (current !== undefined) lines.push('');
      lines.push(s.file);
      current = s.file;
    }
    lines.push(`  L${s.line}  ${s.confidence.toFixed(2)}  ${s.signal.padEnd(11)}  ${s.snippet}`);
  }
  return lines.join('\n');
}
