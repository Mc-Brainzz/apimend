# apimend — command line work package (v0)

Thin glue over the three stages. Stack rules as in `docs/spec.md`. Use
`node:util` `parseArgs` or hand-rolled parsing; no argument-parsing dependency.

## Commands

```
apimend diff   <old-spec> <new-spec> [--json]
apimend impact <old-spec> <new-spec> [--repo <dir>] [--host <h>]... [--sdk <pkg>]... [--min-confidence <n>] [--json]
apimend fix    <old-spec> <new-spec> [--repo <dir>] [--host <h>]... [--sdk <pkg>]... [--min-confidence <n>]
                                     [--test <command>] [--model <id>] [--effort <level>] [--dry-run]
apimend --help
```

## Files and exports

| File | Export |
| --- | --- |
| `src/cli/args.ts` | `parseCli(argv: string[]): CliCommand`, `UsageError`, `USAGE` (the help text) |
| `src/cli/format.ts` | `formatChanges(changes: BreakingChange[]): string`, `formatSites(sites: ImpactSite[]): string` |
| `src/cli/main.ts` | `main(argv: string[]): Promise<number>` (returns the exit code; never calls `process.exit`) |
| `src/cli.ts` | bin entry: `#!/usr/bin/env node`, runs `main(process.argv.slice(2))` and sets `process.exitCode` |

### parseCli

`argv` excludes the node binary and script path. Returns:

```ts
type CliCommand =
  | { command: 'help' }
  | { command: 'diff'; oldSpec: string; newSpec: string; json: boolean }
  | { command: 'impact'; oldSpec: string; newSpec: string; repo: string; hosts: string[];
      sdkPackages: string[]; minConfidence: number; json: boolean }
  | { command: 'fix'; oldSpec: string; newSpec: string; repo: string; hosts: string[];
      sdkPackages: string[]; minConfidence: number; testCommand?: string; model?: string;
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; dryRun: boolean };
```

- No arguments, `-h` or `--help` anywhere → `{ command: 'help' }`.
- Defaults: `repo` `"."`, `hosts` `[]`, `sdkPackages` `[]`, `minConfidence`
  `0.3`, `json` `false`, `dryRun` `false`. `--host` and `--sdk` repeat.
- Flags may appear before or after the positionals.
- Throws `UsageError` (extends `Error`) for: unknown command, unknown flag, a
  flag not valid for that command (`--json` on `fix`, `--test` on `diff`, …),
  wrong number of positionals, a value flag with no value, `--min-confidence`
  not a number in 0..1, `--effort` not one of the five levels.

### format

`formatChanges`: one line per group from `groupChanges(changes)` (see
`docs/spec.md`), in group order, then a blank line and a summary line.

```
[breaking] response-field-removed  subscription.current_period_end  (17 operations)
[breaking] response-field-type-changed  GET /v1/invoices/{id}  response 200 total (integer → string)
[warning]  param-removed  GET /v1/invoices/{id}  query expand
[breaking] endpoint-removed  DELETE /v1/invoices/{id}

3 breaking, 1 warning (4 groups from 20 changes)
```

- Group with `schema`: the schema string, then the type or enum suffix, then
  `(K operations)` counting the distinct `METHOD path` values in the group
  (`(1 operation)` when K is 1).
- Group without `schema`: `METHOD path`, then the location part
  `<in> <status?> <name>` with absent pieces left out (nothing at all for
  `endpoint-removed`), then the suffix.
- Suffixes: type changes append ` (before → after)`, enum kinds append
  ` (a, b)`.
- The summary counts **groups** by severity and pluralises:
  `1 breaking, 0 warnings`. When there are fewer groups than changes, append
  ` (G groups from C changes)`.
- Empty input → `No breaking changes.`

`formatSites`: one block per file in the order given.

```
src/billing/client.ts
  L42  0.85  path         const res = await fetch(url)
  L57  0.70  field        return invoice.customer_email
```

Columns: `L<line>`, confidence with two decimals, signal padded to 11
characters, snippet. Empty input → `No affected code found.`

### main

- `help` → print `USAGE`, return 0. `UsageError` → print the message and
  `USAGE` to stderr, return 2. Any other error → print `error: <message>` to
  stderr, return 2.
- `diff`: `loadSpec` both, `diffSpecs`, print `formatChanges` (or the JSON
  array with `--json`). Return 1 if any change has severity `breaking`, else 0.
- `impact`: as `diff`, then `findImpact(repo, changes, { hosts, sdkPackages,
  allPaths })` where `hosts` is `--host` values plus `hostsFromSpec(oldDoc)`
  and `allPaths` is `Object.keys(oldDoc.paths ?? {})`. Drop sites below
  `minConfidence`. Print changes then sites (or JSON
  `{ changes, sites }`). Same exit code as `diff`.
- `fix`: same analysis. With no breaking or warning changes, print
  `No breaking changes.` and return 0. With `--dry-run`, print
  `buildBrief(changes, sites)` and return 0 without creating a client.
  Otherwise `import Anthropic from '@anthropic-ai/sdk'`, `new Anthropic()`
  (it reads credentials from the environment — do not handle keys yourself),
  call `runFix` from `src/fix/run.ts`, print the summary, the changed files,
  token usage, and the test verdict. Return 1 if tests ran and failed, or if
  `stopReason` is not `end_turn`; else 0.
