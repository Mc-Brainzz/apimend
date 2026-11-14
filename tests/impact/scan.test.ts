import { describe, it, expect } from 'vitest';
import { isCorroborated, scanFile } from '../../src/impact/scan.js';
import type { ScanContext } from '../../src/impact/scan.js';
import type { BreakingChange, ImpactOptions } from '../../src/types.js';

function change(o: Partial<Omit<BreakingChange, 'id'>> = {}): BreakingChange {
  const c: Omit<BreakingChange, 'id'> = {
    kind: 'response-field-removed',
    severity: 'breaking',
    method: 'GET',
    path: '/v1/invoices/{id}',
    message: 'test change',
    ...o,
  };
  const id = [c.kind, c.method, c.path, c.in ?? '', c.status ?? '', c.name ?? ''].join('|');
  return { id, ...c };
}

const neutral = (options: ImpactOptions = {}): ScanContext => ({ options, repoHasCorroboration: false });
const F = 'src/a.ts';
const PATH_LINE = 'const r = await fetch("/v1/invoices/" + id);';

describe('isCorroborated', () => {
  it('detects hosts (case-insensitive) and SDK imports in JS and Python forms', () => {
    expect(isCorroborated('fetch("https://api.stripe.com/v1/x")', { hosts: ['API.Stripe.com'] })).toBe(true);
    const o = { sdkPackages: ['stripe'] };
    for (const t of [
      "import Stripe from 'stripe';",
      'import Stripe from "stripe/lib";',
      "const s = require('stripe')(key);",
      'import stripe',
      'from stripe import Customer',
      'from stripe.api import x',
    ]) {
      expect(isCorroborated(t, o)).toBe(true);
    }
  });

  it('is false with no options, empty lists, or no mention', () => {
    expect(isCorroborated("import Stripe from 'stripe';", {})).toBe(false);
    expect(isCorroborated("import Stripe from 'stripe';", { hosts: [], sdkPackages: [] })).toBe(false);
    expect(isCorroborated('const a = 1; // stripe', { sdkPackages: ['stripe'] })).toBe(false);
    expect(isCorroborated('fetch("https://other.com")', { hosts: ['api.stripe.com'] })).toBe(false);
  });
});

describe('scanFile signals', () => {
  it('path signal produces a site with 1-indexed line and file name', () => {
    const c = change();
    const sites = scanFile(F, PATH_LINE, [c], neutral());
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ file: F, line: 1, signal: 'path', changeIds: [c.id] });
  });

  it('operationId signal matches camel/snake/Pascal variants, only for ids of 6+ chars', () => {
    const c = change({ kind: 'endpoint-removed', path: '/v1/things/{id}', operationId: 'RetrieveThing' });
    for (const t of ['await api.retrieveThing(id);', 'retrieve_thing(id)', 'new RetrieveThing()']) {
      const sites = scanFile(F, t, [c], neutral());
      expect(sites).toHaveLength(1);
      expect(sites[0].signal).toBe('operationId');
    }
    const short = change({ kind: 'endpoint-removed', path: '/v1/things/{id}', operationId: 'getIt' });
    expect(scanFile(F, 'getIt()', [short], neutral())).toEqual([]);
  });

  it('field signal produces a site for a distinctive name', () => {
    const c = change({ name: 'data[].customer_email', in: 'response', status: '200' });
    const sites = scanFile(F, 'const e = row.customer_email;', [c], neutral());
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatchObject({ signal: 'field', line: 1, changeIds: [c.id] });
  });

  it('skips a path hit when the line names HTTP methods and none is the change method', () => {
    const post = change({ method: 'POST' });
    expect(scanFile(F, 'client.get("/v1/invoices/" + id)', [post], neutral())).toEqual([]);
    expect(scanFile(F, 'client.post("/v1/invoices/" + id)', [post], neutral())).toHaveLength(1);
    expect(scanFile(F, 'client.GET("/v1/invoices/" + id)', [change()], neutral())).toHaveLength(1);
  });

  it('scores a field name higher in a file that also has a path hit for the same change', () => {
    const c = change({ name: 'customer_email', in: 'response', status: '200' });
    const withPath = scanFile(F, `${PATH_LINE}\nconst e = row.customer_email;`, [c], neutral());
    const without = scanFile(F, 'const e = row.customer_email;', [c], neutral());
    const a = withPath.find((s) => s.line === 2)!;
    const b = without.find((s) => s.line === 1)!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a.confidence).toBeGreaterThan(b.confidence);
  });

  it('a common field name needs a path hit or corroboration to produce a site', () => {
    const c = change({ name: 'status', in: 'response', status: '200' });
    const line = 'if (inv.status === "paid") {}';
    expect(scanFile(F, line, [c], neutral())).toEqual([]);
    const hosts = { hosts: ['api.example.com'] };
    expect(scanFile(F, line, [c], { options: hosts, repoHasCorroboration: true })).toEqual([]);
    const yes = scanFile(F, `${line}\nconst H = "api.example.com";`, [c], { options: hosts, repoHasCorroboration: true });
    expect(yes.find((s) => s.line === 1)?.signal).toBe('field');
    const withPath = scanFile(F, `${PATH_LINE}\n${line}`, [c], neutral());
    expect(withPath.find((s) => s.line === 2)?.signal).toBe('field');
  });

  it('orders path confidence: corroborated yes > neutral > not corroborated', () => {
    const c = change();
    const options = { hosts: ['api.example.com'] };
    const yesText = `${PATH_LINE}\nconst H = "api.example.com";`;
    const yes = scanFile(F, yesText, [c], { options, repoHasCorroboration: true }).find((s) => s.line === 1)!;
    const neu = scanFile(F, PATH_LINE, [c], { options, repoHasCorroboration: false }).find((s) => s.line === 1)!;
    const no = scanFile(F, PATH_LINE, [c], { options, repoHasCorroboration: true }).find((s) => s.line === 1)!;
    expect(yes.confidence).toBeGreaterThan(neu.confidence);
    expect(neu.confidence).toBeGreaterThan(no.confidence);
  });
});

describe('scanFile output shape', () => {
  it('merges signals on one line: strongest signal, max confidence, sorted union of ids', () => {
    const c1 = change();
    const c2 = change({ path: '/v1/zeta/{id}', name: 'customer_email', in: 'response', status: '200' });
    const line = 'const e = (await fetch("/v1/invoices/" + id)).customer_email;';
    const sites = scanFile(F, line, [c2, c1], neutral());
    expect(sites).toHaveLength(1);
    expect(sites[0].signal).toBe('path');
    expect(sites[0].changeIds).toEqual([c1.id, c2.id].sort());
    const fieldOnly = scanFile(F, line, [c2], neutral());
    expect(sites[0].confidence).toBeGreaterThan(fieldOnly[0].confidence);

    const cA = change({ kind: 'endpoint-removed', path: '/v1/things/{id}', operationId: 'RetrieveThing' });
    const cB = change({ path: '/v1/zzz', name: 'customer_email', in: 'response', status: '200' });
    const s2 = scanFile(F, 'retrieveThing(row.customer_email);', [cB, cA], neutral());
    expect(s2).toHaveLength(1);
    expect(s2[0].signal).toBe('operationId');
    expect(s2[0].changeIds).toEqual([cA.id, cB.id].sort());
  });

  it('uses 1-indexed lines and a trimmed snippet capped at 200 characters', () => {
    const text = ['// header', '', '  const x = 1;', '\tfetch("/v1/invoices/" + id);  '].join('\n');
    const s = scanFile(F, text, [change()], neutral());
    expect(s).toHaveLength(1);
    expect(s[0].line).toBe(4);
    expect(s[0].snippet).toBe('fetch("/v1/invoices/" + id);');

    const long = '    fetch("/v1/invoices/" + id); // ' + 'x'.repeat(400);
    const l = scanFile(F, long, [change()], neutral());
    expect(l[0].snippet).toBe(long.trim().slice(0, 200));
  });

  it('clamps confidence to at most 0.95 and rounds to 2 decimals', () => {
    const c = change({ path: '/v1/billing/invoices/lines/{id}' });
    const text = 'client.get("/v1/billing/invoices/lines/" + id);\nconst H = "api.example.com";';
    const sites = scanFile(F, text, [c], { options: { hosts: ['api.example.com'] }, repoHasCorroboration: true });
    const s = sites.find((x) => x.line === 1)!;
    expect(s.confidence).toBe(0.95);
    for (const x of sites) {
      expect(x.confidence).toBeGreaterThanOrEqual(0.05);
      expect(x.confidence).toBeLessThanOrEqual(0.95);
      expect(Math.round(x.confidence * 100) / 100).toBe(x.confidence);
    }
  });
});
