import { describe, it, expect } from 'vitest';
import { normalizeLine, matchPaths } from '../../src/impact/path-match.js';

const T = '/v1/invoices/{id}';

describe('normalizeLine', () => {
  it('rewrites JS template interpolations, including one level of nested braces', () => {
    const a = normalizeLine('fetch(`${BASE}/v1/invoices/${id}`)');
    expect(a).toContain('/v1/invoices/{}');
    expect(a).not.toContain('${');
    expect(normalizeLine('x(`/v1/items/${pick({a: 1}).id}/y`)')).toContain('/v1/items/{}/y');
  });

  it('rewrites f-string / .format braces next to a slash', () => {
    expect(normalizeLine('requests.get(f"{base}/invoices/{invoice_id}")')).toContain('/invoices/{}');
    expect(normalizeLine('u = f"/v1/{kind}/list"')).toContain('/v1/{}/list');
  });

  it('rewrites %s, %d and %(name)s directly after a slash', () => {
    expect(normalizeLine('"/v1/invoices/%s" % i')).toContain('/v1/invoices/{}');
    expect(normalizeLine('"/v1/invoices/%d/lines" % i')).toContain('/v1/invoices/{}/lines');
    expect(normalizeLine('"/v1/invoices/%(inv)s/lines" % d')).toContain('/v1/invoices/{}/lines');
  });

  it('rewrites :name and <name> directly after a slash', () => {
    expect(normalizeLine('app.get("/v1/invoices/:id/lines", h)')).toContain('/v1/invoices/{}/lines');
    expect(normalizeLine('@app.route("/v1/invoices/<invoice_id>")')).toContain('/v1/invoices/{}');
  });

  it('collapses string concatenation around one expression, any quote style', () => {
    expect(normalizeLine('get("https://h.com/v1/invoices/" + id + "/lines")')).toContain('/v1/invoices/{}/lines');
    expect(normalizeLine("get('a/' + x + '/b')")).toContain('a/{}/b');
  });
});

describe('matchPaths', () => {
  it('matches a template literal with a base URL variable (matchedStatic 1, droppedStatic 0)', () => {
    const hits = matchPaths('fetch(`${BASE}/v1/invoices/${id}`)', [T]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ template: T, matchedStatic: 1, droppedStatic: 0 });
  });

  it('matches python f-string, host + concatenation, and a literal in the param slot', () => {
    const a = matchPaths('requests.get(f"{base}/invoices/{invoice_id}")', [T]);
    expect(a).toHaveLength(1);
    expect(a[0].matchedStatic).toBe(1);
    expect(matchPaths('axios.get("https://api.example.com/v1/invoices/" + id)', [T])).toHaveLength(1);
    expect(matchPaths('client.get("/v1/invoices/in_123")', [T])).toHaveLength(1);
  });

  it('rejects extra trailing segment, missing param segment, and a relative import path', () => {
    expect(matchPaths('fetch(`/v1/invoices/${id}/lines`)', [T])).toEqual([]);
    expect(matchPaths('fetch("/v1/invoices")', [T])).toEqual([]);
    expect(matchPaths('import x from "../invoices/index.js"', [T])).toEqual([]);
  });

  it('prefers the more specific template and returns one hit per path', () => {
    const hits = matchPaths('get("/v1/invoices/upcoming")', [T, '/v1/invoices/upcoming']);
    expect(hits).toHaveLength(1);
    expect(hits[0].template).toBe('/v1/invoices/upcoming');
  });

  it('does not count version-like segments in matchedStatic, but they must still match', () => {
    expect(matchPaths('get("/api/v1/users/42")', ['/api/v1/users/{id}'])[0].matchedStatic).toBe(1);
    expect(matchPaths('get("/2023-10-16/charges/ch_1")', ['/2023-10-16/charges/{id}'])[0].matchedStatic).toBe(1);
    expect(matchPaths('get("/v1/abc")', ['/v1/{id}'])).toEqual([]);
    expect(matchPaths('get("/v2/users/42")', ['/v1/users/{id}'])).toEqual([]);
  });

  it('reports droppedStatic > 0 when a leading template segment is absent from the code', () => {
    const hits = matchPaths('fetch(`${BASE}/invoices/${id}`)', ['/billing/invoices/{id}']);
    expect(hits).toHaveLength(1);
    expect(hits[0].droppedStatic).toBeGreaterThan(0);
  });

  it('allows a host in front of the path', () => {
    const hits = matchPaths('curl("https://api.example.com/v1/invoices/in_1")', ['/invoices/{id}']);
    expect(hits).toHaveLength(1);
    expect(hits[0].template).toBe('/invoices/{id}');
  });

  it('counts a trailing slash as one more {} segment', () => {
    expect(matchPaths('get("/v1/invoices/" + id)', [T])).toHaveLength(1);
    expect(matchPaths('get("/v1/invoices/")', [T])).toHaveLength(1);
  });

  // Lead's ruling on a spec gap: APIs written with trailing slashes
  // ("/users/") must still be found, so a trailing slash is read both ways.
  it('reads a trailing slash both ways, preferring {} only when a value is appended', () => {
    const both = ['/v1/invoices', T];
    expect(matchPaths('get("/v1/invoices/")', ['/v1/invoices'])).toHaveLength(1);
    expect(matchPaths('get("/v1/invoices/")', both)[0]?.template).toBe('/v1/invoices');
    expect(matchPaths('get("/v1/invoices/" + id)', both)[0]?.template).toBe(T);
  });

  it('handles python %s, .format and Express :id forms', () => {
    expect(matchPaths('requests.get("/v1/invoices/%s" % inv)', [T])).toHaveLength(1);
    expect(matchPaths('url = "/v1/invoices/{}".format(inv)', [T])).toHaveLength(1);
    expect(matchPaths('app.get("/v1/invoices/:id", handler)', [T])).toHaveLength(1);
  });

  it('matches a path with a concatenation in the middle against the longer template only', () => {
    const line = 'get("/v1/invoices/" + id + "/lines")';
    expect(matchPaths(line, ['/v1/invoices/{id}/lines'])).toHaveLength(1);
    expect(matchPaths(line, [T])).toEqual([]);
  });

  it('does not let a source-file name fill a param slot', () => {
    expect(matchPaths('open("/v1/invoices/views.py")', [T])).toEqual([]);
    expect(matchPaths('load("/v1/invoices/index.js")', [T])).toEqual([]);
    expect(matchPaths('open("/v1/invoices/in_123")', [T])).toHaveLength(1);
  });
});
