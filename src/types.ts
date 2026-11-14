/**
 * Shared contract for the apimend engine.
 * Pipeline: loadSpec -> diffSpecs -> findImpact -> fix loop -> verify -> PR.
 * The behaviour of each function is specified in docs/spec.md.
 */

/** A parsed OpenAPI 3.x document. Deliberately loose: specs in the wild are messy. */
export type OpenAPIDoc = {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
};

/** A JSON-schema-ish object as found inside an OpenAPI document. */
export type SchemaObject = Record<string, unknown>;

export type HttpMethod =
  | 'GET'
  | 'PUT'
  | 'POST'
  | 'DELETE'
  | 'PATCH'
  | 'HEAD'
  | 'OPTIONS';

export type ChangeKind =
  | 'endpoint-removed'
  | 'param-removed'
  | 'param-required-added'
  | 'param-type-changed'
  | 'request-field-removed'
  | 'request-field-required-added'
  | 'request-field-type-changed'
  | 'request-enum-value-removed'
  | 'response-field-removed'
  | 'response-field-type-changed'
  | 'response-field-became-optional'
  | 'response-enum-value-added';

export type Severity = 'breaking' | 'warning';

/** Where in the operation the change sits. Absent for endpoint-removed. */
export type ChangeIn = 'query' | 'header' | 'cookie' | 'request' | 'response';

export interface BreakingChange {
  /** [kind, method, path, in ?? '', status ?? '', name ?? ''].join('|') */
  id: string;
  kind: ChangeKind;
  severity: Severity;
  method: HttpMethod;
  /** Path template exactly as written in the OLD spec, e.g. "/v1/customers/{id}". */
  path: string;
  /** operationId from the OLD spec, when present. */
  operationId?: string;
  in?: ChangeIn;
  /** Response status code as a string ("200"). Only for in === 'response'. */
  status?: string;
  /** Parameter name, or field path such as "customer.address.line1" / "data[].id". */
  name?: string;
  /** Old type (type-changed kinds). */
  before?: string;
  /** New type (type-changed kinds). */
  after?: string;
  /** Enum values removed or added (enum kinds), sorted ascending. */
  values?: string[];
  /**
   * Root cause for field kinds: `<component>.<path inside it>`, e.g.
   * "subscription.current_period_end". Absent for inline schemas. Not part of `id`.
   */
  schema?: string;
  /** Human-readable one-liner. Never empty. Wording is not part of the contract. */
  message: string;
}

/** One entry produced by flattenSchema. */
export interface FieldInfo {
  /** See "Type strings" in docs/spec.md. */
  type: string;
  /** Listed in the `required` array of its immediate parent object. */
  required: boolean;
  nullable: boolean;
  /** Enum values stringified with String(), sorted ascending. Absent when no enum. */
  enum?: string[];
  /** `<component>.<path from that component's root>`. See "Origin" in docs/spec.md. */
  origin?: string;
}

/** Changes that share one root cause, e.g. a field removed from a shared schema. */
export interface ChangeGroup {
  key: string;
  kind: ChangeKind;
  severity: Severity;
  schema?: string;
  /** Every change folded into the group, in input order. Never empty. */
  changes: BreakingChange[];
}

export class UnsupportedSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedSpecError';
  }
}

/* ---- Impact analysis (owned by the lead; not part of the diff work package) ---- */

export type ImpactSignal = 'path' | 'operationId' | 'field';

export interface ImpactSite {
  /** Repo-relative, forward slashes. */
  file: string;
  /** 1-indexed. */
  line: number;
  snippet: string;
  signal: ImpactSignal;
  /** ids of the BreakingChange entries this site may be affected by. */
  changeIds: string[];
  /** 0..1 */
  confidence: number;
}

export interface ImpactOptions {
  /** Hostnames of the upstream API, e.g. ["api.stripe.com"]. */
  hosts?: string[];
  /** Package names of SDKs for this API, e.g. ["stripe"]. */
  sdkPackages?: string[];
  /** Every path template in the OLD spec; lets a more specific path win. */
  allPaths?: string[];
  /** Max sites kept per change id. Default 40. */
  maxSitesPerChange?: number;
}

/* ---- Fix stage ---- */

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

export interface TestRun {
  passed: boolean;
  /** Combined stdout + stderr, last 6000 characters. */
  output: string;
  timedOut: boolean;
}

export interface FixResult {
  /** Repo-relative paths the model edited, sorted. */
  changedFiles: string[];
  /** Result of OUR test run after the model finished; null when no test command. */
  tests: TestRun | null;
  /** The model's final report. */
  summary: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

/** One URL-ish path found on a line of code, matched to its best template. */
export interface PathHit {
  template: string;
  /** The path as found, after interpolations were normalised to "{}". */
  text: string;
  /** Distinctive static template segments that matched literally. */
  matchedStatic: number;
  /** Distinctive static template segments left of the alignment (not in the code). */
  droppedStatic: number;
}
