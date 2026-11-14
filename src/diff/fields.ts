import type { BreakingChange, FieldInfo } from '../types.js';
import { makeChange } from './change.js';
import type { OpCtx } from './change.js';

function isUnder(path: string, ancestor: string): boolean {
  return path.startsWith(ancestor + '.') || path.startsWith(ancestor + '[]');
}

function parentOf(path: string): string {
  if (path.endsWith('[]')) return path.slice(0, -2);
  const i = path.lastIndexOf('.');
  return i < 0 ? '' : path.slice(0, i);
}

function sch(f: FieldInfo): { schema?: string } {
  return f.origin !== undefined ? { schema: f.origin } : {};
}

function missing(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return a.filter((v) => !set.has(v));
}

function typeDiffers(a: FieldInfo, b: FieldInfo): boolean {
  // 'any' and 'union' are not comparable: integer -> anyOf[integer, enum] is a
  // widening, and telling that apart from a real change needs the branches.
  const opaque = (t: string): boolean => t === 'any' || t === 'union';
  return a.type !== b.type && !opaque(a.type) && !opaque(b.type);
}

/** Compare request-body fields of one operation. */
export function compareRequest(
  ctx: OpCtx,
  oldF: Map<string, FieldInfo>,
  newF: Map<string, FieldInfo>,
  out: BreakingChange[],
): void {
  const skip: string[] = [];
  for (const [name, o] of oldF) {
    if (skip.some((s) => isUnder(name, s))) continue;
    const n = newF.get(name);
    if (n === undefined) {
      skip.push(name);
      out.push(makeChange(ctx, 'request-field-removed', 'warning',
        `Request field "${name}" was removed`, { in: 'request', name, ...sch(o) }));
      continue;
    }
    if (typeDiffers(o, n)) {
      skip.push(name);
      out.push(makeChange(ctx, 'request-field-type-changed', 'breaking',
        `Request field "${name}" changed type from ${o.type} to ${n.type}`,
        { in: 'request', name, before: o.type, after: n.type, ...sch(o) }));
    }
    if (o.enum !== undefined && n.enum !== undefined) {
      const values = missing(o.enum, n.enum);
      if (values.length > 0) {
        out.push(makeChange(ctx, 'request-enum-value-removed', 'breaking',
          `Request field "${name}" no longer accepts: ${values.join(', ')}`,
          { in: 'request', name, values, ...sch(o) }));
      }
    }
  }
  for (const [name, n] of newF) {
    if (!n.required || name.endsWith('[]')) continue;
    if (skip.some((s) => isUnder(name, s))) continue;
    const o = oldF.get(name);
    if (o !== undefined && o.required) continue;
    if (o === undefined) {
      const parent = parentOf(name);
      if (parent !== '' && !oldF.has(parent)) continue;
    }
    out.push(makeChange(ctx, 'request-field-required-added', 'breaking',
      `Request field "${name}" is now required`, { in: 'request', name, ...sch(n) }));
  }
}

/** Compare response-body fields of one operation and status code. */
export function compareResponse(
  ctx: OpCtx,
  status: string,
  oldF: Map<string, FieldInfo>,
  newF: Map<string, FieldInfo>,
  out: BreakingChange[],
): void {
  const skip: string[] = [];
  for (const [name, o] of oldF) {
    if (skip.some((s) => isUnder(name, s))) continue;
    const n = newF.get(name);
    if (n === undefined) {
      skip.push(name);
      out.push(makeChange(ctx, 'response-field-removed', 'breaking',
        `Response field "${name}" (${status}) was removed`,
        { in: 'response', status, name, ...sch(o) }));
      continue;
    }
    if (typeDiffers(o, n)) {
      skip.push(name);
      out.push(makeChange(ctx, 'response-field-type-changed', 'breaking',
        `Response field "${name}" (${status}) changed type from ${o.type} to ${n.type}`,
        { in: 'response', status, name, before: o.type, after: n.type, ...sch(o) }));
    }
    if (o.required && !o.nullable && (!n.required || n.nullable)) {
      out.push(makeChange(ctx, 'response-field-became-optional', 'warning',
        `Response field "${name}" (${status}) may now be absent or null`,
        { in: 'response', status, name, ...sch(o) }));
    }
    if (o.enum !== undefined && n.enum !== undefined) {
      const values = missing(n.enum, o.enum);
      if (values.length > 0) {
        out.push(makeChange(ctx, 'response-enum-value-added', 'warning',
          `Response field "${name}" (${status}) may now return: ${values.join(', ')}`,
          { in: 'response', status, name, values, ...sch(o) }));
      }
    }
  }
}
