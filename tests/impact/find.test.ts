import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSourceFiles, hostsFromSpec } from '../../src/impact/files.js';
import { findImpact } from '../../src/impact/index.js';
import type { BreakingChange, OpenAPIDoc } from '../../src/types.js';

const roots: string[] = [];

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'apimend-impact-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return root;
}

afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});

function change(o: Partial<Omit<BreakingChange, 'id'>> = {}): BreakingChange {
  const c: Omit<BreakingChange, 'id'> = {
    kind: 'response-field-removed',
    severity: 'breaking',
    method: 'GET',
    path: '/v1/invoices/{id}',
    message: 'test change',
    ...o,
  };
  return { id: [c.kind, c.method, c.path, c.in ?? '', c.status ?? '', c.name ?? ''].join('|'), ...c };
}

describe('listSourceFiles', () => {
  let root: string;
  const kept = [
    'src/a.ts', 'src/b.tsx', 'lib/c.py', 'w.jsx', 'x.mjs', 'y.cjs', 'z.js',
    'src/sub/d.ts', 'src/outer/keep.ts',
  ];
  beforeAll(async () => {
    const files: Record<string, string> = {};
    for (const k of kept) files[k] = 'x = 1\n';
    for (const d of [
      'notes.md', 'data.json', 'node_modules/pkg/index.js', 'src/node_modules/deep.js',
      'dist/o.js', 'build/b.js', 'out/o.js', 'vendor/v.py', '.venv/x.py', 'venv/y.py',
      '__pycache__/z.py', '.next/n.js', 'coverage/c.js', 'app.min.js', 'types.d.ts', 'src/api.d.ts',
    ]) files[d] = 'x = 1\n';
    files['big.js'] = 'a'.repeat(513 * 1024);
    root = await makeTree(files);
  });

  it('keeps only source extensions and drops excluded dirs, .min.js, .d.ts and files over 512 KB', async () => {
    const out = await listSourceFiles(root);
    expect([...out].sort()).toEqual([...kept].sort());
  });

  it('returns repo-relative forward-slash paths sorted ascending', async () => {
    const out = await listSourceFiles(root);
    expect(out).toEqual([...out].sort());
    expect(out).toContain('src/sub/d.ts');
    expect(out.every((p) => !p.includes('\\') && !path.isAbsolute(p))).toBe(true);
  });
});

describe('hostsFromSpec', () => {
  it('lower-cases, de-duplicates in order, and skips relative, templated and local URLs', () => {
    const doc = {
      openapi: '3.0.0',
      servers: [
        { url: 'https://API.Example.com/v1' },
        { url: '/relative' },
        { url: 'https://{region}.example.com' },
        { url: 'http://localhost:3000' },
        { url: 'http://127.0.0.1:8080' },
        { url: 'https://api.example.com/other' },
        { url: 'https://eu.example.com' },
      ],
    } as OpenAPIDoc;
    expect(hostsFromSpec(doc)).toEqual(['api.example.com', 'eu.example.com']);
  });
});

describe('findImpact', () => {
  it('sorts by confidence desc, then file asc, then line asc', async () => {
    const root = await makeTree({
      'a.ts': 'const e = row.customer_email;\n',
      'b.ts': 'fetch("/v1/invoices/" + id);\n\n\n\nfetch("/v1/invoices/" + id);\n',
      'c.ts': 'fetch("/v1/invoices/" + id);\n',
    });
    const c1 = change();
    const c2 = change({ path: '/v1/customers/{id}', name: 'customer_email', in: 'response', status: '200' });
    const sites = await findImpact(root, [c1, c2]);
    expect(sites.map((s) => `${s.file}:${s.line}`)).toEqual(['b.ts:1', 'b.ts:5', 'c.ts:1', 'a.ts:1']);
    for (let i = 1; i < sites.length; i++) {
      expect(sites[i - 1].confidence).toBeGreaterThanOrEqual(sites[i].confidence);
    }
  });

  it('returns [] for no changes, even for a directory that does not exist', async () => {
    await expect(findImpact(path.join(os.tmpdir(), 'apimend-does-not-exist-xyz'), [])).resolves.toEqual([]);
  });
});
