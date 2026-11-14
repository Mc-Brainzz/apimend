/**
 * Finds URL-ish paths on a line of code and matches them against OpenAPI path
 * templates. Contract: docs/impact.md, "path-match".
 *
 * Deliberately not one big regex: interpolations are first rewritten to "{}",
 * then paths are compared segment by segment, aligned at their ends. That is
 * what lets "/invoices/{}/lines" and "/invoices/{}" be told apart.
 */
import type { PathHit } from '../types.js';

const HOLE = '{}';

const VERSION_LIKE = /^(?:v\d+(?:[a-z]+\d*)?|\d{4}-\d{2}(?:-\d{2})?|api|rest)$/i;
const SOURCE_FILE =
  /\.(?:[cm]?[jt]sx?|py|json|css|scss|html?|md|ya?ml|vue|svelte|png|jpe?g|svg|gif|map|lock|txt)$/i;
/** An optional leading hole (base URL variable), then one or more /segments. */
const CANDIDATE = /(?:\{\})?(?:\/(?:\{\}|[A-Za-z0-9_.~@%-])+)+\/?/g;
/** After a path's closing quote: "+ expr" or ", expr" means a value is appended. */
const VALUE_APPENDED = /^["'`]\s*[+,]/;

export function normalizeLine(line: string): string {
  return (
    line
      // `${expr}` — one level of nested braces
      .replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, HOLE)
      // "…/" + expr + "/…" — a string closed and reopened around one expression
      .replace(
        /(?<=\/)["'`]\s*\+\s*[^"'`+]+?\s*\+\s*["'`]|["'`]\s*\+\s*[^"'`+]+?\s*\+\s*["'`](?=\/)/g,
        HOLE,
      )
      // {expr} touching a slash (f-string, str.format)
      .replace(/(?<=\/)\{[^{}"'`/;]{0,80}\}|\{[^{}"'`/;]{0,80}\}(?=\/)/g, HOLE)
      // %s, %d, %(name)s
      .replace(/(?<=\/)%(?:\([^)]*\))?[sd]/g, HOLE)
      // :name (Express style)
      .replace(/(?<=\/):[A-Za-z_]\w*/g, HOLE)
      // <name>
      .replace(/(?<=\/)<[^<>/\s]+>/g, HOLE)
  );
}

interface TemplateSeg {
  text: string;
  param: boolean;
  /** Static and not version-like: the segments that count as evidence. */
  counted: boolean;
}

interface CompiledTemplate {
  template: string;
  segs: TemplateSeg[];
}

interface TemplateIndex {
  compiled: CompiledTemplate[];
  /** Static segment text -> indices of the templates containing it. */
  bySegment: Map<string, number[]>;
}

interface CodeSeg {
  text: string;
  hole: boolean;
}

interface Score {
  matchedStatic: number;
  droppedStatic: number;
  literalsInParams: number;
}

const indexCache = new WeakMap<readonly string[], TemplateIndex>();

function buildIndex(templates: readonly string[]): TemplateIndex {
  const compiled: CompiledTemplate[] = [];
  const bySegment = new Map<string, number[]>();
  templates.forEach((template, i) => {
    const segs = template
      .split('/')
      .filter((s) => s.length > 0)
      .map((text): TemplateSeg => {
        const param = text.includes('{');
        return { text, param, counted: !param && !VERSION_LIKE.test(text) };
      });
    compiled.push({ template, segs });
    for (const seg of segs) {
      if (seg.param) continue;
      const list = bySegment.get(seg.text);
      if (list) {
        if (list[list.length - 1] !== i) list.push(i);
      } else {
        bySegment.set(seg.text, [i]);
      }
    }
  });
  return { compiled, bySegment };
}

function getIndex(templates: string[]): TemplateIndex {
  let index = indexCache.get(templates);
  if (!index) {
    index = buildIndex(templates);
    indexCache.set(templates, index);
  }
  return index;
}

function toCodeSegs(pathText: string): CodeSeg[] {
  return pathText
    .split('/')
    .filter((s) => s.length > 0)
    .map((text) => ({ text, hole: text.includes(HOLE) }));
}

function canFillParam(literal: string): boolean {
  return literal !== '.' && literal !== '..' && !SOURCE_FILE.test(literal);
}

function countEvidence(segs: TemplateSeg[], from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (segs[i]?.counted) n++;
  return n;
}

/**
 * Line a suffix of the template up with the end of the code path. The longest
 * suffix that fits wins; it must start on a static segment.
 */
function align(tpl: TemplateSeg[], code: CodeSeg[]): Score | null {
  for (let k = 0; k < tpl.length; k++) {
    const first = tpl[k];
    if (!first || first.param) continue;
    const len = tpl.length - k;
    if (len > code.length) continue;
    const offset = code.length - len;

    let literalsInParams = 0;
    let fits = true;
    for (let i = 0; i < len; i++) {
      const t = tpl[k + i];
      const c = code[offset + i];
      if (!t || !c) {
        fits = false;
        break;
      }
      if (t.param) {
        if (c.hole) continue;
        if (!canFillParam(c.text)) {
          fits = false;
          break;
        }
        literalsInParams++;
      } else if (c.hole || c.text !== t.text) {
        fits = false;
        break;
      }
    }
    if (!fits) continue;

    // Whatever literal segments the code has to the left of the aligned part
    // must agree with the template's: "/api/auth/verify" is not
    // ".../sources/{id}/verify", and "/v2/users/42" is not "/v1/users/{id}".
    // An interpolated segment (a base URL variable) could be anything, so the
    // check stops there.
    for (let i = 1; k - i >= 0 && offset - i >= 0; i++) {
      const t = tpl[k - i];
      const c = code[offset - i];
      if (!t || !c || c.hole) break;
      if (!t.param && c.text !== t.text) return null;
    }

    const matchedStatic = countEvidence(tpl, k, tpl.length);
    if (matchedStatic < 1) return null;
    return { matchedStatic, droppedStatic: countEvidence(tpl, 0, k), literalsInParams };
  }
  return null;
}

/** Negative when `a` is the better match. */
function compareScores(a: Score, b: Score): number {
  return (
    b.matchedStatic - a.matchedStatic ||
    a.literalsInParams - b.literalsInParams ||
    a.droppedStatic - b.droppedStatic
  );
}

export function matchPaths(line: string, templates: string[]): PathHit[] {
  if (templates.length === 0 || !line.includes('/')) return [];
  const index = getIndex(templates);
  const normalized = normalizeLine(line);
  const hits: PathHit[] = [];

  for (const m of normalized.matchAll(CANDIDATE)) {
    // "region/account" in a comment, "a/b" in arithmetic: a path that starts
    // in the middle of a word is not a URL.
    const before = normalized[(m.index ?? 0) - 1];
    if (before !== undefined && /[A-Za-z0-9_]/.test(before)) continue;
    const text = m[0].replace(/\.+$/, '');
    const plain = toCodeSegs(text);
    if (plain.length === 0) continue;

    // A trailing slash is read two ways: a value is appended after it
    // ("/invoices/" + id), or the API simply uses trailing slashes.
    const readings: CodeSeg[][] = [plain];
    if (text.endsWith('/')) {
      const withHole = [...plain, { text: HOLE, hole: true }];
      const rest = normalized.slice((m.index ?? 0) + m[0].length);
      if (VALUE_APPENDED.test(rest)) readings.unshift(withHole);
      else readings.push(withHole);
    }

    const candidates = new Set<number>();
    for (const seg of plain) {
      if (seg.hole) continue;
      for (const i of index.bySegment.get(seg.text) ?? []) candidates.add(i);
    }

    let best: { template: string; score: Score; reading: number; order: number } | null = null;
    for (const i of [...candidates].sort((a, b) => a - b)) {
      const tpl = index.compiled[i];
      if (!tpl) continue;
      readings.forEach((reading, r) => {
        const score = align(tpl.segs, reading);
        if (!score) return;
        const better =
          best === null ||
          compareScores(score, best.score) < 0 ||
          (compareScores(score, best.score) === 0 &&
            (r < best.reading || (r === best.reading && i < best.order)));
        if (better) best = { template: tpl.template, score, reading: r, order: i };
      });
    }

    if (best !== null) {
      const { template, score } = best as { template: string; score: Score };
      hits.push({
        template,
        text,
        matchedStatic: score.matchedStatic,
        droppedStatic: score.droppedStatic,
      });
    }
  }
  return hits;
}
