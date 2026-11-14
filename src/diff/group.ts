import type { BreakingChange, ChangeGroup } from '../types.js';

function keyOf(c: BreakingChange): string {
  if (c.schema === undefined) return c.id;
  return [c.kind, c.schema, c.before ?? '', c.after ?? '', (c.values ?? []).join(',')].join('|');
}

/** Fold changes that share a root cause into one group each. */
export function groupChanges(changes: BreakingChange[]): ChangeGroup[] {
  const out: ChangeGroup[] = [];
  const bySchemaKey = new Map<string, ChangeGroup>();
  for (const c of changes) {
    const key = keyOf(c);
    // Only schema-backed changes fold. One without a schema is always its own group.
    const existing = c.schema === undefined ? undefined : bySchemaKey.get(key);
    if (existing !== undefined) {
      existing.changes.push(c);
      continue;
    }
    const group: ChangeGroup = {
      key,
      kind: c.kind,
      severity: c.severity,
      ...(c.schema !== undefined ? { schema: c.schema } : {}),
      changes: [c],
    };
    out.push(group);
    if (c.schema !== undefined) bySchemaKey.set(key, group);
  }
  return out;
}
