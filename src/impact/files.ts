import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { OpenAPIDoc } from '../types.js';

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'vendor', '.venv', 'venv',
  '__pycache__', '.next', 'coverage',
]);
const MAX_BYTES = 512 * 1024;

function wantedName(rel: string): boolean {
  const segments = rel.split('/');
  const base = segments[segments.length - 1] ?? '';
  for (const seg of segments.slice(0, -1)) {
    if (SKIP_DIRS.has(seg)) return false;
  }
  if (base.endsWith('.min.js') || base.endsWith('.d.ts')) return false;
  return EXTENSIONS.has(path.extname(base));
}

async function smallFile(abs: string): Promise<boolean> {
  try {
    const s = await stat(abs);
    return s.isFile() && s.size <= MAX_BYTES;
  } catch {
    return false;
  }
}

function gitFiles(repoDir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: repoDir, maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.split('\0').filter((p) => p.length > 0));
      },
    );
  });
}

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  for (const e of entries) {
    const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, childRel, out);
    } else if (e.isFile()) {
      out.push(childRel);
    }
  }
}

async function gitOrWalk(repoDir: string): Promise<string[]> {
  let hasGit = false;
  try {
    await stat(path.join(repoDir, '.git'));
    hasGit = true;
  } catch {
    hasGit = false;
  }
  if (hasGit) {
    try {
      return await gitFiles(repoDir);
    } catch {
      // fall through to the directory walk
    }
  }
  const out: string[] = [];
  await walk(repoDir, '', out);
  return out;
}

export async function listSourceFiles(repoDir: string): Promise<string[]> {
  const candidates = await gitOrWalk(repoDir);
  const kept = new Set<string>();
  for (const raw of candidates) {
    const rel = raw.replace(/\\/g, '/');
    if (!wantedName(rel)) continue;
    if (await smallFile(path.join(repoDir, rel))) kept.add(rel);
  }
  return [...kept].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function hostsFromSpec(doc: OpenAPIDoc): string[] {
  const servers = doc['servers'];
  if (!Array.isArray(servers)) return [];
  const hosts: string[] = [];
  for (const s of servers as unknown[]) {
    if (typeof s !== 'object' || s === null) continue;
    const url = (s as Record<string, unknown>)['url'];
    if (typeof url !== 'string' || url.includes('{')) continue;
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (host === '' || host === 'localhost' || host === '127.0.0.1') continue;
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}
