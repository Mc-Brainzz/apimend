import { describe, it, expect } from 'vitest';
import { buildBrief } from '../../src/fix/brief.js';
import type { BreakingChange, ImpactSite } from '../../src/types.js';

function change(o: Partial<BreakingChange> & { kind: BreakingChange['kind'] }): BreakingChange {
  const c = {
    severity: 'breaking',
    method: 'GET',
    path: '/v1/things',
    message: 'something changed',
    ...o,
  } as BreakingChange;
  c.id = [c.kind, c.method, c.path, c.in ?? '', c.status ?? '', c.name ?? ''].join('|');
  return c;
}

function site(o: Partial<ImpactSite> = {}): ImpactSite {
  return {
    file: 'src/a.ts',
    line: 1,
    snippet: 'x',
    signal: 'path',
    changeIds: [],
    confidence: 0.5,
    ...o,
  };
}

const lines = (s: string) => s.trimEnd().split('\n');

function schemaChange(
  path: string,
  name = 'current_period_end',
  method: BreakingChange['method'] = 'GET',
): BreakingChange {
  return change({
    kind: 'response-field-removed',
    method,
    path,
    in: 'response',
    status: '200',
    name,
    schema: 'subscription.current_period_end',
  });
}

describe('buildBrief', () => {
  it('reproduces the spec example layout line by line', () => {
    const g1 = [
      schemaChange('/v1/subscriptions'),
      schemaChange('/v1/subscriptions/{id}'),
      schemaChange('/v1/subscriptions', 'current_period_end', 'POST'),
    ];
    const g2 = change({
      kind: 'response-field-type-changed',
      path: '/v1/invoices/{id}',
      operationId: 'getInvoice',
      in: 'response',
      status: '200',
      name: 'total',
      before: 'integer',
      after: 'string',
    });
    const g3 = change({
      kind: 'param-removed',
      severity: 'warning',
      path: '/v1/invoices/{id}',
      operationId: 'getInvoice',
      in: 'query',
      name: 'expand',
    });
    const g4 = change({ kind: 'endpoint-removed', method: 'DELETE', path: '/v1/invoices/{id}' });
    const s = site({
      file: 'src/billing/client.ts',
      line: 42,
      signal: 'path',
      confidence: 0.85,
      snippet: 'const res = await fetch(url)',
      changeIds: [g2.id, g3.id],
    });
    const out = buildBrief([...g1, g2, g3, g4], [s]);
    expect(lines(out)).toEqual([
      '## Breaking changes',
      '',
      '1. [breaking] response-field-removed — schema `subscription`, field `current_period_end`; in 3 operations: GET /v1/subscriptions, GET /v1/subscriptions/{id}, POST /v1/subscriptions',
      '2. [breaking] response-field-type-changed — GET /v1/invoices/{id} (operationId: getInvoice): response 200 field `total` (integer → string)',
      '3. [warning] param-removed — GET /v1/invoices/{id} (operationId: getInvoice): query parameter `expand`',
      '4. [breaking] endpoint-removed — DELETE /v1/invoices/{id}: endpoint removed',
      '',
      '## Candidate sites',
      '',
      'These come from a text search and include false positives. Verify each one.',
      '',
      '### src/billing/client.ts',
      '- line 42 (path, 0.85) changes 2, 3: `const res = await fetch(url)`',
    ]);
  });

  it('splits schema at the first dot and lists distinct operations in order', () => {
    const a = change({
      kind: 'request-field-removed',
      method: 'POST',
      path: '/v1/customers',
      in: 'request',
      name: 'address.line1',
      schema: 'customer.address.line1',
    });
    const b = change({
      kind: 'request-field-removed',
      method: 'PUT',
      path: '/v1/customers/{id}',
      in: 'request',
      name: 'address.line1',
      schema: 'customer.address.line1',
    });
    const out = buildBrief([a, b], []);
    expect(out).toContain(
      '1. [breaking] request-field-removed — schema `customer`, field `address.line1`; in 2 operations: POST /v1/customers, PUT /v1/customers/{id}',
    );
  });

  it('caps the operation list at 5 and appends (+N more)', () => {
    const cs = Array.from({ length: 7 }, (_, i) => schemaChange(`/v1/r${i}`));
    const out = buildBrief(cs, []);
    expect(out).toContain(
      'in 7 operations: GET /v1/r0, GET /v1/r1, GET /v1/r2, GET /v1/r3, GET /v1/r4 (+2 more)',
    );
    expect(out).not.toContain('GET /v1/r5');
  });

  it('uses singular "operation" for one op and counts a repeated operation once', () => {
    const one = buildBrief([schemaChange('/v1/x')], []);
    expect(one).toContain('; in 1 operation: GET /v1/x');
    expect(one).not.toContain('1 operations');

    const twice = [
      schemaChange('/v1/x', 'current_period_end'),
      schemaChange('/v1/x', 'other_name'),
      schemaChange('/v1/y'),
    ];
    const out = buildBrief(twice, []);
    expect(out).toContain('; in 2 operations: GET /v1/x, GET /v1/y');
  });

  it('renders ungrouped changes with and without operationId', () => {
    const withOp = change({
      kind: 'param-required-added',
      path: '/v1/a',
      operationId: 'listA',
      in: 'query',
      name: 'limit',
    });
    const without = change({
      kind: 'request-field-removed',
      method: 'POST',
      path: '/v1/b',
      in: 'request',
      name: 'note',
    });
    const out = buildBrief([withOp, without], []);
    expect(out).toContain(
      '1. [breaking] param-required-added — GET /v1/a (operationId: listA): query parameter `limit`',
    );
    expect(out).toContain('2. [breaking] request-field-removed — POST /v1/b: request field `note`');
  });

  it('appends type-change and enum suffixes on grouped and ungrouped forms', () => {
    const gType = change({
      kind: 'response-field-type-changed',
      path: '/v1/a',
      in: 'response',
      status: '200',
      name: 'total',
      before: 'integer',
      after: 'string',
      schema: 'invoice.total',
    });
    const gEnum = change({
      kind: 'request-enum-value-removed',
      method: 'POST',
      path: '/v1/b',
      in: 'request',
      name: 'status',
      values: ['a', 'b'],
      schema: 'order.status',
    });
    const uType = change({
      kind: 'param-type-changed',
      path: '/v1/c',
      in: 'query',
      name: 'n',
      before: 'string',
      after: 'integer',
    });
    const uEnum = change({
      kind: 'response-enum-value-added',
      path: '/v1/d',
      in: 'response',
      status: '201',
      name: 'state',
      values: ['x', 'y'],
    });
    const out = lines(buildBrief([gType, gEnum, uType, uEnum], []));
    expect(out[2]).toContain('schema `invoice`, field `total` (integer → string); in 1 operation: GET /v1/a');
    expect(out[3]).toContain('schema `order`, field `status` (values: a, b); in 1 operation: POST /v1/b');
    expect(out[4]).toContain('GET /v1/c: query parameter `n` (string → integer)');
    expect(out[5]).toContain('GET /v1/d: response 201 field `state` (values: x, y)');
  });

  it('lists group numbers (not change numbers) ascending, without repeats, ignoring unknown ids', () => {
    const g1a = schemaChange('/v1/a');
    const g1b = schemaChange('/v1/b');
    const g2 = change({ kind: 'endpoint-removed', method: 'DELETE', path: '/v1/z' });
    const g3 = change({ kind: 'param-removed', path: '/v1/q', in: 'query', name: 'e' });
    const s = site({ changeIds: [g3.id, 'nope|GET|/x|||', g1b.id, g1a.id, g3.id] });
    const out = buildBrief([g1a, g1b, g2, g3], [s]);
    expect(out).toContain('changes 1, 3:');
  });

  it('groups sites by file, files in first-appearance order', () => {
    const c = change({ kind: 'endpoint-removed', path: '/v1/a' });
    const sites = [
      site({ file: 'src/b.ts', line: 3, snippet: 'one', changeIds: [c.id] }),
      site({ file: 'src/a.ts', line: 9, snippet: 'two', changeIds: [c.id] }),
      site({ file: 'src/b.ts', line: 7, snippet: 'three', changeIds: [c.id] }),
    ];
    const out = buildBrief([c], sites);
    const ib = out.indexOf('### src/b.ts');
    const ia = out.indexOf('### src/a.ts');
    expect(ib).toBeGreaterThan(-1);
    expect(ia).toBeGreaterThan(ib);
    expect(out.match(/### src\/b\.ts/g)).toHaveLength(1);
    expect(out.indexOf('`one`')).toBeLessThan(out.indexOf('`three`'));
    expect(out.indexOf('`three`')).toBeLessThan(ia);
  });

  it('replaces backticks inside a snippet with single quotes', () => {
    const c = change({ kind: 'endpoint-removed', path: '/v1/a' });
    const out = buildBrief([c], [site({ snippet: 'fetch(`/v1/a/${id}`)', changeIds: [c.id] })]);
    expect(out).toContain(": `fetch('/v1/a/${id}')`");
  });

  it('truncates to maxSites and notes how many were omitted', () => {
    const c = change({ kind: 'endpoint-removed', path: '/v1/a' });
    const sites = [1, 2, 3].map((n) => site({ line: n, snippet: `s${n}`, changeIds: [c.id] }));
    const out = buildBrief([c], sites, { maxSites: 1 });
    expect(out).toContain('`s1`');
    expect(out).not.toContain('`s2`');
    expect(out).not.toContain('`s3`');
    expect(lines(out).at(-1)).toBe('(2 more sites omitted)');
  });

  it('says so when there are no sites', () => {
    const c = change({ kind: 'endpoint-removed', path: '/v1/a' });
    const out = buildBrief([c], []);
    expect(out).toContain('## Candidate sites');
    expect(out).toContain('No candidate sites were found by search.');
  });

  it('is deterministic', () => {
    const c1 = schemaChange('/v1/a');
    const c2 = change({ kind: 'param-removed', path: '/v1/b', in: 'query', name: 'e' });
    const sites = [site({ changeIds: [c1.id, c2.id], snippet: 'a`b' })];
    expect(buildBrief([c1, c2], sites)).toBe(buildBrief([c1, c2], sites));
  });
});
