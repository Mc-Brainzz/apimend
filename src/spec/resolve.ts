import type { OpenAPIDoc } from '../types.js';

const MAX_HOPS = 20;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function lookup(doc: OpenAPIDoc, ref: string): unknown {
  let cur: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) {
      cur = /^\d+$/.test(key) ? cur[Number(key)] : undefined;
    } else if (isRecord(cur) && Object.prototype.hasOwnProperty.call(cur, key)) {
      cur = cur[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

/** Like resolveRef, but also returns every $ref string followed on the way. */
export function resolveRefTracked(
  doc: OpenAPIDoc,
  node: unknown,
): { value: unknown; refs: string[] } {
  const refs: string[] = [];
  let cur = node;
  for (let hops = 0; ; hops++) {
    if (!isRecord(cur) || typeof cur['$ref'] !== 'string') return { value: cur, refs };
    const ref = cur['$ref'];
    refs.push(ref);
    if (hops >= MAX_HOPS || !ref.startsWith('#/')) return { value: {}, refs };
    const target = lookup(doc, ref);
    if (target === undefined) return { value: {}, refs };
    cur = target;
  }
}

/** Follow local `$ref` chains. Unresolvable refs become `{}`. */
export function resolveRef(doc: OpenAPIDoc, node: unknown): unknown {
  return resolveRefTracked(doc, node).value;
}
