import { describe, expect, it } from 'vitest';
import { parseCli, UsageError } from '../../src/cli/args.js';

describe('parseCli', () => {
  it('returns help for no args and for -h', () => {
    expect(parseCli([])).toEqual({ command: 'help' });
    expect(parseCli(['-h'])).toEqual({ command: 'help' });
  });

  it('returns help when --help appears anywhere in argv', () => {
    expect(parseCli(['--help'])).toEqual({ command: 'help' });
    expect(parseCli(['diff', 'a.json', '--help'])).toEqual({ command: 'help' });
  });

  it('parses diff with defaults', () => {
    expect(parseCli(['diff', 'old.json', 'new.json'])).toEqual({
      command: 'diff',
      oldSpec: 'old.json',
      newSpec: 'new.json',
      json: false,
    });
  });

  it('parses diff --json', () => {
    expect(parseCli(['diff', 'old.json', 'new.json', '--json'])).toEqual({
      command: 'diff',
      oldSpec: 'old.json',
      newSpec: 'new.json',
      json: true,
    });
  });

  it('parses impact with defaults', () => {
    expect(parseCli(['impact', 'old.json', 'new.json'])).toEqual({
      command: 'impact',
      oldSpec: 'old.json',
      newSpec: 'new.json',
      repo: '.',
      hosts: [],
      sdkPackages: [],
      minConfidence: 0.3,
      json: false,
    });
  });

  it('parses impact with repeated flags placed before and after positionals', () => {
    const cmd = parseCli([
      'impact', 'old.json', 'new.json',
      '--repo', '../svc',
      '--host', 'api.a.com',
      '--host', 'api.b.com',
      '--sdk', 'pkg-a',
      '--sdk', 'pkg-b',
      '--min-confidence', '0.5',
      '--json',
    ]);
    expect(cmd).toMatchObject({
      command: 'impact',
      oldSpec: 'old.json',
      newSpec: 'new.json',
      hosts: ['api.a.com', 'api.b.com'],
      sdkPackages: ['pkg-a', 'pkg-b'],
      repo: '../svc',
      minConfidence: 0.5,
      json: true,
    });
    const before = parseCli(['impact', '--repo', 'r', '--host', 'h1', '--host', 'h2', 'o.json', 'n.json']);
    expect(before).toMatchObject({ oldSpec: 'o.json', newSpec: 'n.json', repo: 'r', hosts: ['h1', 'h2'] });
  });

  it('parses fix with --test, --model, --effort and --dry-run', () => {
    expect(
      parseCli(['fix', 'o.json', 'n.json', '--test', 'npm test', '--model', 'm-1', '--effort', 'high', '--dry-run']),
    ).toMatchObject({
      command: 'fix',
      oldSpec: 'o.json',
      newSpec: 'n.json',
      repo: '.',
      hosts: [],
      sdkPackages: [],
      minConfidence: 0.3,
      testCommand: 'npm test',
      model: 'm-1',
      effort: 'high',
      dryRun: true,
    });
    expect(parseCli(['fix', 'o.json', 'n.json'])).toMatchObject({ dryRun: false });
  });

  it('throws UsageError for an unknown command and an unknown flag', () => {
    expect(() => parseCli(['frobnicate', 'a', 'b'])).toThrow(UsageError);
    expect(() => parseCli(['diff', 'a', 'b', '--bogus'])).toThrow(UsageError);
  });

  it('throws UsageError for a flag not valid for the command', () => {
    expect(() => parseCli(['fix', 'a', 'b', '--json'])).toThrow(UsageError);
    expect(() => parseCli(['diff', 'a', 'b', '--test', 'x'])).toThrow(UsageError);
    expect(() => parseCli(['impact', 'a', 'b', '--dry-run'])).toThrow(UsageError);
  });

  it('throws UsageError for the wrong number of positionals', () => {
    expect(() => parseCli(['diff'])).toThrow(UsageError);
    expect(() => parseCli(['diff', 'a'])).toThrow(UsageError);
    expect(() => parseCli(['impact', 'a', 'b', 'c'])).toThrow(UsageError);
  });

  it('throws UsageError for a value flag with no value', () => {
    expect(() => parseCli(['impact', 'a', 'b', '--repo'])).toThrow(UsageError);
    expect(() => parseCli(['fix', 'a', 'b', '--test'])).toThrow(UsageError);
  });

  it('throws UsageError for --min-confidence out of range or not a number, and for a bad --effort', () => {
    expect(() => parseCli(['impact', 'a', 'b', '--min-confidence', '1.5'])).toThrow(UsageError);
    expect(() => parseCli(['impact', 'a', 'b', '--min-confidence', 'abc'])).toThrow(UsageError);
    expect(() => parseCli(['fix', 'a', 'b', '--effort', 'extreme'])).toThrow(UsageError);
    expect(new UsageError('x')).toBeInstanceOf(Error);
  });
});
