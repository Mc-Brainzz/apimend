import { describe, expect, it } from 'vitest';
import { matchFieldAccess } from '../../src/impact/names.js';
import { matchPaths } from '../../src/impact/path-match.js';
import { scanFile } from '../../src/impact/scan.js';
import type { BreakingChange } from '../../src/types.js';

// Regressions found by running the Stripe acacia -> basil diff against a real
// repository: 1 true call site was buried under ~120 false positives.

describe('path match: literal segments left of the aligned part must agree', () => {
  const VERIFY = '/v1/customers/{customer}/sources/{id}/verify';

  it("does not match the repo's own route that merely ends the same way", () => {
    expect(matchPaths('// POST /api/auth/verify  { email, code }', [VERIFY])).toEqual([]);
    expect(matchPaths('app.post("/api/auth/verify", handler)', [VERIFY])).toEqual([]);
  });

  it('still matches when the code path simply starts later than the template', () => {
    expect(matchPaths('post("/sources/src_1/verify")', [VERIFY])).toHaveLength(1);
  });

  it('still matches when an interpolated base sits to the left', () => {
    expect(matchPaths('post(`${BASE}/sources/${id}/verify`)', [VERIFY])).toHaveLength(1);
  });

  it('still matches a full path behind a host', () => {
    const line = 'post("https://api.stripe.com/v1/customers/cus_1/sources/src_1/verify")';
    expect(matchPaths(line, [VERIFY])).toHaveLength(1);
  });
});

describe('path match: a slash inside a word is prose, not a URL', () => {
  it('ignores "region/account" in a comment', () => {
    expect(matchPaths('// wrong region/account. Passed explicitly', ['/v1/account'])).toEqual([]);
  });

  it('still matches a quoted path and a URL with a host', () => {
    expect(matchPaths('get(BASE + "/v1/account")', ['/v1/account'])).toHaveLength(1);
    expect(matchPaths('get("https://api.stripe.com/v1/account")', ['/v1/account'])).toHaveLength(1);
  });
});

describe('matchFieldAccess: a field name counts only where it is used as a field', () => {
  const v = ['customer_email', 'customerEmail'];

  it.each([
    'return invoice.customer_email;',
    'return invoice?.customerEmail;',
    'const e = row["customer_email"];',
    "email = inv.get('customer_email')",
    'const { id, customer_email } = invoice;',
    'create({ customer_email: email })',
    'stripe.Invoice.create(customer_email=email)',
    '"customer_email": "a@b.c",',
  ])('matches %s', (line) => {
    expect(matchFieldAccess(line, v)).toBe(true);
  });

  it.each([
    '// the customer_email went away in basil',
    'mode: "customer_email",',
    'log("customer_email missing")',
    'if (kind == customer_email) {}',
    'const my_customer_email_copy = 1;',
  ])('does not match %s', (line) => {
    expect(matchFieldAccess(line, v)).toBe(false);
  });
});

describe('scanFile: prose and string values are not field hits', () => {
  const change: BreakingChange = {
    id: 'response-field-removed|GET|/v1/invoices/{invoice}|response|200|subscription',
    kind: 'response-field-removed',
    severity: 'breaking',
    method: 'GET',
    path: '/v1/invoices/{invoice}',
    in: 'response',
    status: '200',
    name: 'subscription',
    schema: 'invoice.subscription',
    message: 'm',
  };
  const ctx = { options: { hosts: ['api.stripe.com'] }, repoHasCorroboration: true };

  it('ignores the word in comments and string values but keeps property access', () => {
    const text = [
      '// one Stripe subscription per account',
      'const session = { mode: "subscription" };',
      'const id = invoice.subscription;',
    ].join('\n');
    expect(scanFile('src/a.ts', text, [change], ctx).map((s) => s.line)).toEqual([3]);
  });
});
