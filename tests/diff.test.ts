import { describe, it, expect } from 'vitest';
import { diffSpecs } from '../src/diff/index.js';
import type { OpenAPIDoc } from '../src/types.js';

type Any = Record<string, any>;

const str = { type: 'string' };
const int = { type: 'integer' };
const obj = (properties: Any, required: string[] = []) => ({ type: 'object', properties, required });
const doc = (paths: Any): OpenAPIDoc => ({ openapi: '3.0.3', paths });
const query = (name: string, schema: Any = str, extra: Any = {}) => ({ name, in: 'query', schema, ...extra });
const reqBody = (schema: Any, mt = 'application/json') => ({ requestBody: { content: { [mt]: { schema } } } });
const resp = (schema: Any, status = '200', mt = 'application/json') => ({
  responses: { [status]: { content: { [mt]: { schema } } } },
});
/** Diff two versions of a single GET /x operation. */
const diff = (a: Any, b: Any) => diffSpecs(doc({ '/x': { get: a } }), doc({ '/x': { get: b } }));
const names = (cs: { name?: string }[]) => cs.map((c) => c.name);

describe('diffSpecs: rules', () => {
  it('endpoint-removed: reports only the removal; new-only operations are ignored', () => {
    const a = doc({
      '/a': { get: { parameters: [query('q')], ...resp(obj({ id: str })) } },
      '/b': { get: {} },
    });
    const b = doc({ '/b': { get: {} }, '/c': { post: {} } });
    expect(diffSpecs(a, b)).toMatchObject([
      { id: 'endpoint-removed|GET|/a|||', kind: 'endpoint-removed', severity: 'breaking', method: 'GET', path: '/a' },
    ]);
  });

  it('param-removed', () => {
    expect(diff({ parameters: [query('q')] }, {})).toMatchObject([
      { kind: 'param-removed', severity: 'warning', in: 'query', name: 'q' },
    ]);
  });

  it('param-required-added: new required param, or optional made required', () => {
    const out = diff(
      { parameters: [query('a')] },
      { parameters: [query('a', str, { required: true }), query('b', str, { required: true })] },
    );
    expect(out).toMatchObject([
      { kind: 'param-required-added', severity: 'breaking', in: 'query', name: 'a' },
      { kind: 'param-required-added', severity: 'breaking', in: 'query', name: 'b' },
    ]);
  });

  it('param-type-changed', () => {
    expect(diff({ parameters: [query('n', str)] }, { parameters: [query('n', int)] })).toMatchObject([
      { kind: 'param-type-changed', severity: 'breaking', in: 'query', name: 'n', before: 'string', after: 'integer' },
    ]);
  });

  it('request-field-removed', () => {
    const out = diff(reqBody(obj({ a: str, b: str })), reqBody(obj({ a: str })));
    expect(out).toMatchObject([
      { kind: 'request-field-removed', severity: 'warning', in: 'request', name: 'b' },
    ]);
  });

  it('request-field-required-added: new or newly-required top-level field', () => {
    const out = diff(
      reqBody(obj({ a: str })),
      reqBody(obj({ a: str, b: str }, ['a', 'b'])),
    );
    expect(out).toMatchObject([
      { kind: 'request-field-required-added', severity: 'breaking', in: 'request', name: 'a' },
      { kind: 'request-field-required-added', severity: 'breaking', in: 'request', name: 'b' },
    ]);
  });

  it('request-field-type-changed', () => {
    const out = diff(reqBody(obj({ a: str })), reqBody(obj({ a: int })));
    expect(out).toMatchObject([
      { kind: 'request-field-type-changed', severity: 'breaking', in: 'request', name: 'a', before: 'string', after: 'integer' },
    ]);
  });

  // Found on Stripe 2025-03-31.basil: `cancel_at` went from integer to
  // anyOf[integer, enum]. Old callers still work, so this must not be reported.
  it('does not report a type widened to a union (anyOf / oneOf)', () => {
    const widened = { anyOf: [int, { type: 'string', enum: ['max_period_end'] }] };
    expect(diff(reqBody(obj({ a: int })), reqBody(obj({ a: widened })))).toEqual([]);
    expect(diff(resp(obj({ a: int })), resp(obj({ a: widened })))).toEqual([]);
  });

  it('request-enum-value-removed', () => {
    const e = (vals: string[]) => reqBody(obj({ s: { type: 'string', enum: vals } }));
    expect(diff(e(['c', 'a', 'b']), e(['a']))).toMatchObject([
      { kind: 'request-enum-value-removed', severity: 'breaking', in: 'request', name: 's', values: ['b', 'c'] },
    ]);
  });

  it('response-field-removed', () => {
    const out = diff(resp(obj({ a: str, b: str })), resp(obj({ a: str })));
    expect(out).toMatchObject([
      { kind: 'response-field-removed', severity: 'breaking', in: 'response', status: '200', name: 'b' },
    ]);
  });

  it('response-field-type-changed', () => {
    const out = diff(resp(obj({ a: int })), resp(obj({ a: str })));
    expect(out).toMatchObject([
      { kind: 'response-field-type-changed', severity: 'breaking', in: 'response', status: '200', name: 'a', before: 'integer', after: 'string' },
    ]);
  });

  it('response-field-became-optional: not-required or nullable; old nullable is exempt', () => {
    const before = resp(obj({ a: str, b: str, c: { ...str, nullable: true } }, ['a', 'b', 'c']));
    const after = resp(obj({ a: str, b: { ...str, nullable: true }, c: str }, ['b', 'c']));
    // a: required -> optional; b: required -> nullable; c: was nullable already -> not reported
    expect(diff(before, after)).toMatchObject([
      { kind: 'response-field-became-optional', severity: 'warning', in: 'response', status: '200', name: 'a' },
      { kind: 'response-field-became-optional', severity: 'warning', in: 'response', status: '200', name: 'b' },
    ]);
  });

  it('response-enum-value-added', () => {
    const e = (vals: string[]) => resp(obj({ s: { type: 'string', enum: vals } }));
    expect(diff(e(['a']), e(['a', 'c', 'b']))).toMatchObject([
      { kind: 'response-enum-value-added', severity: 'warning', in: 'response', status: '200', name: 's', values: ['b', 'c'] },
    ]);
  });
});

describe('diffSpecs: end to end and matching', () => {
  const invoice = (total: Any, extra: Any, params: Any[]) =>
    doc({
      '/v1/invoices/{id}': {
        get: {
          operationId: 'getInvoice',
          parameters: [{ name: 'id', in: 'path', required: true, schema: str }, ...params],
          ...resp(obj({ id: str, total, ...extra }, ['id', 'total'])),
        },
      },
    });

  it('reproduces the spec worked example exactly (and doc vs itself is empty)', () => {
    const oldDoc = invoice(int, { customer_email: str }, [query('expand')]);
    const newDoc = invoice(str, {}, []);
    const base = { method: 'GET', path: '/v1/invoices/{id}', operationId: 'getInvoice', message: expect.any(String) };
    const out = diffSpecs(oldDoc, newDoc);
    expect(out).toEqual([
      { ...base, id: 'param-removed|GET|/v1/invoices/{id}|query||expand', kind: 'param-removed', severity: 'warning', in: 'query', name: 'expand' },
      { ...base, id: 'response-field-removed|GET|/v1/invoices/{id}|response|200|customer_email', kind: 'response-field-removed', severity: 'breaking', in: 'response', status: '200', name: 'customer_email' },
      { ...base, id: 'response-field-type-changed|GET|/v1/invoices/{id}|response|200|total', kind: 'response-field-type-changed', severity: 'breaking', in: 'response', status: '200', name: 'total', before: 'integer', after: 'string' },
    ]);
    expect(out.every((c) => typeof c.message === 'string' && c.message.length > 0)).toBe(true);
    expect(diffSpecs(oldDoc, oldDoc)).toEqual([]);
  });

  it('normalises paths: {id} vs {userId} and a trailing slash are the same operation', () => {
    const a = doc({ '/users/{id}': { get: { parameters: [query('q')] } } });
    const same = doc({ '/users/{userId}/': { get: { parameters: [query('q')] } } });
    const dropped = doc({ '/users/{userId}/': { get: {} } });
    expect(diffSpecs(a, same)).toEqual([]);
    expect(diffSpecs(a, dropped)).toMatchObject([{ kind: 'param-removed', path: '/users/{id}' }]);
  });

  it('compares header names case-insensitively and reports them lower-case', () => {
    const h = (name: string) => ({ parameters: [{ name, in: 'header', schema: str }] });
    expect(diff(h('X-Request-ID'), h('x-request-id'))).toEqual([]);
    expect(diff(h('X-Trace-Id'), {})).toMatchObject([
      { kind: 'param-removed', in: 'header', name: 'x-trace-id' },
    ]);
  });

  it('prefers json, then form-urlencoded, then multipart, then the first media type', () => {
    const form = 'application/x-www-form-urlencoded';
    // form-only body is used when it is all there is
    expect(diff(reqBody(obj({ a: str }), form), reqBody(obj({}), form))).toMatchObject([
      { kind: 'request-field-removed', name: 'a' },
    ]);
    // json wins over form in the old operation, so form-only differences are ignored
    const both = (formSchema: Any) => ({
      requestBody: { content: { 'application/json': { schema: obj({ a: str }) }, [form]: { schema: formSchema } } },
    });
    expect(diff(both(obj({ b: str })), both(obj({})))).toEqual([]);
    // new lacks the chosen media type: request-field checks are skipped
    expect(diff(reqBody(obj({ a: str })), reqBody(obj({}), form))).toEqual([]);
  });

  it('never throws on odd input', () => {
    expect(diffSpecs({ openapi: '3.0.3' }, { openapi: '3.0.3' })).toEqual([]);
    const odd = doc({ '/a': { get: null, post: { parameters: [{ name: 'q', in: 'query' }] } } });
    expect(() => diffSpecs(odd, odd)).not.toThrow();
    expect(() => diffSpecs(odd, { openapi: '3.0.3' })).not.toThrow();
  });
});

describe('diffSpecs: suppression', () => {
  it('removed subtree: descendants of a removed field are not reported', () => {
    const before = reqBody(
      obj({
        keep: str,
        obj: obj({ x: str, y: obj({ z: str }) }),
        arr: { type: 'array', items: obj({ k: str }) },
      }),
    );
    const out = diff(before, reqBody(obj({ keep: str })));
    expect(names(out)).toEqual(['arr', 'obj']);
    expect(out.every((c) => c.kind === 'request-field-removed')).toBe(true);
  });

  it('added subtree: a new required object reports itself only; a new optional one reports nothing', () => {
    const out = diff(
      reqBody(obj({ a: str })),
      reqBody(obj({ a: str, o: obj({ c: str }, ['c']), p: obj({ d: str }, ['d']) }, ['o'])),
    );
    expect(out).toMatchObject([{ kind: 'request-field-required-added', name: 'o' }]);
    expect(out).toHaveLength(1);
  });

  it('type-changed subtree: descendants of a retyped field are not compared', () => {
    const out = diff(resp(obj({ o: obj({ x: str }) })), resp(obj({ o: str })));
    expect(out).toMatchObject([
      { kind: 'response-field-type-changed', name: 'o', before: 'object', after: 'string' },
    ]);
    expect(out).toHaveLength(1);
  });
});
