# apimend — fix stage work package (v0)

Third stage: an LLM edits the customer repo so it works with the new API
version. The model call itself (`src/fix/run.ts`) is owned by the lead. This
work package is everything around it that is **deterministic**: the file
sandbox the model's tools run in, and the text brief the model is given.
No network and no LLM in this package. Types are in `src/types.ts`.

Stack rules as in `docs/spec.md` (ESM, `.js` import suffixes, strict TS, node
built-ins only, files under 300 lines).

## Why the sandbox matters

Every `path`, `pattern` and text below is **model output and untrusted**. The
tool runs inside a customer's CI with write access to their checkout. Nothing
the model sends may read or write outside the repo root, touch `.git`, or
reach a shell.

## Files and exports

| File | Export |
| --- | --- |
| `src/fix/sandbox.ts` | `resolveInside`, `readFileTool`, `searchTool`, `replaceTool`, `runTests` |
| `src/fix/brief.ts` | `buildBrief` |

### resolveInside(root: string, relPath: string): Promise<string>

Returns the absolute path for `relPath` inside `root`, or throws
`SandboxError`. Rejects: empty string; absolute paths (POSIX `/x`, Windows
`C:\x`, UNC `\\x`); any path whose normalised form leaves `root` (`..`);
anything inside a `.git` directory at any depth; and symlink escapes — the
real path (`fs.realpath`) of the deepest existing ancestor must still be
inside the real path of `root`. Both `/` and `\` separators are accepted.

### Policy on top of the sandbox

The model's report becomes a public PR description and its edits run in the
customer's CI, so two further rules apply (checked on the path as addressed
and on its real path):

- **Credential files are never read or edited**: `.env`, `.env.*`, `.npmrc`,
  `.pypirc`, `.netrc`, SSH private keys, `*.pem`, `*.key`, `*.p12`, `*.pfx`.
- **Automation is read-only**: anything under `.github`, `.circleci`,
  `.gitlab` or `.husky`, plus CI pipeline files, `.gitmodules` and
  `.gitattributes`, can be read but not edited.

### Tool functions

All three return a string for the model and **never throw**: failures,
including `SandboxError`, come back as a string starting with `Error: `.

`readFileTool(root, input: { path: string; start_line?: number; end_line?: number }): Promise<string>`

- Lines are returned as `<1-indexed number>\t<text>`, joined with `\n`.
- Default range is the first 400 lines; a single call never returns more than
  400 lines. When lines exist beyond what was returned, append a final line
  `(file has N lines; showing A-B)`.
- Files over 1 MB or containing a NUL byte → `Error: ` string.

`searchTool(root, files: string[], input: { pattern: string; path_prefix?: string }): Promise<string>`

- `files` is the repo-relative list from `listSourceFiles`; only those are
  searched, optionally narrowed to paths starting with `path_prefix`.
- `pattern` is a JavaScript regular expression, case-sensitive. An invalid
  pattern → `Error: ` string. Patterns longer than 300 characters → error.
- Output: one `file:line: <trimmed line, max 200 chars>` per matching line,
  at most 60, in `files` order then line order. More than 60 → append
  `(more matches not shown; narrow the pattern)`. None → `No matches.`

`replaceTool(root, changed: Set<string>, input: { path: string; old_text: string; new_text: string }): Promise<string>`

- `old_text` must occur **exactly once** in the file. Zero or several →
  `Error: ` string stating how many times it occurs; the file is untouched.
- Empty `old_text`, or `old_text === new_text` → error.
- Line endings: if the file uses CRLF, `old_text` and `new_text` are
  converted to CRLF before matching and writing, so a model sending `\n`
  still matches and the file stays CRLF.
- On success: writes the file, adds the repo-relative forward-slash path to
  `changed`, returns `Replaced 1 occurrence in <path>.`
- The file must already exist (this tool never creates files).

### runTests(root: string, command: string, timeoutMs: number): Promise<TestRun>

`command` comes from the customer's own configuration, never from the model.
Run it with `child_process.spawn(command, { cwd: root, shell: true })`,
capture stdout and stderr interleaved, keep the last 6000 characters.
`passed` is `exit code === 0`. On timeout: kill the process tree, return
`passed: false, timedOut: true`. A command that cannot be started returns
`passed: false` with the error text as output — never throws.

### buildBrief(changes: BreakingChange[], sites: ImpactSite[], options?: { maxSites?: number }): string

Deterministic Markdown the model reads. Same input → byte-identical output
(this text sits in a cached prompt prefix, so no timestamps or random ids).

```
## Breaking changes

1. [breaking] response-field-removed — schema `subscription`, field `current_period_end`; in 3 operations: GET /v1/subscriptions, GET /v1/subscriptions/{id}, POST /v1/subscriptions
2. [breaking] response-field-type-changed — GET /v1/invoices/{id} (operationId: getInvoice): response 200 field `total` (integer → string)
3. [warning] param-removed — GET /v1/invoices/{id} (operationId: getInvoice): query parameter `expand`
4. [breaking] endpoint-removed — DELETE /v1/invoices/{id}: endpoint removed

## Candidate sites

These come from a text search and include false positives. Verify each one.

### src/billing/client.ts
- line 42 (path, 0.85) changes 2, 3: `const res = await fetch(url)`
```

- One numbered line per group from `groupChanges(changes)` (see
  `docs/spec.md`), numbered 1..n in group order. There are no per-operation
  headings: a group can span many operations.
- **Group with `schema`** (`<component>.<path>`, split at the first `.`):
  `` schema `<component>`, field `<path>` ``, then the type or enum suffix,
  then `; in K operations: ` followed by the distinct `METHOD path` values of
  the group's changes in order, comma-separated. At most 5 are listed; with
  more, append ` (+N more)`. Use `operation` (singular) when K is 1.
- **Group without `schema`** (always a single change): `METHOD path`, then
  ` (operationId: …)` when present, then `: ` and the per-change text — for
  parameters `<in> parameter `name``; for fields `request field `name`` /
  `response <status> field `name``; `endpoint-removed` is `endpoint removed`.
- Suffixes, for both forms: type changes append ` (<before> → <after>)`;
  enum kinds append ` (values: a, b)`.
- Sites are grouped by file, files in first-appearance order, sites in the
  order given. `changes` lists the numbers of the groups that contain any of
  the site's `changeIds`, ascending and without repeats; ids not present in
  `changes` are ignored.
- Snippets are wrapped in single backticks; any backtick inside a snippet is
  replaced with `'`.
- At most `maxSites` (default 60) sites are listed; if more were given, end
  the section with `(N more sites omitted)`.
- No sites → the section body is `No candidate sites were found by search.`
- `options.onlyGroupsWithSites` (default false; the fix stage and
  `--dry-run` pass true): groups none of whose changes appear in any site's
  `changeIds` are left out, the rest are numbered consecutively, and the list
  ends with a blank line and
  `(N other changes have no candidate site in this repository and are not listed.)`
  when N > 0. A large API ships over a hundred changes per version and a
  given repo touches a handful.
