import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { SandboxError } from '../types.js';
import type { TestRun } from '../types.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_READ_LINES = 400;
const MAX_MATCHES = 60;
const MAX_PATTERN = 300;
const MAX_LINE_TESTED = 2000;
const OUTPUT_TAIL = 6000;

const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';
const fold = (s: string): string => (FOLD_CASE ? s.toLowerCase() : s);

/** Windows device names, which open devices instead of files (checked on every OS). */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/;

function checkSegment(seg: string): void {
  for (let i = 0; i < seg.length; i++) {
    const c = seg.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) throw new SandboxError('path contains a control character');
  }
  // ':' blocks drive letters and NTFS alternate data streams; the rest are invalid on Windows.
  if (/[<>:"|?*]/.test(seg)) throw new SandboxError('path contains a forbidden character');
  // Windows ignores trailing dots and spaces, so ".git." and ".git " are ".git".
  const bare = seg.replace(/[. ]+$/, '');
  if (bare === '') throw new SandboxError('path contains an invalid segment');
  const lower = bare.toLowerCase();
  if (lower === '.git' || /^git~\d+$/.test(lower)) {
    throw new SandboxError('access to .git is not allowed');
  }
  if (RESERVED.test(lower.split('.')[0] ?? '')) {
    throw new SandboxError('reserved device name in path');
  }
}

function contained(folded: string): boolean {
  return folded !== '..' && !folded.startsWith('..' + path.sep) && !path.isAbsolute(folded);
}

export async function resolveInside(root: string, relPath: string): Promise<string> {
  if (typeof root !== 'string' || root === '') throw new SandboxError('invalid root');
  if (typeof relPath !== 'string' || relPath === '') throw new SandboxError('path is empty');
  if (relPath.includes('\0')) throw new SandboxError('path contains a NUL byte');
  if (/^[\\/]/.test(relPath)) throw new SandboxError('absolute paths are not allowed');
  if (/^[a-zA-Z]:/.test(relPath)) throw new SandboxError('drive-qualified paths are not allowed');

  const stack: string[] = [];
  for (const seg of relPath.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) throw new SandboxError('path escapes the repository root');
      stack.pop();
      continue;
    }
    checkSegment(seg);
    stack.push(seg);
  }
  if (stack.length === 0) throw new SandboxError('path does not name anything inside the root');

  const absRoot = path.resolve(root);
  const target = path.join(absRoot, ...stack);
  if (!contained(fold(path.relative(absRoot, target)))) {
    throw new SandboxError('path escapes the repository root');
  }

  const realRoot = await fs.realpath(absRoot).catch(() => {
    throw new SandboxError('repository root does not exist');
  });

  // Real path of the deepest existing ancestor (the target itself may not exist).
  let cur = target;
  let real: string | undefined;
  while (real === undefined) {
    if (cur === absRoot) { real = realRoot; break; }
    try {
      real = await fs.realpath(cur);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new SandboxError('cannot inspect path');
      try {
        await fs.lstat(cur);
        // Exists but cannot be resolved: a dangling or looping symlink. Reject.
        throw new SandboxError('path goes through a broken symlink');
      } catch (e2) {
        if (e2 instanceof SandboxError) throw e2;
        const code2 = (e2 as NodeJS.ErrnoException).code;
        if (code2 !== 'ENOENT' && code2 !== 'ENOTDIR') throw new SandboxError('cannot inspect path');
      }
      const parent = path.dirname(cur);
      if (parent === cur) throw new SandboxError('path escapes the repository root');
      cur = parent;
    }
  }

  const rel = path.relative(fold(realRoot), fold(real));
  if (!contained(rel)) throw new SandboxError('path escapes the repository root (symlink)');
  for (const seg of rel.split(path.sep)) {
    if (seg.replace(/[. ]+$/, '') === '.git') throw new SandboxError('access to .git is not allowed');
  }
  return target;
}

/** Credential files. Their contents must never reach the model: its report becomes a PR description. */
const SECRET_FILE =
  /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
/** Things that execute on a developer machine or in CI. A model edit there is privilege escalation. */
const AUTOMATION_DIRS = new Set(['.github', '.circleci', '.gitlab', '.husky']);
const AUTOMATION_FILE =
  /^(?:\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|jenkinsfile|\.gitmodules|\.gitattributes)$/i;

/** Repo-relative segments of `abs`, both as addressed and with symlinks resolved. */
async function policyViews(root: string, abs: string): Promise<string[][]> {
  const absRoot = path.resolve(root);
  const views = [path.relative(absRoot, abs).split(path.sep)];
  try {
    views.push(path.relative(await fs.realpath(absRoot), await fs.realpath(abs)).split(path.sep));
  } catch {
    // Target does not exist yet; the lexical view is all there is.
  }
  return views;
}

async function assertReadable(root: string, abs: string): Promise<void> {
  for (const segs of await policyViews(root, abs)) {
    if (SECRET_FILE.test(segs[segs.length - 1] ?? '')) {
      throw new SandboxError('credential files cannot be read or edited');
    }
  }
}

async function assertWritable(root: string, abs: string): Promise<void> {
  await assertReadable(root, abs);
  for (const segs of await policyViews(root, abs)) {
    const inAutomationDir = segs.some((s) => AUTOMATION_DIRS.has(s.toLowerCase()));
    if (inAutomationDir || AUTOMATION_FILE.test(segs[segs.length - 1] ?? '')) {
      throw new SandboxError('CI, hook and automation files cannot be edited');
    }
  }
}

function errText(e: unknown): string {
  if (e instanceof SandboxError) return `Error: ${e.message}`;
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return `Error: ${typeof code === 'string' ? code : 'operation failed'}`;
}

async function readText(abs: string, label: string): Promise<string> {
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new SandboxError(`${label} is not a regular file`);
  if (st.size > MAX_FILE_BYTES) throw new SandboxError(`${label} is larger than 1 MB`);
  const buf = await fs.readFile(abs);
  if (buf.length > MAX_FILE_BYTES) throw new SandboxError(`${label} is larger than 1 MB`);
  if (buf.includes(0)) throw new SandboxError(`${label} looks binary (contains a NUL byte)`);
  return buf.toString('utf8');
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isPosInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1;
}

export async function readFileTool(
  root: string,
  input: { path: string; start_line?: number; end_line?: number },
): Promise<string> {
  try {
    const abs = await resolveInside(root, input.path);
    await assertReadable(root, abs);
    const start = input.start_line ?? 1;
    if (!isPosInt(start)) return 'Error: start_line must be a positive integer';
    if (input.end_line !== undefined && !isPosInt(input.end_line)) {
      return 'Error: end_line must be a positive integer';
    }
    const lines = splitLines(await readText(abs, input.path));
    if (lines.length === 0) return '';
    if (start > lines.length) return `Error: start_line ${start} is beyond the end of the file (${lines.length} lines)`;
    const end = Math.min(input.end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1, lines.length);
    if (end < start) return 'Error: end_line is before start_line';
    const out: string[] = [];
    for (let i = start; i <= end; i++) out.push(`${i}\t${lines[i - 1] ?? ''}`);
    if (end < lines.length) out.push(`(file has ${lines.length} lines; showing ${start}-${end})`);
    return out.join('\n');
  } catch (e) {
    return errText(e);
  }
}

export async function searchTool(
  root: string,
  files: string[],
  input: { pattern: string; path_prefix?: string },
): Promise<string> {
  try {
    if (typeof input.pattern !== 'string' || input.pattern === '') return 'Error: pattern is empty';
    if (input.pattern.length > MAX_PATTERN) return `Error: pattern is longer than ${MAX_PATTERN} characters`;
    let re: RegExp;
    try {
      re = new RegExp(input.pattern);
    } catch {
      return 'Error: invalid regular expression';
    }
    const prefix = typeof input.path_prefix === 'string' ? input.path_prefix.replace(/\\/g, '/') : '';
    const out: string[] = [];
    let more = false;
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      let lines: string[];
      try {
        lines = splitLines(await readText(await resolveInside(root, file), file));
      } catch {
        continue; // unreadable, binary, too large, or outside the sandbox: not searchable
      }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!re.test(line.length > MAX_LINE_TESTED ? line.slice(0, MAX_LINE_TESTED) : line)) continue;
        if (out.length >= MAX_MATCHES) { more = true; break; }
        out.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
      }
      if (more) break;
    }
    if (out.length === 0) return 'No matches.';
    if (more) out.push('(more matches not shown; narrow the pattern)');
    return out.join('\n');
  } catch (e) {
    return errText(e);
  }
}

function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return n;
    n++;
    from = i + 1; // overlapping matches count, which is stricter
  }
}

export async function replaceTool(
  root: string,
  changed: Set<string>,
  input: { path: string; old_text: string; new_text: string },
): Promise<string> {
  try {
    if (typeof input.old_text !== 'string' || typeof input.new_text !== 'string') {
      return 'Error: old_text and new_text must be strings';
    }
    if (input.old_text === '') return 'Error: old_text is empty';
    if (input.old_text === input.new_text) return 'Error: old_text and new_text are identical';
    const abs = await resolveInside(root, input.path);
    await assertWritable(root, abs);
    const content = await readText(abs, input.path);
    const crlf = content.includes('\r\n');
    const conv = (s: string): string => (crlf ? s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : s);
    const oldText = conv(input.old_text);
    const newText = conv(input.new_text);
    const count = countOccurrences(content, oldText);
    if (count !== 1) return `Error: old_text occurs ${count} times in ${input.path}; it must occur exactly once`;
    const idx = content.indexOf(oldText);
    await fs.writeFile(abs, content.slice(0, idx) + newText + content.slice(idx + oldText.length), 'utf8');
    // Record the canonical repo-relative path (true case, symlinks resolved).
    const rel = path.relative(await fs.realpath(path.resolve(root)), await fs.realpath(abs));
    changed.add(rel.split(path.sep).join('/'));
    return `Replaced 1 occurrence in ${input.path}.`;
  } catch (e) {
    return errText(e);
  }
}

export function runTests(root: string, command: string, timeoutMs: number): Promise<TestRun> {
  return new Promise<TestRun>((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const isWin = process.platform === 'win32';

    const settle = (passed: boolean, extra?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      if (extra) output += extra;
      resolve({ passed: passed && !timedOut, output: output.slice(-OUTPUT_TAIL), timedOut });
    };
    const onData = (chunk: string): void => {
      output += chunk;
      if (output.length > OUTPUT_TAIL * 4) output = output.slice(-OUTPUT_TAIL * 2);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { cwd: root, shell: true, windowsHide: true, detached: !isWin, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      settle(false, e instanceof Error ? e.message : 'failed to start command');
      return;
    }
    child.stdout?.setEncoding('utf8').on('data', onData);
    child.stderr?.setEncoding('utf8').on('data', onData);
    child.on('error', (e: Error) => settle(false, e.message));
    child.on('close', (code: number | null) => settle(code === 0));
    // If grandchildren keep the pipes open after the shell exits, do not wait for 'close' forever.
    child.on('exit', (code: number | null) => {
      grace = setTimeout(() => settle(code === 0), 2000);
    });

    const ms = Number.isFinite(timeoutMs) ? Math.min(Math.max(timeoutMs, 1), 2 ** 31 - 1) : 600000;
    timer = setTimeout(() => {
      timedOut = true;
      const pid = child.pid;
      if (pid !== undefined) {
        if (isWin) {
          execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
        } else {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try { child.kill('SIGKILL'); } catch { /* gone */ }
          }
        }
      }
      // Guarantee settlement even if 'close' never fires.
      grace = setTimeout(() => settle(false), 3000);
    }, ms);
  });
}
