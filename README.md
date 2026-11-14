# apimend

> Working name. Early software: read [Status](#status) before relying on it.

When an API you depend on ships a breaking change, apimend tells you which
lines of your code are affected, and aims to open a pull request that fixes
them.

It reads two versions of the API's OpenAPI spec. It does not need the vendor's
changelog, and the first two steps use no AI at all.

## How it works

1. **Diff.** Compare the old and new spec and list what broke: removed
   endpoints, removed or retyped fields, newly required parameters, removed
   enum values. Deterministic: the same input always gives the same answer.
2. **Locate.** Search your repository for the lines that call those endpoints
   or use those fields, ranked by confidence. Also deterministic.
3. **Fix** (experimental). A model is handed only the changes that touch your
   repo and the candidate lines. It edits the code inside a sandbox, and
   apimend re-runs your tests itself instead of trusting the model's word.

When the spec does not say what replaces a removed thing, the model is told
not to guess. It leaves the code alone and lists the item under "Needs a
human".

## Try it

Steps 1 and 2 need no API key and no account.

```bash
npm install
npm run build
node dist/cli.js diff old-spec.json new-spec.json
node dist/cli.js impact old-spec.json new-spec.json --repo ../your-repo
```

`diff` and `impact` exit with code 1 when a breaking change is found, so they
can gate a CI job. Add `--json` for machine-readable output.

## Example: Stripe 2025-02-24 to 2025-03-31

Both specs are public in [stripe/openapi](https://github.com/stripe/openapi);
the exact commits are pinned in `benchmark/cases.json`. Abridged output of
`apimend diff`:

```
[breaking] endpoint-removed  GET /v1/invoices/upcoming/lines
[breaking] endpoint-removed  GET /v1/invoices/upcoming
[breaking] endpoint-removed  GET /v1/subscription_items/{subscription_item}/usage_record_summaries
[breaking] endpoint-removed  POST /v1/subscription_items/{subscription_item}/usage_records
[warning]  param-removed  GET /v1/credit_notes/preview/lines  query refund
...
[breaking] response-field-removed  subscription.current_period_end  (141 operations)
...

57 breaking, 66 warnings (123 groups from 3720 changes)
```

A field removed from a shared schema is reported once, with the number of
operations that return it, instead of once per operation.

## The fix step

```bash
node dist/cli.js fix old-spec.json new-spec.json --repo ../your-repo --dry-run
```

`--dry-run` prints exactly what the model would be sent and calls nothing.
Without it, the command needs `ANTHROPIC_API_KEY` in the environment and
spends real money. Options: `--test "<command>"` to have your test suite run
after the edits, `--model`, `--effort`.

What the model can and cannot do:

- It can read source files, search them, and replace text in existing files.
- It cannot touch anything outside the repository, or anything under `.git`.
- It cannot read credential files (`.env`, keys, `.npmrc` and similar).
- It cannot edit CI, hook or automation files such as `.github/`.
- It never gets a shell. The only command run is the test command you pass.

## Status

| Piece | State |
| --- | --- |
| Spec diff, grouped by schema | Works; tested on the Stripe specs above |
| Impact scan | Works; tested on one real repository |
| `diff` and `impact` commands | Work |
| Fix with a model | Built, **never yet run against a model** |
| Opening the pull request | Not built: the fix edits files and stops |
| GitHub Action | Not built |
| Benchmark on real historical breaks | 5 cases collected, none scored |

Measured so far: the Stripe diff above takes about 0.7 seconds on two 6.8 MB
specs. On a public repository that called an endpoint Stripe removed, the true
call site ranked first of 55 candidates. There is no fix-success number yet,
and none is claimed.

## Limits

- OpenAPI 3.x specs only. Swagger 2.0 is rejected.
- Source files scanned: TypeScript, JavaScript and Python.
- Code that calls an API through the vendor's SDK is found by field name, not
  by the call itself. That is weaker than URL matching and is the main open
  problem.
- The impact scan is a text search. It produces false positives by design;
  the fix step is expected to sift them.
- Fields nested behind more than one `oneOf`/`anyOf` reference are not
  followed, to keep very large specs fast.

## Development

```bash
npm run typecheck
npm test
```

Each stage has a written contract in `docs/`: `spec.md` (diff), `impact.md`,
`fix.md` and `cli.md`. Tests are written from those contracts.

## Licence

MIT. See [LICENSE](LICENSE).
