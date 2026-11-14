import type { BreakingChange, ChangeIn, ChangeKind, HttpMethod, Severity } from '../types.js';

export interface OpCtx {
  method: HttpMethod;
  /** Path as written in the OLD spec. */
  path: string;
  operationId?: string;
}

export interface ChangeExtra {
  in?: ChangeIn;
  status?: string;
  name?: string;
  before?: string;
  after?: string;
  values?: string[];
  schema?: string;
}

export function makeChange(
  ctx: OpCtx,
  kind: ChangeKind,
  severity: Severity,
  message: string,
  extra: ChangeExtra = {},
): BreakingChange {
  const id = [kind, ctx.method, ctx.path, extra.in ?? '', extra.status ?? '', extra.name ?? ''].join('|');
  return {
    id,
    kind,
    severity,
    method: ctx.method,
    path: ctx.path,
    ...(ctx.operationId !== undefined ? { operationId: ctx.operationId } : {}),
    ...extra,
    message: `${ctx.method} ${ctx.path}: ${message}`,
  };
}
