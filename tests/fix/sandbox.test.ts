import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveInside,
  readFileTool,
  searchTool,
  replaceTool,
  runTests,
} from '../../src/fix/sandbox.js';
import { SandboxError } from '../../src/types.js';

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'apimend-'));
const root = path.join(base, 'root');
const outside = path.join(base, 'outside');
await fs.mkdir(root, { recursive: true });
await fs.mkdir(outside, { recursive: true });
await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');

// Symlink support probe (EPERM on unprivileged Windows) done at collection time.
let linkOk = false;
try {
  await fs.symlink(outside, path.join(root, 'link'), 'dir');
  linkOk = true;
} catch {
  try {
    if (process.platform === 'win32') {
      await fs.symlink(outside, path.join(root, 'link'), 'junction');
      linkOk = true;
    }
  } catch {
    linkOk = false;
  }
}

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

const write = async (rel: string, content: string | Buffer) => {
  const p = path.join(root, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
};
const lines = (n: number, prefix = 'l') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

describe('resolveInside', () => {
  beforeAll(async () => {
    await write('a/b/c.txt', 'x');
  });

  it('accepts nested relative paths with / and \\ separators', async () => {
    const want = path.join('a', 'b', 'c.txt');
    const p1 = await resolveInside(root, 'a/b/c.txt');
    const p2 = await resolveInside(root, 'a\\b\\c.txt');
    expect(path.isAbsolute(p1)).toBe(true);
    expect(p1.endsWith(want)).toBe(true);
    expect(p2.endsWith(want)).toBe(true);
  });

  it('rejects the empty string', async () => {
    await expect(resolveInside(root, '')).rejects.toBeInstanceOf(SandboxError);
  });

  it('rejects absolute paths, even ones pointing inside root', async () => {
    await expect(resolveInside(root, '/etc/passwd')).rejects.toBeInstanceOf(SandboxError);
    await expect(resolveInside(root, path.join(root, 'a', 'b', 'c.txt'))).rejects.toBeInstanceOf(
      SandboxError,
    );
  });

  it('rejects Windows drive-absolute paths', async () => {
    await expect(resolveInside(root, 'C:\\x')).rejects.toBeInstanceOf(SandboxError);
  });

  it('rejects UNC paths', async () => {
    await expect(resolveInside(root, '\\\\server\\share\\x')).rejects.toBeInstanceOf(SandboxError);
  });

  it('rejects .. escapes, including a/../../x and a .. hidden mid-path', async () => {
    await expect(resolveInside(root, '../x')).rejects.toBeInstanceOf(SandboxError);
    await expect(resolveInside(root, 'a/../../x')).rejects.toBeInstanceOf(SandboxError);
    await expect(resolveInside(root, 'a/b/../../../x')).rejects.toBeInstanceOf(SandboxError);
  });

  it('rejects .git at any depth', async () => {
    await expect(resolveInside(root, '.git/config')).rejects.toBeInstanceOf(SandboxError);
    await expect(resolveInside(root, 'sub/.git/hooks/x')).rejects.toBeInstanceOf(SandboxError);
  });

  it.skipIf(!linkOk)('rejects a symlink inside root pointing outside it', async () => {
    await expect(resolveInside(root, 'link/secret.txt')).rejects.toBeInstanceOf(SandboxError);
    await expect(resolveInside(root, 'link/new-file.txt')).rejects.toBeInstanceOf(SandboxError);
  });
});

describe('readFileTool', () => {
  it('returns <line>\\t<text> lines joined by newline', async () => {
    await write('r1.txt', 'alpha\nbeta\ngamma');
    expect(await readFileTool(root, { path: 'r1.txt' })).toBe('1\talpha\n2\tbeta\n3\tgamma');
  });

  it('caps the default read at 400 lines and appends the note', async () => {
    await write('r2.txt', lines(450).join('\n'));
    const out = await readFileTool(root, { path: 'r2.txt' });
    const parts = out.split('\n');
    expect(parts).toHaveLength(401);
    expect(parts[0]).toBe('1\tl1');
    expect(parts[399]).toBe('400\tl400');
    expect(parts[400]).toBe('(file has 450 lines; showing 1-400)');
  });

  it('returns an explicit range', async () => {
    await write('r3.txt', lines(10).join('\n'));
    const out = await readFileTool(root, { path: 'r3.txt', start_line: 3, end_line: 5 });
    expect(out).toBe('3\tl3\n4\tl4\n5\tl5\n(file has 10 lines; showing 3-5)');
  });

  it('returns Error: strings (never throws) for escapes and NUL bytes', async () => {
    await write('bin.dat', Buffer.from([0x61, 0x00, 0x62]));
    const esc = await readFileTool(root, { path: '../outside/secret.txt' });
    const nul = await readFileTool(root, { path: 'bin.dat' });
    expect(esc.startsWith('Error: ')).toBe(true);
    expect(esc).not.toContain('secret');
    expect(nul.startsWith('Error: ')).toBe(true);
  });
});

describe('searchTool', () => {
  beforeAll(async () => {
    await write('s/a.ts', 'one\n    const foo = 1;   \nthree');
    await write('s/sub/c.ts', 'foo in sub');
    await write('s/unlisted.ts', 'foo unlisted');
    await write('s/many.ts', lines(70, 'hit').join('\n'));
  });

  it('formats file:line: trimmed text and searches only the given files', async () => {
    const out = await searchTool(root, ['s/a.ts', 's/sub/c.ts'], { pattern: 'foo' });
    expect(out).toBe('s/a.ts:2: const foo = 1;\ns/sub/c.ts:1: foo in sub');
  });

  it('narrows by path_prefix and returns No matches. when nothing hits', async () => {
    const files = ['s/a.ts', 's/sub/c.ts'];
    expect(await searchTool(root, files, { pattern: 'foo', path_prefix: 's/sub' })).toBe(
      's/sub/c.ts:1: foo in sub',
    );
    expect(await searchTool(root, files, { pattern: 'zzz-nothing' })).toBe('No matches.');
  });

  it('returns an Error: string for an invalid regex', async () => {
    const out = await searchTool(root, ['s/a.ts'], { pattern: '(' });
    expect(out.startsWith('Error: ')).toBe(true);
  });

  it('caps at 60 matches and appends the note', async () => {
    const out = await searchTool(root, ['s/many.ts'], { pattern: '^hit' });
    const parts = out.split('\n');
    expect(parts).toHaveLength(61);
    expect(parts[0]).toBe('s/many.ts:1: hit1');
    expect(parts[59]).toBe('s/many.ts:60: hit60');
    expect(parts[60]).toBe('(more matches not shown; narrow the pattern)');
  });
});

describe('replaceTool', () => {
  const read = (rel: string) => fs.readFile(path.join(root, rel));

  it('replaces once, writes the file and records a forward-slash path in changed', async () => {
    await write('p/f.txt', 'hello world');
    const changed = new Set<string>();
    const out = await replaceTool(root, changed, {
      path: 'p\\f.txt',
      old_text: 'world',
      new_text: 'there',
    });
    expect(out.startsWith('Replaced 1 occurrence')).toBe(true);
    expect((await read('p/f.txt')).toString()).toBe('hello there');
    expect([...changed]).toEqual(['p/f.txt']);
  });

  it('errors on zero and on multiple matches, leaving the file byte-identical', async () => {
    await write('p/g.txt', 'ab ab cd');
    const before = await read('p/g.txt');
    const changed = new Set<string>();
    const none = await replaceTool(root, changed, { path: 'p/g.txt', old_text: 'zz', new_text: 'y' });
    const two = await replaceTool(root, changed, { path: 'p/g.txt', old_text: 'ab', new_text: 'y' });
    expect(none.startsWith('Error: ')).toBe(true);
    expect(none).toMatch(/\b0\b/);
    expect(two.startsWith('Error: ')).toBe(true);
    expect(two).toMatch(/\b2\b/);
    expect((await read('p/g.txt')).equals(before)).toBe(true);
    expect(changed.size).toBe(0);
  });

  it('errors on empty old_text and leaves the file untouched', async () => {
    await write('p/h.txt', 'abc');
    const changed = new Set<string>();
    const out = await replaceTool(root, changed, { path: 'p/h.txt', old_text: '', new_text: 'x' });
    expect(out.startsWith('Error: ')).toBe(true);
    expect((await read('p/h.txt')).toString()).toBe('abc');
    expect(changed.size).toBe(0);
  });

  it('keeps a CRLF file CRLF when the model sends \\n text', async () => {
    await write('p/crlf.txt', 'a\r\nb\r\nc\r\n');
    const out = await replaceTool(root, new Set(), {
      path: 'p/crlf.txt',
      old_text: 'a\nb',
      new_text: 'x\ny',
    });
    expect(out.startsWith('Error: ')).toBe(false);
    expect((await read('p/crlf.txt')).toString()).toBe('x\r\ny\r\nc\r\n');
  });

  it('errors for a missing file without creating it', async () => {
    const out = await replaceTool(root, new Set(), {
      path: 'p/missing.txt',
      old_text: 'a',
      new_text: 'b',
    });
    expect(out.startsWith('Error: ')).toBe(true);
    await expect(fs.stat(path.join(root, 'p', 'missing.txt'))).rejects.toThrow();
  });

  it('errors on a path escape and writes nothing outside root', async () => {
    const changed = new Set<string>();
    const out = await replaceTool(root, changed, {
      path: '../outside/secret.txt',
      old_text: 'secret',
      new_text: 'pwned',
    });
    expect(out.startsWith('Error: ')).toBe(true);
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(changed.size).toBe(0);
  });
});

describe('runTests', () => {
  it('reports passed for exit code 0 and failed for non-zero', async () => {
    const ok = await runTests(root, 'node -e "process.exit(0)"', 20000);
    const bad = await runTests(root, 'node -e "process.exit(3)"', 20000);
    expect(ok.passed).toBe(true);
    expect(ok.timedOut).toBe(false);
    expect(bad.passed).toBe(false);
    expect(bad.timedOut).toBe(false);
  }, 30000);

  it('captures stdout and stderr in output', async () => {
    const r = await runTests(
      root,
      'node -e "console.log(\'out-marker\'); console.error(\'err-marker\')"',
      20000,
    );
    expect(r.output).toContain('out-marker');
    expect(r.output).toContain('err-marker');
  }, 30000);

  it('times out a long command with timedOut: true', async () => {
    const r = await runTests(root, 'node -e "setTimeout(()=>{}, 30000)"', 500);
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(true);
  }, 20000);

  it('returns passed: false without throwing for a command that does not exist', async () => {
    const r = await runTests(root, 'apimend-no-such-command-xyz', 20000);
    expect(r.passed).toBe(false);
    expect(r.timedOut).toBe(false);
  }, 30000);
});
