import { describe, expect, it } from 'vitest';
import { buildBrief } from '../../src/fix/brief.js';
import type { BreakingChange, ImpactSite } from '../../src/types.js';

// A large API ships over a hundred changes per version; a given repo touches a
// handful. The model should only be handed the ones with a candidate site.

const removed = (path: string): BreakingChange => ({
  id: `endpoint-removed|GET|${path}|||`,
  kind: 'endpoint-removed',
  severity: 'breaking',
  method: 'GET',
  path,
  message: 'm',
});

const site = (changeIds: string[]): ImpactSite => ({
  file: 'src/a.ts',
  line: 3,
  snippet: 'fetch(url)',
  signal: 'path',
  changeIds,
  confidence: 0.8,
});

describe('buildBrief onlyGroupsWithSites', () => {
  const a = removed('/v1/a');
  const b = removed('/v1/b');
  const c = removed('/v1/c');

  it('lists only groups that have a site, renumbered, and says how many were left out', () => {
    const brief = buildBrief([a, b, c], [site([b.id])], { onlyGroupsWithSites: true });
    expect(brief).toContain('1. [breaking] endpoint-removed — GET /v1/b: endpoint removed');
    expect(brief).not.toContain('/v1/a');
    expect(brief).not.toContain('/v1/c');
    expect(brief).toContain('(2 other changes have no candidate site in this repository and are not listed.)');
    expect(brief).toContain('changes 1:');
  });

  it('adds no note when every group has a site', () => {
    const brief = buildBrief([a], [site([a.id])], { onlyGroupsWithSites: true });
    expect(brief).not.toContain('not listed');
  });

  it('lists every group by default', () => {
    const brief = buildBrief([a, b, c], [site([b.id])]);
    expect(brief).toContain('/v1/a');
    expect(brief).toContain('/v1/c');
    expect(brief).toContain('changes 2:');
  });
});
