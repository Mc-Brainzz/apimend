# apimend — spec diff work package (v0)

apimend detects breaking changes between two versions of an upstream API's
OpenAPI spec, finds the code in a customer repo that is affected, and opens a
PR with the fix. This document specifies the first, fully deterministic stage:
**load two specs and list what broke**. No network, no LLM.

Types live in `src/types.ts` and are the source of truth for shapes.
Stack: Node 22, TypeScript (ESM, `"type": "module"`, imports end in `.js`),
vitest. Only runtime dependency allowed here: `yaml`.

## Files and exports

| File | Export |
| --- | --- |
| `src/spec/load.ts` | `loadSpec(filePath: string): Promise<OpenAPIDoc>` |
| `src/spec/resolve.ts` | `resolveRef(doc: OpenAPIDoc, node: unknown): unknown` |
| `src/diff/flatten.ts` | `flattenSchema(doc: OpenAPIDoc, schema: SchemaObject \| undefined): Map<string, FieldInfo>` |
| `src/diff/index.ts` | `diffSpecs(oldDoc: OpenAPIDoc, newDoc: OpenAPIDoc): BreakingChange[]` |
| `src/diff/group.ts` | `groupChanges(changes: BreakingChange[]): ChangeGroup[]` |

Keep every file under 500 lines. Split helpers into more files under
`src/diff/` if needed.

## loadSpec

- `.json` → `JSON.parse`. `.yaml` / `.yml` → `yaml` package. Any other
  extension: try JSON, fall back to YAML.
- Throws `UnsupportedSpecError` when the document has `swagger: "2.0"`, or has
  no `openapi` field starting with `"3."`, or is not an object.
- A missing file rejects with the underlying fs error (not wrapped).

## resolveRef

- If `node` is an object with a string `$ref` starting with `#/`, follow the
  JSON pointer inside `doc` (unescape `~1` → `/`, `~0` → `~`) and return the
  target. Follow chains of refs, up to 20 hops.
- External refs (not starting with `#/`), dangling pointers, and chains longer
  than 20 hops resolve to `{}`.
- Anything else is returned unchanged.

## Type strings

`typeOf(schema)` after resolving refs and merging `allOf`:

1. `type` is a string → that string.
2. `type` is an array (OpenAPI 3.1) → the entries other than `"null"`, sorted,
   joined with `|`. If only `"null"` remains → `"null"`.
3. No `type`: `"object"` if it has `properties`, else `"array"` if it has
   `items`, else `"union"` if it has `oneOf` or `anyOf`, else `"any"`.

`nullable` is true when `nullable: true` or the `type` array contains `"null"`.
`format` is ignored.

## flattenSchema

Turns a schema into a flat map of field path → `FieldInfo`. `undefined`
schema → empty map. The root schema itself gets no entry.

- **Refs** are resolved with `resolveRef` everywhere.
- **allOf**: merge all members into one schema before anything else —
  `properties` are unioned (later member wins on a clash), `required` arrays
  are unioned. Other keys: later member wins.
- **oneOf / anyOf**: the properties of every branch are unioned into the
  parent, all with `required: false`. Branch `required` arrays are ignored.
- **Object**: each property `p` gets an entry at `prefix + p`. If its type is
  `object` or `union`, recurse with prefix `prefix + p + "."` (a union only
  yields children when its branches contribute properties).
- **Union hop limit**: along any one path, at most **one** `oneOf`/`anyOf`
  branch that is a `$ref` is followed; further `$ref` branches below it are
  skipped (inline branches are always followed). Specs like Stripe's make
  most fields `anyOf[string, $ref]`, and following those at every level is
  exponential — minutes on a 7 MB spec instead of under a second. A component
  skipped here is still diffed wherever it is returned directly.
- **Array**: the property gets its own entry (type `array`), plus an entry at
  `prefix + p + "[]"` describing the items (`required: true`). If the items are
  objects, recurse with prefix `prefix + p + "[]."`.
- **Root array**: entries are `[]`, `[].id`, …
- **Cycles**: if a `$ref` is already on the current resolution stack, emit the
  entry for that field but do not recurse into it. Also stop recursing below
  10 levels of nesting.

Example:

```yaml
type: object
required: [id]
properties:
  id: { type: string }
  status: { type: string, enum: [open, paid] }
  lines:
    type: array
    items:
      type: object
      required: [amount]
      properties:
        amount: { type: integer }
        note: { type: string, nullable: true }
```

→

| path | type | required | nullable | enum |
| --- | --- | --- | --- | --- |
| `id` | string | true | false | |
| `status` | string | false | false | `[open, paid]` |
| `lines` | array | false | false | |
| `lines[]` | object | true | false | |
| `lines[].amount` | integer | true | false | |
| `lines[].note` | string | false | true | |

### Origin

Real specs declare a schema once and reference it from many operations, so
one upstream change shows up in dozens of responses. `FieldInfo.origin`
records where a field is actually declared, so those can be folded together.

While flattening, track the *current component*: the name (last JSON-pointer
segment, unescaped) of the innermost `$ref` that was followed to reach the
object schema in which a property is declared, plus the property's path from
that component's root. `origin` = `<component>.<path from component root>`.

- Following a `$ref` **anywhere** — the root schema, a property's value,
  array `items`, an `allOf` member, a `oneOf`/`anyOf` branch — makes that ref
  the current component for the properties declared inside it, and resets the
  path.
- Properties declared inline keep the enclosing component and extend the
  path.
- A `[]` entry's origin is the array property's origin + `[]`.
- An entry with no enclosing component has no `origin` key at all.

Example. Components:

```yaml
invoice:
  type: object
  properties:
    id: { type: string }
    customer: { $ref: '#/components/schemas/customer' }
    lines: { type: array, items: { $ref: '#/components/schemas/line' } }
    settings: { type: object, properties: { days: { type: integer } } }
customer: { type: object, properties: { email: { type: string } } }
line: { type: object, properties: { amount: { type: integer } } }
```

Flattening `{ $ref: '#/components/schemas/invoice' }`:

| path | origin |
| --- | --- |
| `id` | `invoice.id` |
| `customer` | `invoice.customer` |
| `customer.email` | `customer.email` |
| `lines` | `invoice.lines` |
| `lines[]` | `invoice.lines[]` |
| `lines[].amount` | `line.amount` |
| `settings` | `invoice.settings` |
| `settings.days` | `invoice.settings.days` |

Flattening the inline wrapper
`{ type: object, properties: { data: { type: array, items: { $ref: …/invoice } } } }`:
`data` and `data[]` have no origin; `data[].id` has `invoice.id`.

Branches and members: with
`customer: { anyOf: [{ type: string }, { $ref: …/customer }] }` declared in
`invoice`, entry `customer` has origin `invoice.customer` and `customer.email`
has `customer.email`. With component
`dog: { allOf: [{ $ref: …/animal }, { properties: { bark: … } }] }`, a field
`name` contributed by `animal` has origin `animal.name` and `bark` has
`dog.bark`.

## diffSpecs

### Matching operations

- Methods considered: get, put, post, delete, patch, head, options.
- Operation key = `METHOD` + space + normalised path. Normalising replaces
  every `{anything}` with `{}` and drops one trailing slash (not on `/`). So
  `/users/{id}` and `/users/{userId}/` are the same operation.
- An operation in old with no match in new → one `endpoint-removed` and
  nothing else for that operation.
- Operations only in new are ignored.
- Reported `path` is always the OLD spec's path as written; `method` is
  upper-case; `operationId` comes from the old operation.

### Parameters

- Effective parameters = path-item `parameters` + operation `parameters`,
  refs resolved; the operation's entry wins on the same `in` + `name`.
- Parameters with `in: path` are ignored completely.
- Header names are compared case-insensitively and reported lower-case.
- Parameter type = `typeOf(param.schema)`.

### Bodies

- Request body: pick one media type from the OLD operation's
  `requestBody.content` by preference: `application/json`,
  `application/x-www-form-urlencoded`, `multipart/form-data`, otherwise the
  first key. Compare against the same media type in new. If either side lacks
  it, skip request-field checks.
- Responses: only status codes starting with `2` that exist in **both**
  operations. Media type picked the same way from the old response; skip if
  new lacks it.
- Both sides are run through `flattenSchema` and compared by field path.

### Rules

| kind | severity | reported when | extra fields |
| --- | --- | --- | --- |
| `endpoint-removed` | breaking | operation missing in new | |
| `param-removed` | warning | param in old, absent in new | `in`, `name` |
| `param-required-added` | breaking | param is `required: true` in new, and was absent or not required in old | `in`, `name` |
| `param-type-changed` | breaking | param in both, types differ, neither is `any` | `in`, `name`, `before`, `after` |
| `request-field-removed` | warning | field in old, absent in new | `in: request`, `name` |
| `request-field-required-added` | breaking | field required in new, and absent or not required in old | `in: request`, `name` |
| `request-field-type-changed` | breaking | field in both, types differ, neither is `any` | `in`, `name`, `before`, `after` |
| `request-enum-value-removed` | breaking | field has `enum` on both sides and old has values new lacks | `in`, `name`, `values` (the removed ones) |
| `response-field-removed` | breaking | field in old, absent in new | `in: response`, `status`, `name` |
| `response-field-type-changed` | breaking | field in both, types differ, neither is `any` | `in`, `status`, `name`, `before`, `after` |
| `response-field-became-optional` | warning | old: required and not nullable; new: not required, or nullable | `in`, `status`, `name` |
| `response-enum-value-added` | warning | field has `enum` on both sides and new has values old lacks | `in`, `status`, `name`, `values` (the added ones) |

Suppression, to keep reports readable:

- **Removed subtree**: when a field is reported removed, its descendants
  (paths starting with `name + "."` or `name + "[]"`) are not reported.
- **Added subtree**: `request-field-required-added` is only reported for a
  field whose parent path exists in old (top-level fields always qualify). A
  newly added required object reports just itself, never its children; a
  newly added optional object reports nothing.
- **Type-changed subtree**: when a field's type changed, its descendants are
  not compared.

In all three type-changed rules, `union` is treated like `any`: a type that
is `union` on either side is never reported. `integer` →
`anyOf[integer, enum]` is a widening that keeps old callers working, and
telling that apart from a real change needs a comparison of the branches,
which v0 does not do.

### Root cause (`schema`)

Every request-field and response-field change carries `schema`: the `origin`
of the field on the side where it exists — the OLD side for every field kind
except `request-field-required-added`, which uses the NEW side. The key is
omitted when that field has no origin. Parameter kinds and `endpoint-removed`
never have it. `schema` is not part of `id`.

### groupChanges

`src/diff/group.ts` exports
`groupChanges(changes: BreakingChange[]): ChangeGroup[]`.

- A change with `schema` gets the key
  `[kind, schema, before ?? '', after ?? '', (values ?? []).join(',')].join('|')`.
  Changes with the same key form one group.
- A change without `schema` is a group of its own; its key is its `id`.
- Groups are returned in order of first appearance; `changes` inside a group
  keep input order. `kind`, `severity` and `schema` come from the first
  change. `schema` is omitted on groups whose changes have none.
- `groupChanges([])` → `[]`. Pure function; does not mutate its input.

### Output

- `id` = `[kind, method, path, in ?? '', status ?? '', name ?? ''].join('|')`.
- No two entries share an `id`.
- Sorted ascending by `id` using plain `<` string comparison.
- `message` is a non-empty human sentence; its wording is not contractual.
- `diffSpecs(doc, doc)` returns `[]`. The function never throws on odd input
  (missing `paths`, non-object operations, parameters without schema) — it
  skips what it cannot read.

### Worked example

Old:

```yaml
openapi: 3.0.3
paths:
  /v1/invoices/{id}:
    get:
      operationId: getInvoice
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
        - { name: expand, in: query, schema: { type: string } }
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                required: [id, total]
                properties:
                  id: { type: string }
                  total: { type: integer }
                  customer_email: { type: string }
```

New: same, except `expand` is gone, `total` is `type: string`, and
`customer_email` is removed. Result (in order):

```json
[
  { "id": "param-removed|GET|/v1/invoices/{id}|query||expand", "kind": "param-removed", "severity": "warning", "in": "query", "name": "expand" },
  { "id": "response-field-removed|GET|/v1/invoices/{id}|response|200|customer_email", "kind": "response-field-removed", "severity": "breaking", "in": "response", "status": "200", "name": "customer_email" },
  { "id": "response-field-type-changed|GET|/v1/invoices/{id}|response|200|total", "kind": "response-field-type-changed", "severity": "breaking", "in": "response", "status": "200", "name": "total", "before": "integer", "after": "string" }
]
```

(each entry also carries `method: "GET"`, `path`, `operationId: "getInvoice"`
and a `message`).
