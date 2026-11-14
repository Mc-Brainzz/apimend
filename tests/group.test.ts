import { describe, it, expect } from 'vitest';
import { diffSpecs } from '../src/diff/index.js';
import { groupChanges } from '../src/diff/group.js';
import type { BreakingChange, ChangeKind, OpenAPIDoc } from '../src/types.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const getOp = (schema: unknown, extra: Record<string, unknown> = {}) => ({
  get: {
    responses: { '200': { content: { 'application/json': { schema } } } },
    ...extra,
  },
});

const postOp = (schema: unknown) => ({
  post: {
    requestBody: { content: { 'application/json': { schema } } },
    responses: { '200': { description: 'ok' } },
  },
});

const doc = (schemas: Record<string, unknown>, paths: Record<string, unknown>) =>
  ({ openapi: '3.0.3', paths, components: { schemas } }) as OpenAPIDoc;

const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  required,
  properties: props,
});

function change(
  o: Partial<BreakingChange> & { kind: ChangeKind },
): BreakingChange {
  const full = {
    severity: 'breaking',
    method: 'GET',
    path: '/x',
    message: 'm',
    ...o,
  } as BreakingChange;
  full.id =
    o.id ??
    [full.kind, full.method, full.path, full.in ?? '', full.status ?? '', full.name ?? ''].join('|');
  return full;
}

describe('schema on diffSpecs output', () => {
  it('gives two changes the same schema when a shared component loses a field', () => {
    const oldDoc = doc(
      { item: obj({ id: { type: 'string' }, legacy: { type: 'string' } }) },
      { '/a': getOp(ref('item')), '/b': getOp(ref('item')) },
    );
    const newDoc = doc(
      { item: obj({ id: { type: 'string' } }) },
      { '/a': getOp(ref('item')), '/b': getOp(ref('item')) },
    );
    const removed = diffSpecs(oldDoc, newDoc).filter(
      (c) => c.kind === 'response-field-removed',
    );
    expect(removed).toHaveLength(2);
    expect(removed.map((c) => c.path).sort()).toEqual(['/a', '/b']);
    for (const c of removed) {
      expect(c.name).toBe('legacy');
      expect(c.schema).toBe('item.legacy');
    }
  });

  it('takes schema from the OLD side for a removed field', () => {
    const oldDoc = doc(
      { item_v1: obj({ legacy: { type: 'string' } }) },
      { '/a': getOp(ref('item_v1')) },
    );
    const newDoc = doc(
      { item_v2: obj({ other: { type: 'string' } }) },
      { '/a': getOp(ref('item_v2')) },
    );
    const removed = diffSpecs(oldDoc, newDoc).find(
      (c) => c.kind === 'response-field-removed',
    );
    expect(removed?.schema).toBe('item_v1.legacy');
  });

  it('takes schema from the NEW spec for request-field-required-added', () => {
    const oldDoc = doc(
      { body_v1: obj({ note: { type: 'string' } }) },
      { '/r': postOp(ref('body_v1')) },
    );
    const newDoc = doc(
      { body_v2: obj({ note: { type: 'string' } }, ['note']) },
      { '/r': postOp(ref('body_v2')) },
    );
    const c = diffSpecs(oldDoc, newDoc).find(
      (x) => x.kind === 'request-field-required-added',
    );
    expect(c).toBeDefined();
    expect(c!.schema).toBe('body_v2.note');
  });

  it('omits the schema key for an inline schema', () => {
    const oldDoc = doc(
      {},
      { '/a': getOp(obj({ id: { type: 'string' }, legacy: { type: 'string' } })) },
    );
    const newDoc = doc({}, { '/a': getOp(obj({ id: { type: 'string' } })) });
    const removed = diffSpecs(oldDoc, newDoc).filter(
      (c) => c.kind === 'response-field-removed',
    );
    expect(removed).toHaveLength(1);
    expect('schema' in removed[0]!).toBe(false);
  });

  it('never sets schema on parameter kinds or endpoint-removed', () => {
    const params = (list: unknown[]) => ({
      get: { parameters: list, responses: { '200': { description: 'ok' } } },
    });
    const oldDoc = doc(
      {},
      {
        '/p': params([
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'r', in: 'query', schema: { type: 'string' } },
        ]),
        '/gone': { post: { responses: { '200': { description: 'ok' } } } },
      },
    );
    const newDoc = doc(
      {},
      { '/p': params([{ name: 'q', in: 'query', schema: { type: 'integer' } }]) },
    );
    const changes = diffSpecs(oldDoc, newDoc);
    const kinds = changes.map((c) => c.kind);
    expect(kinds).toContain('param-removed');
    expect(kinds).toContain('param-type-changed');
    expect(kinds).toContain('endpoint-removed');
    for (const c of changes) expect('schema' in c, c.id).toBe(false);
  });

  it('keeps schema out of id', () => {
    const oldDoc = doc(
      { item: obj({ legacy: { type: 'string' } }) },
      { '/a': getOp(ref('item')), '/b': getOp(ref('item')) },
    );
    const newDoc = doc(
      { item: obj({ other: { type: 'string' } }) },
      { '/a': getOp(ref('item')), '/b': getOp(ref('item')) },
    );
    const ids = diffSpecs(oldDoc, newDoc)
      .filter((c) => c.kind === 'response-field-removed')
      .map((c) => c.id);
    expect(ids).toEqual([
      'response-field-removed|GET|/a|response|200|legacy',
      'response-field-removed|GET|/b|response|200|legacy',
    ]);
  });
});

describe('groupChanges', () => {
  it('folds changes with the same key into one group in input order', () => {
    const a = change({ kind: 'response-field-removed', path: '/a', in: 'response', status: '200', name: 'legacy', schema: 'item.legacy' });
    const b = change({ kind: 'response-field-removed', path: '/b', in: 'response', status: '200', name: 'legacy', schema: 'item.legacy' });
    const groups = groupChanges([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.changes).toEqual([a, b]);
    expect(groups[0]!.key).toBe('response-field-removed|item.legacy|||');
  });

  it('does not fold changes whose before/after or values differ', () => {
    const base = { path: '/a', in: 'response' as const, status: '200', name: 'x', schema: 'item.x' };
    const t1 = change({ ...base, kind: 'response-field-type-changed', before: 'integer', after: 'string' });
    const t2 = change({ ...base, path: '/b', kind: 'response-field-type-changed', before: 'integer', after: 'boolean' });
    const t3 = change({ ...base, path: '/c', kind: 'response-field-type-changed', before: 'number', after: 'string' });
    const e1 = change({ ...base, kind: 'response-enum-value-added', severity: 'warning', values: ['a'] });
    const e2 = change({ ...base, path: '/b', kind: 'response-enum-value-added', severity: 'warning', values: ['b'] });
    const e3 = change({ ...base, path: '/c', kind: 'response-enum-value-added', severity: 'warning', values: ['a'] });
    const groups = groupChanges([t1, t2, t3, e1, e2, e3]);
    expect(groups.map((g) => g.changes.length)).toEqual([1, 1, 1, 2, 1]);
    expect(groups).toHaveLength(5);
    expect(groups[3]!.changes).toEqual([e1, e3]);
  });

  it('makes a change without schema its own group keyed by its id, with schema omitted', () => {
    const a = change({ kind: 'endpoint-removed', path: '/a' });
    const b = change({ kind: 'endpoint-removed', path: '/a' });
    const groups = groupChanges([a, b]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.key).toBe(a.id);
    expect(groups[0]!.changes).toEqual([a]);
    expect('schema' in groups[0]!).toBe(false);
  });

  it('orders groups by first appearance and takes kind, severity and schema from the first change', () => {
    const lone = change({ kind: 'endpoint-removed', path: '/z' });
    const first = change({ kind: 'response-field-removed', severity: 'breaking', path: '/a', in: 'response', status: '200', name: 'f', schema: 'item.f' });
    const other = change({ kind: 'response-field-removed', path: '/q', in: 'response', status: '200', name: 'g', schema: 'item.g' });
    const second = change({ kind: 'response-field-removed', severity: 'warning', path: '/b', in: 'response', status: '200', name: 'f', schema: 'item.f' });
    const groups = groupChanges([lone, first, other, second]);
    expect(groups.map((g) => g.changes[0])).toEqual([lone, first, other]);
    const g = groups[1]!;
    expect(g.changes).toEqual([first, second]);
    expect(g.kind).toBe('response-field-removed');
    expect(g.severity).toBe('breaking');
    expect(g.schema).toBe('item.f');
  });

  it('returns [] for an empty input', () => {
    expect(groupChanges([])).toEqual([]);
  });

  it('does not mutate the input array or its objects', () => {
    const a = change({ kind: 'response-field-removed', path: '/a', in: 'response', status: '200', name: 'f', schema: 'item.f' });
    const b = change({ kind: 'response-field-removed', path: '/b', in: 'response', status: '200', name: 'f', schema: 'item.f' });
    const input = [a, b];
    const snapshot = JSON.parse(JSON.stringify(input));
    groupChanges(input);
    expect(input).toHaveLength(2);
    expect(input[0]).toBe(a);
    expect(input[1]).toBe(b);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });
});
