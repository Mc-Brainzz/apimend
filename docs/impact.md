# apimend — impact analysis work package (v0)

Second stage: given the `BreakingChange[]` from `diffSpecs` and a checkout of a
customer repo, list the lines of code that probably need to change. Fully
deterministic — no network, no LLM. Recall matters more than precision: a
later LLM stage reads these sites and decides. Types are in `src/types.ts`.

Stack rules are the same as `docs/spec.md` (ESM, `.js` import suffixes,
strict TS, node built-ins only, files under 500 lines).

## Files and exports

| File | Export | Owner |
| --- | --- | --- |
| `src/impact/path-match.ts` | `normalizeLine(line: string): string`, `matchPaths(line: string, templates: string[]): PathHit[]` | lead (already being written — do not create or edit) |
| `src/impact/names.ts` | `nameVariants(name: string): string[]`, `isCommonName(leaf: string): boolean`, `matchName(line: string, variants: string[]): boolean` | work package |
| `src/impact/files.ts` | `listSourceFiles(repoDir: string): Promise<string[]>`, `hostsFromSpec(doc: OpenAPIDoc): string[]` | work package |
| `src/impact/scan.ts` | `isCorroborated(text: string, options: ImpactOptions): boolean`, `scanFile(file: string, text: string, changes: BreakingChange[], ctx: ScanContext): ImpactSite[]` | work package |
| `src/impact/index.ts` | `findImpact(repoDir: string, changes: BreakingChange[], options?: ImpactOptions): Promise<ImpactSite[]>` | work package |

`ScanContext = { options: ImpactOptions; repoHasCorroboration: boolean }`,
exported from `scan.ts`.

## path-match (lead-owned; contract for callers and tests)

`normalizeLine` rewrites interpolations that sit in path position to `{}`:

| in the code | becomes |
| --- | --- |
| `${expr}` (JS template; one level of nested braces allowed) | `{}` |
| `{expr}` directly before or after a `/` (Python f-string / `.format`) | `{}` |
| `%s`, `%d`, `%(name)s` directly after a `/` | `{}` |
| `:name` directly after a `/` (Express style) | `{}` |
| `<name>` directly after a `/` | `{}` |
| `"…/" + expr + "/…"` (any quote style; closing and reopening a string around one expression) | `…/{}/…` |

`matchPaths` then extracts every URL-ish path on the normalised line and
returns at most one `PathHit` per path: the best-matching template.

A path matches a template when a **suffix** of the template lines up with the
**end** of the path:

- Template and path are split on `/`. A template segment containing `{` is a
  *param*; otherwise it is *static*.
- The aligned template suffix must start on a static segment. The path may
  have extra leading segments (host, base path); the template may have leading
  segments missing from the path (base URL kept elsewhere in the code).
- Static template segment ↔ identical literal in the path. Param segment ↔
  `{}` or any literal that is not a source file name (`index.js`, `views.py`).
- A path ending in `/` is read both ways: as having one more `{}` segment
  (`"/v1/invoices/" + id`), and as-is (APIs that use trailing slashes). When
  both readings match different templates equally well, the `{}` reading wins
  only if a value is visibly appended after the closing quote (`+ x`, `, x`).
- Literal segments the code has to the **left** of the aligned part must
  agree with the template's segments there (a literal may sit in a param
  slot; the check stops at the first `{}`, which could be any base URL). So
  `/v2/users/42` does not match `/v1/users/{id}`, and the repo's own route
  `/api/auth/verify` does not match `/v1/customers/{customer}/sources/{id}/verify`.
- A path that starts in the middle of a word (`region/account`, `a/b`) is
  prose or arithmetic and is ignored.
- Both must end together: `/invoices/{}/lines` does not match
  `/v1/invoices/{id}`, and `/v1/invoices` does not match `/v1/invoices/{id}`.
- *Version-like* static segments (`v1`, `v2beta`, `2023-10-16`, `api`, `rest`)
  must still match when aligned, but are not counted in `matchedStatic` or
  `droppedStatic`. A match needs `matchedStatic >= 1`.
- Best template: highest `matchedStatic`; then fewest literals sitting in
  param slots; then lowest `droppedStatic`; then earliest in `templates`.

Examples, template `/v1/invoices/{id}`:

| line | hit? |
| --- | --- |
| `` fetch(`${BASE}/v1/invoices/${id}`) `` | yes, matchedStatic 1, droppedStatic 0 |
| `requests.get(f"{base}/invoices/{invoice_id}")` | yes, matchedStatic 1 |
| `axios.get("https://api.example.com/v1/invoices/" + id)` | yes |
| `client.get("/v1/invoices/in_123")` | yes (literal in the param slot) |
| `` fetch(`/v1/invoices/${id}/lines`) `` | no |
| `fetch("/v1/invoices")` | no |
| `import x from "../invoices/index.js"` | no |

With templates `["/v1/invoices/{id}", "/v1/invoices/upcoming"]`, the line
`get("/v1/invoices/upcoming")` returns one hit, for `/v1/invoices/upcoming`.

## names

- `nameVariants(name)`: take the leaf of a field path (`data[].customer_email`
  → `customer_email`; a parameter name is its own leaf), and return the
  de-duplicated list `[as written, camelCase, snake_case]`, in that order.
  For `operationId`s the caller adds PascalCase itself.
- `isCommonName(leaf)`: true when the leaf is shorter than 5 characters or is
  in a built-in stoplist that includes at least: id, ids, name, type, data,
  status, value, values, items, object, url, code, error, message, created,
  updated, result, results, count, key, text, title, description.
- `matchName(line, variants)`: true when any variant occurs as a whole
  identifier — not preceded or followed by `[A-Za-z0-9_$]`. Occurrences inside
  quotes count (`row["customer_email"]`).

## files

- `listSourceFiles`: if `repoDir/.git` exists, use
  `git ls-files -z --cached --others --exclude-standard`; otherwise walk the
  directory. Keep extensions `.ts .tsx .js .jsx .mjs .cjs .py`. Drop anything
  under a directory named `node_modules`, `dist`, `build`, `out`, `vendor`,
  `.venv`, `venv`, `__pycache__`, `.next`, `coverage`; drop `*.min.js`,
  `*.d.ts`, and files over 512 KB. Return repo-relative paths with forward
  slashes, sorted ascending.
- `hostsFromSpec`: hostnames of `servers[].url`, lower-cased, de-duplicated,
  in order. Skip URLs that are relative, contain `{`, or point at `localhost`
  / `127.0.0.1`.

## scan

`isCorroborated(text, options)`: true when the file text contains any of
`options.hosts` (case-insensitive substring) or imports any of
`options.sdkPackages` (`import … from 'pkg'`, `from 'pkg/sub'`,
`require('pkg')`, Python `import pkg` / `from pkg import …` /
`from pkg.sub import …`). False when both lists are empty or absent.

`scanFile` produces sites for one file. `file` is the repo-relative path used
in the output; `text` is its content. Line numbers are 1-indexed; `snippet` is
the trimmed line cut to 200 characters.

Corroboration state of the file, used in the scores below:

- **neutral** — `ctx.repoHasCorroboration` is false (nobody told us the hosts
  or SDKs, or no file in the repo mentions them);
- **yes** — `isCorroborated(text, options)`;
- **no** — otherwise.

Three signals, per line:

1. **path** — `matchPaths(line, options.allPaths ?? <paths of the changes>)`.
   A hit applies to every change whose `path` equals `hit.template`, except:
   if the line itself contains HTTP method words
   (`get|post|put|patch|delete|head|options`, whole word, any case) and none
   of them is the change's method, that change is skipped.
   Score: 0.50 / 0.65 / 0.80 for `matchedStatic` 1 / 2 / 3+; −0.10 if
   `droppedStatic > 0`; +0.15 when corroboration is *yes*, −0.20 when *no*;
   +0.05 if the change's method word appears on the line or within 2 lines
   either side.
2. **operationId** — only for changes with an `operationId` of 6+ characters.
   `matchName(line, [...nameVariants(operationId), PascalCase])`.
   Score: 0.60 when corroboration is *yes*, otherwise 0.35.
3. **field** — only for changes that have a `name` (params and fields).
   `matchFieldAccess(line, nameVariants(name))` (in `names.ts`): the name
   must be *used as a field* — `obj.name`, `obj?.name`, `obj["name"]`,
   `obj.get("name")`, a key or keyword argument (`name: x`, `name=x`,
   `"name": x`), or destructuring (`{ a, name }`). A bare mention in a
   comment or as a string value does not count; on a real repo those
   outnumbered true uses by more than ten to one. Score: 0.70 if this file has a path
   hit (signal 1) for the same change anywhere in it; else 0.40 if
   corroboration is *yes*; else, if `!isCommonName(leaf)`: 0.35 when the
   repo has corroboration somewhere and the name is distinctive (multi-word
   or 10+ characters — `isDistinctiveName`), 0.20 otherwise; a common name
   gives no site. The 0.35 exists because a removed field is usually consumed
   in a file that never mentions the API.

Scores are clamped to [0.05, 0.95] and rounded to 2 decimals. The numbers are
a v0 guess that will be tuned against the benchmark — **tests should assert
ordering and presence, not exact values**, except the clamp bounds.

Merging inside `scanFile`: one `ImpactSite` per line. `signal` is the
strongest present (path > operationId > field), `confidence` is the maximum,
`changeIds` is the sorted union.

## findImpact

1. `listSourceFiles`, read each file as UTF-8 (skip unreadable files).
2. `repoHasCorroboration` = any file satisfies `isCorroborated`.
3. `scanFile` each file, concatenate.
4. Per change id keep only the `maxSitesPerChange` (default 40) highest
   confidence sites; remove that id from the rest; drop sites left with no
   ids.
5. Sort by confidence descending, then file ascending, then line ascending.

Empty `changes` → `[]` without touching the file system.
