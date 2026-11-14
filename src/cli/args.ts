import { parseArgs } from 'node:util';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type CliCommand =
  | { command: 'help' }
  | { command: 'diff'; oldSpec: string; newSpec: string; json: boolean }
  | {
      command: 'impact';
      oldSpec: string;
      newSpec: string;
      repo: string;
      hosts: string[];
      sdkPackages: string[];
      minConfidence: number;
      json: boolean;
    }
  | {
      command: 'fix';
      oldSpec: string;
      newSpec: string;
      repo: string;
      hosts: string[];
      sdkPackages: string[];
      minConfidence: number;
      testCommand?: string;
      model?: string;
      effort?: Effort;
      dryRun: boolean;
    };

export const USAGE = `Usage:
  apimend diff   <old-spec> <new-spec> [--json]
  apimend impact <old-spec> <new-spec> [--repo <dir>] [--host <h>]... [--sdk <pkg>]...
                 [--min-confidence <n>] [--json]
  apimend fix    <old-spec> <new-spec> [--repo <dir>] [--host <h>]... [--sdk <pkg>]...
                 [--min-confidence <n>] [--test <command>] [--model <id>]
                 [--effort <level>] [--dry-run]
  apimend --help

Options:
  --repo <dir>          repository to scan (default ".")
  --host <h>            upstream API hostname; repeatable
  --sdk <pkg>           SDK package name; repeatable
  --min-confidence <n>  drop sites below n, 0..1 (default 0.3)
  --json                machine-readable output
  --test <command>      test command to run after the fix
  --model <id>          model to use for the fix
  --effort <level>      low, medium, high, xhigh or max
  --dry-run             print the brief without calling the model

Exit codes: 0 ok, 1 breaking changes found (or fix failed), 2 usage or runtime error.
`;

const EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const ALLOWED: Record<string, readonly string[]> = {
  diff: ['json'],
  impact: ['repo', 'host', 'sdk', 'min-confidence', 'json'],
  fix: ['repo', 'host', 'sdk', 'min-confidence', 'test', 'model', 'effort', 'dry-run'],
};

function isEffort(s: string): s is Effort {
  return EFFORTS.includes(s);
}

export function parseCli(argv: string[]): CliCommand {
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    return { command: 'help' };
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        repo: { type: 'string' },
        host: { type: 'string', multiple: true },
        sdk: { type: 'string', multiple: true },
        'min-confidence': { type: 'string' },
        test: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
      },
    });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const [command, ...positionals] = parsed.positionals;
  if (command === undefined) throw new UsageError('missing command');
  const allowed = ALLOWED[command];
  if (allowed === undefined) throw new UsageError(`unknown command: ${command}`);

  for (const flag of Object.keys(parsed.values)) {
    if (!allowed.includes(flag)) {
      throw new UsageError(`--${flag} is not valid for "${command}"`);
    }
  }
  if (positionals.length !== 2) {
    throw new UsageError(`"${command}" takes exactly 2 arguments: <old-spec> <new-spec>`);
  }
  const [oldSpec, newSpec] = positionals as [string, string];
  const v = parsed.values;
  const json = v.json === true;

  if (command === 'diff') return { command: 'diff', oldSpec, newSpec, json };

  let minConfidence = 0.3;
  if (v['min-confidence'] !== undefined) {
    const raw = v['min-confidence'];
    const n = raw.trim() === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw new UsageError(`--min-confidence must be a number between 0 and 1, got "${raw}"`);
    }
    minConfidence = n;
  }
  const common = {
    oldSpec,
    newSpec,
    repo: v.repo ?? '.',
    hosts: v.host ?? [],
    sdkPackages: v.sdk ?? [],
    minConfidence,
  };

  if (command === 'impact') return { command: 'impact', ...common, json };

  let effort: Effort | undefined;
  if (v.effort !== undefined) {
    if (!isEffort(v.effort)) {
      throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}, got "${v.effort}"`);
    }
    effort = v.effort;
  }
  return {
    command: 'fix',
    ...common,
    ...(v.test !== undefined ? { testCommand: v.test } : {}),
    ...(v.model !== undefined ? { model: v.model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    dryRun: v['dry-run'] === true,
  };
}
