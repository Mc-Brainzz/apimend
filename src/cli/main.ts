import Anthropic from '@anthropic-ai/sdk';
import { diffSpecs } from '../diff/index.js';
import { runFix } from '../fix/run.js';
import { buildBrief } from '../fix/brief.js';
import { hostsFromSpec } from '../impact/files.js';
import { findImpact } from '../impact/index.js';
import { loadSpec } from '../spec/load.js';
import type { BreakingChange, ImpactSite } from '../types.js';
import { parseCli, USAGE, UsageError } from './args.js';
import type { CliCommand } from './args.js';
import { formatChanges, formatSites } from './format.js';

type Impactful = Extract<CliCommand, { command: 'impact' | 'fix' }>;

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function err(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

async function analyse(cmd: Impactful): Promise<{ changes: BreakingChange[]; sites: ImpactSite[] }> {
  const oldDoc = await loadSpec(cmd.oldSpec);
  const newDoc = await loadSpec(cmd.newSpec);
  const changes = diffSpecs(oldDoc, newDoc);
  const hosts = [...new Set([...cmd.hosts, ...hostsFromSpec(oldDoc)])];
  const all = await findImpact(cmd.repo, changes, {
    hosts,
    sdkPackages: cmd.sdkPackages,
    allPaths: Object.keys(oldDoc.paths ?? {}),
  });
  const sites = all.filter((s) => s.confidence >= cmd.minConfidence);
  return { changes, sites };
}

function exitFor(changes: BreakingChange[]): number {
  return changes.some((c) => c.severity === 'breaking') ? 1 : 0;
}

async function run(cmd: CliCommand): Promise<number> {
  switch (cmd.command) {
    case 'help':
      out(USAGE);
      return 0;
    case 'diff': {
      const changes = diffSpecs(await loadSpec(cmd.oldSpec), await loadSpec(cmd.newSpec));
      out(cmd.json ? JSON.stringify(changes, null, 2) : formatChanges(changes));
      return exitFor(changes);
    }
    case 'impact': {
      const { changes, sites } = await analyse(cmd);
      if (cmd.json) out(JSON.stringify({ changes, sites }, null, 2));
      else out(`${formatChanges(changes)}\n\n${formatSites(sites)}`);
      return exitFor(changes);
    }
    case 'fix':
      return runFixCommand(cmd);
  }
}

async function runFixCommand(cmd: Extract<CliCommand, { command: 'fix' }>): Promise<number> {
  const { changes, sites } = await analyse(cmd);
  if (changes.length === 0) {
    out('No breaking changes.');
    return 0;
  }
  if (sites.length === 0) {
    // Nothing in this repo looks affected: do not spend a model call on it.
    out('No affected code found.');
    return 0;
  }
  if (cmd.dryRun) {
    out(buildBrief(changes, sites, { onlyGroupsWithSites: true }));
    return 0;
  }
  const client = new Anthropic();
  const result = await runFix({
    client,
    repoDir: cmd.repo,
    changes,
    sites,
    ...(cmd.testCommand !== undefined ? { testCommand: cmd.testCommand } : {}),
    ...(cmd.model !== undefined ? { model: cmd.model } : {}),
    ...(cmd.effort !== undefined ? { effort: cmd.effort } : {}),
  });

  out(result.summary);
  out('');
  if (result.changedFiles.length === 0) out('No files changed.');
  else {
    out('Changed files:');
    for (const f of result.changedFiles) out(`  ${f}`);
  }
  const u = result.usage;
  out('');
  out(`Tokens: ${u.inputTokens} in, ${u.outputTokens} out, ${u.cacheReadTokens} cache read`);
  if (result.tests === null) out('Tests: not run (no --test command)');
  else if (result.tests.passed) out('Tests: passed');
  else {
    out(result.tests.timedOut ? 'Tests: timed out' : 'Tests: FAILED');
    out(result.tests.output);
  }
  if (result.stopReason !== 'end_turn') {
    err(`warning: model stopped with reason "${result.stopReason ?? 'unknown'}"`);
  }
  const testsFailed = result.tests !== null && !result.tests.passed;
  return testsFailed || result.stopReason !== 'end_turn' ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  try {
    return await run(parseCli(argv));
  } catch (e) {
    if (e instanceof UsageError) {
      err(e.message);
      err(USAGE);
      return 2;
    }
    err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
