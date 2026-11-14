import { describe, it, expect } from 'vitest';
import { formatChanges, formatSites } from '../../src/cli/format.js';
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

function schemaChanges(n: number, schema = 'subscription.current_period_end'): BreakingChange[] {
  return Array.from({ length: n }, (_, i) =>
    change({
      kind: 'response-field-removed',
      path: `/v1/r${i}`,
      in: 'response',
      status: '200',
      name: 'current_period_end',
      schema,
    }),
  );
}

const norm = (s: string) =>
  s
    .trimEnd()
    .split('\n')
    .map((l) => l.replace(/ +/g, ' ').trim());

describe('formatChanges', () => {
  it('reproduces the spec example (column padding collapsed)', () => {
    const cs = [
      ...schemaChanges(17),
      change({
        kind: 'response-field-type-changed',
        path: '/v1/invoices/{id}',
        in: 'response',
        status: '200',
        name: 'total',
        before: 'integer',
        after: 'string',
      }),
      change({
        kind: 'param-removed',
        severity: 'warning',
        path: '/v1/invoices/{id}',
        in: 'query',
        name: 'expand',
      }),
      change({ kind: 'endpoint-removed', method: 'DELETE', path: '/v1/invoices/{id}' }),
    ];
    expect(norm(formatChanges(cs))).toEqual([
      '[breaking] response-field-removed subscription.current_period_end (17 operations)',
      '[breaking] response-field-type-changed GET /v1/invoices/{id} response 200 total (integer → string)',
      '[warning] param-removed GET /v1/invoices/{id} query expand',
      '[breaking] endpoint-removed DELETE /v1/invoices/{id}',
      '',
      '3 breaking, 1 warning (4 groups from 20 changes)',
    ]);
  });

  it('writes (1 operation) in the singular', () => {
    const out = norm(formatChanges(schemaChanges(1)));
    expect(out[0]).toBe('[breaking] response-field-removed subscription.current_period_end (1 operation)');
  });

  it('counts groups by severity and pluralises', () => {
    const a = change({ kind: 'endpoint-removed', path: '/v1/a' });
    const b = change({ kind: 'endpoint-removed', path: '/v1/b' });
    const w1 = change({ kind: 'param-removed', severity: 'warning', path: '/v1/a', in: 'query', name: 'x' });
    const w2 = change({ kind: 'param-removed', severity: 'warning', path: '/v1/b', in: 'query', name: 'x' });
    expect(norm(formatChanges([a])).at(-1)).toBe('1 breaking, 0 warnings');
    expect(norm(formatChanges([w1])).at(-1)).toBe('0 breaking, 1 warning');
    expect(norm(formatChanges([a, b, w1, w2])).at(-1)).toBe('2 breaking, 2 warnings');
  });

  it('adds "(G groups from C changes)" only when groups are fewer than changes', () => {
    const folded = norm(formatChanges([...schemaChanges(3), change({ kind: 'endpoint-removed', path: '/v1/a' })]));
    expect(folded.at(-1)).toBe('2 breaking, 0 warnings (2 groups from 4 changes)');
    const distinct = norm(
      formatChanges([
        change({ kind: 'endpoint-removed', path: '/v1/a' }),
        change({ kind: 'endpoint-removed', path: '/v1/b' }),
      ]),
    );
    expect(distinct.at(-1)).toBe('2 breaking, 0 warnings');
  });

  it('appends the enum suffix on grouped and ungrouped lines', () => {
    const grouped = change({
      kind: 'request-enum-value-removed',
      method: 'POST',
      path: '/v1/orders',
      in: 'request',
      name: 'status',
      values: ['cancelled', 'refunded'],
      schema: 'order.status',
    });
    const plain = change({
      kind: 'request-enum-value-removed',
      method: 'POST',
      path: '/v1/orders',
      in: 'request',
      name: 'state',
      values: ['a', 'b'],
    });
    const out = norm(formatChanges([grouped, plain]));
    expect(out[0]).toBe('[breaking] request-enum-value-removed order.status (cancelled, refunded) (1 operation)');
    expect(out[1]).toBe('[breaking] request-enum-value-removed POST /v1/orders request state (a, b)');
  });

  it('prints "No breaking changes." for empty input', () => {
    expect(formatChanges([]).trim()).toBe('No breaking changes.');
  });
});

describe('formatSites', () => {
  it('formats the spec example', () => {
    const sites: ImpactSite[] = [
      { file: 'src/billing/client.ts', line: 42, snippet: 'const res = await fetch(url)', signal: 'path', changeIds: ['x'], confidence: 0.85 },
      { file: 'src/billing/client.ts', line: 57, snippet: 'return invoice.customer_email', signal: 'field', changeIds: ['x'], confidence: 0.7 },
      { file: 'src/other.ts', line: 3, snippet: 'go()', signal: 'operationId', changeIds: ['x'], confidence: 0.9 },
    ];
    const out = formatSites(sites).trimEnd().split('\n');
    expect(out[0]).toBe('src/billing/client.ts');
    expect(out[1]).toMatch(/^\s*L42\s+0\.85\s+path\s+const res = await fetch\(url\)$/);
    expect(out[2]).toMatch(/^\s*L57\s+0\.70\s+field\s+return invoice\.customer_email$/);
    const rest = out.slice(3);
    expect(rest.some((l) => l.trim() === 'src/other.ts')).toBe(true);
    expect(rest.some((l) => /^\s*L3\s+0\.90\s+operationId\s+go\(\)$/.test(l))).toBe(true);
  });

  it('prints "No affected code found." for empty input', () => {
    expect(formatSites([]).trim()).toBe('No affected code found.');
  });
});
