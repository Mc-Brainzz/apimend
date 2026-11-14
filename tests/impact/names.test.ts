import { describe, it, expect } from 'vitest';
import { nameVariants, isCommonName, matchName } from '../../src/impact/names.js';

describe('nameVariants', () => {
  it('takes the leaf of a field path and de-duplicates [as written, camel, snake]', () => {
    expect(nameVariants('data[].customer_email')).toEqual(['customer_email', 'customerEmail']);
  });

  it('starts from a camelCase leaf and adds snake_case', () => {
    expect(nameVariants('customerEmail')).toEqual(['customerEmail', 'customer_email']);
  });

  it('uses only the leaf of a dotted path', () => {
    const v = nameVariants('customer.address.line1');
    expect(v[0]).toBe('line1');
    expect(v.some((x) => x.includes('address'))).toBe(false);
  });
});

describe('isCommonName', () => {
  it('is true for short names and stoplist words, false for distinctive names', () => {
    for (const n of ['id', 'user', 'status', 'items', 'created', 'description']) {
      expect(isCommonName(n)).toBe(true);
    }
    for (const n of ['customer_email', 'email', 'starting_after']) {
      expect(isCommonName(n)).toBe(false);
    }
  });
});

describe('matchName', () => {
  const v = ['customer_email', 'customerEmail'];

  it('matches whole identifiers only, including inside quotes', () => {
    expect(matchName('row["customer_email"]', v)).toBe(true);
    expect(matchName('x = r.customerEmail;', v)).toBe(true);
    expect(matchName('customer_emails = 1', v)).toBe(false);
    expect(matchName('my_customer_email = 1', v)).toBe(false);
    expect(matchName('$customer_email = 1', v)).toBe(false);
    expect(matchName('customer_email2 = 1', v)).toBe(false);
  });

  it('matches at the very start and end of the line and next to punctuation', () => {
    expect(matchName('customer_email', v)).toBe(true);
    expect(matchName('f(a,customer_email)', v)).toBe(true);
    expect(matchName('x.customer_email.y', v)).toBe(true);
  });
});
