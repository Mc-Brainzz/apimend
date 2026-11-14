import type { FieldInfo, OpenAPIDoc, SchemaObject } from '../types.js';
import { isRecord, resolveRefTracked } from '../spec/resolve.js';

const MAX_DEPTH = 10;

/** Component a property is declared in, plus the path of its holder inside it. */
type Comp = { name: string; base: string };
type Effective = {
  schema: SchemaObject;
  refs: string[];
  /** Component of this schema itself (innermost followed ref, else inherited). */
  own: Comp | undefined;
  /** Component each property of `schema` was declared in. */
  comps: Map<string, Comp | undefined>;
};
/** Where a field is declared: origin = `comp.local`. */
type At = { comp: string; local: string };

function compName(ref: string): string {
  return ref.slice(ref.lastIndexOf('/') + 1).replace(/~1/g, '/').replace(/~0/g, '~');
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function mergeInto(target: SchemaObject, member: SchemaObject): void {
  const props = { ...(isRecord(target['properties']) ? target['properties'] : {}) };
  const required = new Set(strArray(target['required']));
  Object.assign(target, member);
  if (isRecord(member['properties'])) Object.assign(props, member['properties']);
  for (const r of strArray(member['required'])) required.add(r);
  if (Object.keys(props).length > 0) target['properties'] = props;
  if (required.size > 0) target['required'] = [...required];
}

/**
 * Resolve refs and merge allOf. `stack` holds refs already being resolved.
 * `inherit` is the component an inline (ref-less) schema belongs to.
 */
export function effectiveSchema(
  doc: OpenAPIDoc,
  raw: unknown,
  stack: readonly string[] = [],
  depth = 0,
  inherit?: Comp,
): Effective {
  const { value, refs } = resolveRefTracked(doc, raw);
  const last = refs[refs.length - 1];
  const own: Comp | undefined = last !== undefined ? { name: compName(last), base: '' } : inherit;
  const comps = new Map<string, Comp | undefined>();
  if (!isRecord(value)) return { schema: {}, refs, own, comps };
  if (isRecord(value['properties'])) {
    for (const k of Object.keys(value['properties'])) comps.set(k, own);
  }
  const allOf = value['allOf'];
  if (!Array.isArray(allOf) || depth >= MAX_DEPTH) return { schema: value, refs, own, comps };
  const merged: SchemaObject = { ...value };
  delete merged['allOf'];
  const allRefs = [...refs];
  for (const member of allOf) {
    const eff = effectiveSchema(doc, member, [...stack, ...refs], depth + 1, own);
    allRefs.push(...eff.refs);
    if (eff.refs.some((r) => stack.includes(r) || refs.includes(r))) continue;
    mergeInto(merged, eff.schema);
    if (isRecord(eff.schema['properties'])) {
      for (const k of Object.keys(eff.schema['properties'])) comps.set(k, eff.comps.get(k));
    }
  }
  return { schema: merged, refs: allRefs, own, comps };
}

function hasType(s: SchemaObject): string[] | string | undefined {
  const t = s['type'];
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return strArray(t);
  return undefined;
}

/** Type string of an already-effective schema. */
export function typeOfEffective(s: SchemaObject): string {
  const t = hasType(s);
  if (typeof t === 'string') return t;
  if (t !== undefined) {
    const rest = t.filter((x) => x !== 'null').sort();
    return rest.length > 0 ? rest.join('|') : 'null';
  }
  if (isRecord(s['properties'])) return 'object';
  if (s['items'] !== undefined) return 'array';
  if (Array.isArray(s['oneOf']) || Array.isArray(s['anyOf'])) return 'union';
  return 'any';
}

function nullableOf(s: SchemaObject): boolean {
  if (s['nullable'] === true) return true;
  const t = hasType(s);
  return Array.isArray(t) && t.includes('null');
}

/** Type string of a (possibly $ref / allOf) schema. Undefined schema is `any`. */
export function typeOf(doc: OpenAPIDoc, schema: unknown): string {
  return typeOfEffective(effectiveSchema(doc, schema).schema);
}

/**
 * How many `$ref` union branches may be followed along one path. Specs such as
 * Stripe's make most fields `anyOf[string, $ref]` ("expandable"); following
 * those at every level is exponential (minutes on a 7 MB spec). One hop keeps
 * polymorphic responses covered. A component skipped here is still diffed
 * wherever it is returned directly, and grouped by origin.
 */
const MAX_UNION_REF_HOPS = 1;

type Prop = { schema: unknown; required: boolean; comp: Comp | undefined; hops: number };

/** Properties of an object schema, with oneOf/anyOf branch properties unioned in. */
function collectProps(
  doc: OpenAPIDoc,
  e: Effective,
  stack: readonly string[],
  depth: number,
  out: Map<string, Prop>,
  hops: number,
): void {
  const s = e.schema;
  const required = new Set(strArray(s['required']));
  if (isRecord(s['properties'])) {
    for (const [name, schema] of Object.entries(s['properties'])) {
      out.set(name, { schema, required: required.has(name), comp: e.comps.get(name), hops });
    }
  }
  if (depth >= MAX_DEPTH) return;
  for (const key of ['oneOf', 'anyOf']) {
    const branches = s[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      const eff = effectiveSchema(doc, branch, stack, 0, e.own);
      if (eff.refs.some((r) => stack.includes(r))) continue;
      const viaRef = eff.refs.length > 0;
      if (viaRef && hops >= MAX_UNION_REF_HOPS) continue;
      const sub = new Map<string, Prop>();
      collectProps(doc, eff, [...stack, ...eff.refs], depth + 1, sub, hops + (viaRef ? 1 : 0));
      for (const [name, p] of sub) {
        if (!out.has(name)) out.set(name, { ...p, required: false });
      }
    }
  }
}

function flattenObject(
  doc: OpenAPIDoc,
  e: Effective,
  prefix: string,
  stack: readonly string[],
  depth: number,
  out: Map<string, FieldInfo>,
  hops: number,
): void {
  const props = new Map<string, Prop>();
  collectProps(doc, e, stack, 0, props, hops);
  for (const [name, p] of props) {
    const at = p.comp ? { comp: p.comp.name, local: p.comp.base + name } : undefined;
    addField(doc, prefix + name, p.schema, p.required, stack, depth, out, at, p.hops);
  }
}

function addField(
  doc: OpenAPIDoc,
  path: string,
  raw: unknown,
  required: boolean,
  stack: readonly string[],
  depth: number,
  out: Map<string, FieldInfo>,
  at?: At,
  hops = 0,
): void {
  const inherit = at ? { name: at.comp, base: at.local + '.' } : undefined;
  const eff = effectiveSchema(doc, raw, stack, 0, inherit);
  const { schema, refs } = eff;
  const type = typeOfEffective(schema);
  const info: FieldInfo = { type, required, nullable: nullableOf(schema) };
  if (Array.isArray(schema['enum'])) {
    info.enum = schema['enum'].map((v) => String(v)).sort();
  }
  if (at) info.origin = `${at.comp}.${at.local}`;
  out.set(path, info);
  if (refs.some((r) => stack.includes(r)) || depth >= MAX_DEPTH) return;
  const nextStack = [...stack, ...refs];
  // A union can carry properties through its branches (anyOf[string, $ref]),
  // and flattenObject emits nothing when it has none.
  if (type === 'object' || type === 'union') {
    flattenObject(doc, eff, path + '.', nextStack, depth + 1, out, hops);
  } else if (type === 'array' && isRecord(schema['items'])) {
    const itemAt = at ? { comp: at.comp, local: at.local + '[]' } : undefined;
    addField(doc, path + '[]', schema['items'], true, nextStack, depth, out, itemAt, hops);
  }
}

/** Flatten a schema into field path -> FieldInfo. See docs/spec.md. */
export function flattenSchema(
  doc: OpenAPIDoc,
  schema: SchemaObject | undefined,
): Map<string, FieldInfo> {
  const out = new Map<string, FieldInfo>();
  if (schema === undefined) return out;
  const eff = effectiveSchema(doc, schema);
  const { schema: root, refs } = eff;
  if (typeOfEffective(root) === 'array') {
    if (isRecord(root['items'])) addField(doc, '[]', root['items'], true, refs, 0, out);
  } else {
    flattenObject(doc, eff, '', refs, 0, out, 0);
  }
  return out;
}
