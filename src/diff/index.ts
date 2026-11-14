import type { BreakingChange, HttpMethod, OpenAPIDoc, SchemaObject } from '../types.js';
import { isRecord, resolveRef } from '../spec/resolve.js';
import { flattenSchema, typeOf } from './flatten.js';
import { makeChange } from './change.js';
import type { OpCtx } from './change.js';
import { compareRequest, compareResponse } from './fields.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'] as const;
const MEDIA_PREFERENCE = ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'];

type Operation = {
  path: string;
  method: HttpMethod;
  pathItem: Record<string, unknown>;
  op: Record<string, unknown>;
};
type Param = { in: 'query' | 'header' | 'cookie'; name: string; required: boolean; type: string };

function normalisePath(path: string): string {
  const p = path.replace(/\{[^}]*\}/g, '{}');
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

function collectOperations(doc: OpenAPIDoc): Map<string, Operation> {
  const out = new Map<string, Operation>();
  const paths: unknown = doc.paths;
  if (!isRecord(paths)) return out;
  for (const [path, rawItem] of Object.entries(paths)) {
    const pathItem = resolveRef(doc, rawItem);
    if (!isRecord(pathItem)) continue;
    for (const m of METHODS) {
      const op = pathItem[m];
      if (!isRecord(op)) continue;
      const method = m.toUpperCase() as HttpMethod;
      const key = `${method} ${normalisePath(path)}`;
      if (!out.has(key)) out.set(key, { path, method, pathItem, op });
    }
  }
  return out;
}

function effectiveParams(doc: OpenAPIDoc, o: Operation): Map<string, Param> {
  const out = new Map<string, Param>();
  for (const list of [o.pathItem['parameters'], o.op['parameters']]) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const p = resolveRef(doc, raw);
      if (!isRecord(p)) continue;
      const where = p['in'];
      const rawName = p['name'];
      if (typeof rawName !== 'string') continue;
      if (where !== 'query' && where !== 'header' && where !== 'cookie') continue;
      const name = where === 'header' ? rawName.toLowerCase() : rawName;
      out.set(`${where}:${name}`, {
        in: where,
        name,
        required: p['required'] === true,
        type: typeOf(doc, p['schema']),
      });
    }
  }
  return out;
}

function compareParams(
  ctx: OpCtx,
  oldP: Map<string, Param>,
  newP: Map<string, Param>,
  out: BreakingChange[],
): void {
  for (const [key, o] of oldP) {
    const n = newP.get(key);
    if (n === undefined) {
      out.push(makeChange(ctx, 'param-removed', 'warning',
        `${o.in} parameter "${o.name}" was removed`, { in: o.in, name: o.name }));
    } else if (
      o.type !== n.type &&
      ![o.type, n.type].some((t) => t === 'any' || t === 'union')
    ) {
      out.push(makeChange(ctx, 'param-type-changed', 'breaking',
        `${o.in} parameter "${o.name}" changed type from ${o.type} to ${n.type}`,
        { in: o.in, name: o.name, before: o.type, after: n.type }));
    }
  }
  for (const [key, n] of newP) {
    if (!n.required || oldP.get(key)?.required === true) continue;
    out.push(makeChange(ctx, 'param-required-added', 'breaking',
      `${n.in} parameter "${n.name}" is now required`, { in: n.in, name: n.name }));
  }
}

function pickMedia(content: Record<string, unknown>): string | undefined {
  for (const m of MEDIA_PREFERENCE) if (m in content) return m;
  return Object.keys(content)[0];
}

function contentOf(doc: OpenAPIDoc, holder: unknown): Record<string, unknown> | undefined {
  const r = resolveRef(doc, holder);
  if (!isRecord(r)) return undefined;
  const c = resolveRef(doc, r['content']);
  return isRecord(c) ? c : undefined;
}

function schemaOf(entry: unknown): SchemaObject | undefined {
  return isRecord(entry) && isRecord(entry['schema']) ? entry['schema'] : undefined;
}

/** Schemas for the media type picked from the old content, if new has it too. */
function pairedSchemas(
  oldC: Record<string, unknown> | undefined,
  newC: Record<string, unknown> | undefined,
): { oldS: SchemaObject | undefined; newS: SchemaObject | undefined } | undefined {
  if (oldC === undefined || newC === undefined) return undefined;
  const media = pickMedia(oldC);
  if (media === undefined || !(media in newC)) return undefined;
  return { oldS: schemaOf(oldC[media]), newS: schemaOf(newC[media]) };
}

function compareBodies(
  oldDoc: OpenAPIDoc,
  newDoc: OpenAPIDoc,
  ctx: OpCtx,
  oldOp: Record<string, unknown>,
  newOp: Record<string, unknown>,
  out: BreakingChange[],
): void {
  const req = pairedSchemas(
    contentOf(oldDoc, oldOp['requestBody']),
    contentOf(newDoc, newOp['requestBody']),
  );
  if (req !== undefined) {
    compareRequest(ctx, flattenSchema(oldDoc, req.oldS), flattenSchema(newDoc, req.newS), out);
  }
  const oldR = resolveRef(oldDoc, oldOp['responses']);
  const newR = resolveRef(newDoc, newOp['responses']);
  if (!isRecord(oldR) || !isRecord(newR)) return;
  for (const status of Object.keys(oldR)) {
    if (!status.startsWith('2') || !(status in newR)) continue;
    const res = pairedSchemas(contentOf(oldDoc, oldR[status]), contentOf(newDoc, newR[status]));
    if (res === undefined) continue;
    compareResponse(ctx, status, flattenSchema(oldDoc, res.oldS), flattenSchema(newDoc, res.newS), out);
  }
}

/** List the breaking changes between two OpenAPI documents. */
export function diffSpecs(oldDoc: OpenAPIDoc, newDoc: OpenAPIDoc): BreakingChange[] {
  const oldOps = collectOperations(oldDoc);
  const newOps = collectOperations(newDoc);
  const found: BreakingChange[] = [];
  for (const [key, o] of oldOps) {
    const opId = o.op['operationId'];
    const ctx: OpCtx = {
      method: o.method,
      path: o.path,
      ...(typeof opId === 'string' ? { operationId: opId } : {}),
    };
    const n = newOps.get(key);
    if (n === undefined) {
      found.push(makeChange(ctx, 'endpoint-removed', 'breaking', 'endpoint was removed'));
      continue;
    }
    compareParams(ctx, effectiveParams(oldDoc, o), effectiveParams(newDoc, n), found);
    compareBodies(oldDoc, newDoc, ctx, o.op, n.op, found);
  }
  const unique = new Map<string, BreakingChange>();
  for (const c of found) if (!unique.has(c.id)) unique.set(c.id, c);
  return [...unique.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
