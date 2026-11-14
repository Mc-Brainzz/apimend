import { describe, it, expect } from 'vitest';
import { flattenSchema } from '../src/diff/flatten.js';
import { resolveRef } from '../src/spec/resolve.js';
import type { OpenAPIDoc, SchemaObject } from '../src/types.js';

const doc = (schemas: Record<string, unknown> = {}): OpenAPIDoc => ({
  openapi: '3.0.3',
  components: { schemas },
});
const flat = (schema: SchemaObject, d: OpenAPIDoc = doc()) =>
  Object.fromEntries(flattenSchema(d, schema));
const str = { type: 'string' };

describe('flattenSchema', () => {
  it('flattens the spec table example', () => {
    const out = flat({
      type: 'object',
      required: ['id'],
      properties: {
        id: str,
        status: { type: 'string', enum: ['open', 'paid'] },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            required: ['amount'],
            properties: { amount: { type: 'integer' }, note: { type: 'string', nullable: true } },
          },
        },
      },
    });
    expect(out).toEqual({
      id: { type: 'string', required: true, nullable: false },
      status: { type: 'string', required: false, nullable: false, enum: ['open', 'paid'] },
      lines: { type: 'array', required: false, nullable: false },
      'lines[]': { type: 'object', required: true, nullable: false },
      'lines[].amount': { type: 'integer', required: true, nullable: false },
      'lines[].note': { type: 'string', required: false, nullable: true },
    });
  });

  it('merges allOf members (refs resolved, later wins, required unioned)', () => {
    const d = doc({ Extra: { required: ['c'], properties: { b: str, c: { type: 'boolean' } } } });
    const out = flat(
      {
        allOf: [
          { type: 'object', required: ['a'], properties: { a: str, b: { type: 'integer' } } },
          { $ref: '#/components/schemas/Extra' },
        ],
      },
      d,
    );
    expect(out).toEqual({
      a: { type: 'string', required: true, nullable: false },
      // b and c are declared in the referenced component, so they carry its origin.
      b: { type: 'string', required: false, nullable: false, origin: 'Extra.b' },
      c: { type: 'boolean', required: true, nullable: false, origin: 'Extra.c' },
    });
  });

  it('unions oneOf branch properties as optional', () => {
    const out = flat({
      type: 'object',
      oneOf: [
        { type: 'object', required: ['a'], properties: { a: str } },
        { type: 'object', required: ['b'], properties: { b: { type: 'integer' } } },
      ],
    });
    expect(out).toEqual({
      a: { type: 'string', required: false, nullable: false },
      b: { type: 'integer', required: false, nullable: false },
    });
  });

  it('uses [] paths for a root array', () => {
    const out = flat({
      type: 'array',
      items: { type: 'object', required: ['id'], properties: { id: str } },
    });
    expect(out).toEqual({
      '[]': { type: 'object', required: true, nullable: false },
      '[].id': { type: 'string', required: true, nullable: false },
    });
  });

  it('handles OpenAPI 3.1 type arrays and nullability', () => {
    const out = flat({
      type: 'object',
      properties: {
        s: { type: ['string', 'null'] },
        m: { type: ['string', 'integer'] },
        n: { type: ['null'] },
      },
    });
    expect(out.s).toMatchObject({ type: 'string', nullable: true });
    expect(out.m).toMatchObject({ type: 'integer|string', nullable: false });
    expect(out.n).toMatchObject({ type: 'null', nullable: true });
  });

  it('falls back to object/array/union/any when type is absent', () => {
    const out = flat({
      type: 'object',
      properties: {
        o: { properties: { x: str } },
        a: { items: str },
        u: { oneOf: [str, { type: 'integer' }] },
        z: {},
      },
    });
    expect([out.o?.type, out.a?.type, out.u?.type, out.z?.type]).toEqual([
      'object',
      'array',
      'union',
      'any',
    ]);
  });

  it('terminates on a self-referencing $ref', () => {
    const d = doc({
      Node: {
        type: 'object',
        properties: { name: str, next: { $ref: '#/components/schemas/Node' } },
      },
    });
    const out = flat({ $ref: '#/components/schemas/Node' }, d);
    expect(out.name?.type).toBe('string');
    expect(out.next?.type).toBe('object');
    expect(Object.keys(out).every((k) => k.split('.').length <= 12)).toBe(true);
  });
});

describe('resolveRef', () => {
  it('follows pointers with ~1/~0 unescaping and ref chains', () => {
    const d: OpenAPIDoc = {
      openapi: '3.0.3',
      paths: { '/users': { get: { operationId: 'x' } } },
      components: {
        schemas: {
          'a~b': { type: 'integer' },
          Alias: { $ref: '#/components/schemas/Real' },
          Real: { type: 'string' },
        },
      },
    };
    expect(resolveRef(d, { $ref: '#/paths/~1users/get' })).toEqual({ operationId: 'x' });
    expect(resolveRef(d, { $ref: '#/components/schemas/a~0b' })).toEqual({ type: 'integer' });
    expect(resolveRef(d, { $ref: '#/components/schemas/Alias' })).toEqual({ type: 'string' });
  });

  it('returns {} for external, dangling and over-long refs; others unchanged', () => {
    const schemas: Record<string, unknown> = { S24: { type: 'string' } };
    for (let i = 0; i < 24; i++) schemas[`S${i}`] = { $ref: `#/components/schemas/S${i + 1}` };
    const d = doc(schemas);
    expect(resolveRef(d, { $ref: 'other.yaml#/X' })).toEqual({});
    expect(resolveRef(d, { $ref: '#/components/schemas/Missing' })).toEqual({});
    expect(resolveRef(d, { $ref: '#/components/schemas/S0' })).toEqual({});
    const plain = { type: 'string' };
    expect(resolveRef(d, plain)).toBe(plain);
  });
});
