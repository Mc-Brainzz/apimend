import { describe, it, expect } from 'vitest';
import { flattenSchema } from '../src/diff/flatten.js';
import type { OpenAPIDoc, SchemaObject } from '../src/types.js';

const ref = (name: string): SchemaObject => ({ $ref: `#/components/schemas/${name}` });

function flat(schemas: Record<string, unknown>, root: SchemaObject) {
  const doc = { openapi: '3.0.3', paths: {}, components: { schemas } } as OpenAPIDoc;
  return flattenSchema(doc, root);
}

const invoiceSchemas = {
  invoice: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      customer: ref('customer'),
      lines: { type: 'array', items: ref('line') },
      settings: { type: 'object', properties: { days: { type: 'integer' } } },
    },
  },
  customer: { type: 'object', properties: { email: { type: 'string' } } },
  line: { type: 'object', properties: { amount: { type: 'integer' } } },
};

describe('FieldInfo.origin', () => {
  it('matches every row of the spec example table', () => {
    const map = flat(invoiceSchemas, ref('invoice'));
    const expected: Record<string, string> = {
      id: 'invoice.id',
      customer: 'invoice.customer',
      'customer.email': 'customer.email',
      lines: 'invoice.lines',
      'lines[]': 'invoice.lines[]',
      'lines[].amount': 'line.amount',
      settings: 'invoice.settings',
      'settings.days': 'invoice.settings.days',
    };
    for (const [path, origin] of Object.entries(expected)) {
      expect(map.has(path), path).toBe(true);
      expect(map.get(path)!.origin, path).toBe(origin);
    }
  });

  it('gives no origin to an inline wrapper but follows the ref inside', () => {
    const wrapper = {
      type: 'object',
      properties: { data: { type: 'array', items: ref('invoice') } },
    };
    const map = flat(invoiceSchemas, wrapper);
    expect('origin' in map.get('data')!).toBe(false);
    expect('origin' in map.get('data[]')!).toBe(false);
    expect(map.get('data[].id')!.origin).toBe('invoice.id');
  });

  it('gives a ref inside an inline root no origin on the property itself', () => {
    const root = { type: 'object', properties: { customer: ref('customer') } };
    const map = flat(invoiceSchemas, root);
    expect('origin' in map.get('customer')!).toBe(false);
    expect(map.get('customer.email')!.origin).toBe('customer.email');
  });

  it('handles an anyOf branch that is a $ref', () => {
    const schemas = {
      invoice: {
        type: 'object',
        properties: {
          customer: { anyOf: [{ type: 'string' }, ref('customer')] },
        },
      },
      customer: { type: 'object', properties: { email: { type: 'string' } } },
    };
    const map = flat(schemas, ref('invoice'));
    expect(map.get('customer')!.origin).toBe('invoice.customer');
    expect(map.get('customer.email')!.origin).toBe('customer.email');
  });

  it('handles an allOf member that is a $ref', () => {
    const schemas = {
      animal: { type: 'object', properties: { name: { type: 'string' } } },
      dog: {
        allOf: [
          ref('animal'),
          { type: 'object', properties: { bark: { type: 'boolean' } } },
        ],
      },
    };
    const map = flat(schemas, ref('dog'));
    expect(map.get('name')!.origin).toBe('animal.name');
    expect(map.get('bark')!.origin).toBe('dog.bark');
  });

  it('produces no origin key on any entry when there is no $ref', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        lines: {
          type: 'array',
          items: { type: 'object', properties: { amount: { type: 'integer' } } },
        },
      },
    };
    const map = flat({}, schema);
    expect(map.size).toBeGreaterThan(0);
    for (const [path, info] of map) {
      expect('origin' in info, path).toBe(false);
    }
  });

  it('unescapes ~1 in the component name', () => {
    const schemas = {
      'a/b': { type: 'object', properties: { id: { type: 'string' } } },
    };
    const map = flat(schemas, { $ref: '#/components/schemas/a~1b' });
    expect(map.get('id')!.origin).toBe('a/b.id');
  });

  it('gives the same origin to a shared component reached by different paths', () => {
    const root = {
      type: 'object',
      properties: { billing: ref('customer'), shipping: ref('customer') },
    };
    const map = flat(invoiceSchemas, root);
    expect(map.get('billing.email')!.origin).toBe('customer.email');
    expect(map.get('shipping.email')!.origin).toBe('customer.email');
  });

  it('assigns some component-based origin through a chain of refs', () => {
    // Only the shape is asserted: which of A / B is the component is left open.
    const schemas = {
      A: ref('B'),
      B: { type: 'object', properties: { id: { type: 'string' } } },
    };
    const map = flat(schemas, ref('A'));
    const origin = map.get('id')!.origin;
    expect(origin).toBeDefined();
    expect(origin!.endsWith('.id')).toBe(true);
  });
});
