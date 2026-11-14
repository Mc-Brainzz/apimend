import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diffSpecs } from '../../src/diff/index.js';
import { buildBrief } from '../../src/fix/brief.js';
import { hostsFromSpec } from '../../src/impact/files.js';
import { findImpact } from '../../src/impact/index.js';
import type { BreakingChange, ImpactSite, OpenAPIDoc } from '../../src/types.js';

// The three deterministic stages composed on a small but realistic repo:
// the HTTP call lives in one file, the removed field is consumed in another.

const invoice = (props: Record<string, unknown>) => ({
  type: 'object',
  required: ['id', 'total'],
  properties: { id: { type: 'string' }, ...props },
});

const spec = (invoiceProps: Record<string, unknown>, withDelete: boolean): OpenAPIDoc => ({
  openapi: '3.0.3',
  servers: [{ url: 'https://api.acme.test' }],
  paths: {
    '/v1/invoices/{id}': {
      get: {
        operationId: 'getInvoice',
        responses: {
          '200': { content: { 'application/json': { schema: invoice(invoiceProps) } } },
        },
      },
      ...(withDelete ? { delete: { operationId: 'deleteInvoice', responses: {} } } : {}),
    },
    '/v1/invoices': { get: { operationId: 'listInvoices', responses: {} } },
  },
});

const oldDoc = spec({ total: { type: 'integer' }, customer_email: { type: 'string' } }, true);
const newDoc = spec({ total: { type: 'string' } }, false);

const FILES: Record<string, string> = {
  'src/client.ts': [
    'const BASE = "https://api.acme.test";',
    'export async function fetchInvoice(id: string) {',
    '  const res = await fetch(`${BASE}/v1/invoices/${id}`);',
    '  return res.json();',
    '}',
    'export async function removeInvoice(id: string) {',
    '  return fetch(`${BASE}/v1/invoices/${id}`, { method: "DELETE" });',
    '}',
    'export async function allInvoices() {',
    '  return fetch(`${BASE}/v1/invoices`);',
    '}',
  ].join('\n'),
  'src/report.ts': [
    'import { fetchInvoice } from "./client";',
    'export async function emailFor(id: string) {',
    '  const invoice = await fetchInvoice(id);',
    '  return invoice.customer_email;',
    '}',
  ].join('\n'),
  'src/math.ts': 'export const add = (a: number, b: number) => a + b;\n',
};

describe('diff -> impact -> brief', () => {
  let root = '';
  let changes: BreakingChange[] = [];
  let sites: ImpactSite[] = [];
  const byKind = (kind: string) => changes.find((c) => c.kind === kind);
  const at = (file: string, line: number) => sites.find((s) => s.file === file && s.line === line);

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'apimend-e2e-'));
    for (const [rel, text] of Object.entries(FILES)) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), text);
    }
    changes = diffSpecs(oldDoc, newDoc);
    sites = await findImpact(root, changes, {
      hosts: hostsFromSpec(oldDoc),
      allPaths: Object.keys(oldDoc.paths ?? {}),
    });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('finds the three breaking changes', () => {
    expect(changes.map((c) => c.kind).sort()).toEqual([
      'endpoint-removed',
      'response-field-removed',
      'response-field-type-changed',
    ]);
  });

  it('flags the GET call site with the field changes', () => {
    const site = at('src/client.ts', 3);
    expect(site?.signal).toBe('path');
    expect(site?.changeIds).toContain(byKind('response-field-removed')?.id);
    expect(site?.changeIds).toContain(byKind('response-field-type-changed')?.id);
  });

  it('ties the DELETE call site to the removed endpoint only', () => {
    expect(at('src/client.ts', 7)?.changeIds).toEqual([byKind('endpoint-removed')?.id]);
  });

  it('does not flag the list endpoint, which did not change', () => {
    expect(at('src/client.ts', 10)).toBeUndefined();
  });

  it('finds the removed field where it is consumed, in a file with no HTTP call', () => {
    const site = at('src/report.ts', 4);
    expect(site?.signal).toBe('field');
    // Must clear the CLI's default --min-confidence of 0.3, or the fix stage never sees it.
    expect(site?.confidence).toBeGreaterThanOrEqual(0.3);
  });

  it('leaves unrelated files alone and ranks call sites above field mentions', () => {
    expect(sites.some((s) => s.file === 'src/math.ts')).toBe(false);
    expect(at('src/client.ts', 3)?.confidence).toBeGreaterThan(at('src/report.ts', 4)?.confidence ?? 1);
    const confidences = sites.map((s) => s.confidence);
    expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
  });

  it('produces a brief that names both files and every change', () => {
    const brief = buildBrief(changes, sites);
    expect(brief).toContain('src/client.ts');
    expect(brief).toContain('src/report.ts');
    expect(brief).toContain('customer_email');
    expect(brief).toContain('endpoint removed');
  });
});
