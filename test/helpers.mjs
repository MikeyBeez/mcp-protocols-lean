// Test harness for mcp-protocols-lean.
//
// The server reads its library from PROTOCOLS_DIR, so tests point it at a
// temp directory of fixture protocols rather than the real 36-file library.
// That keeps assertions stable as the real library grows, and means a test can
// never depend on the contents of a protocol Mikey edits.
// HARNESS_LEDGER is redirected too, so test calls never write spans into the
// real ledger.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');

const PROTOCOL = (id, { tier, title, purpose, triggers }) => `# ${title}

**Tier**: ${tier}
**Priority**: normal

## Purpose

${purpose}

## Trigger Conditions

${triggers}

## Steps

1. Do the first thing.
2. Do the second thing.
`;

export function makeLibrary() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'protocols-lean-test-')));
  const dir = path.join(base, 'protocols');
  fs.mkdirSync(dir);

  const write = (id, spec) => fs.writeFileSync(path.join(dir, `${id}.md`), PROTOCOL(id, spec));

  write('prompt-processing', {
    tier: '0 (Meta - runs before all others)', title: 'Prompt Processing Protocol',
    purpose: 'Pre-process every user prompt to extract protocol triggers.',
    triggers: 'Any new user message received.',
  });
  write('continuous-documentation', {
    tier: '0 (Meta — always active)', title: 'Continuous Documentation Protocol',
    purpose: 'Make documentation a reflex.',
    triggers: 'Every non-trivial action.',
  });
  write('debugging', {
    tier: '2 (Foundation)', title: 'Debugging Protocol',
    purpose: 'Reproduce, isolate, diagnose and fix a defect.',
    triggers: 'A stack trace, an exception, or behaviour that diverges from expectation.',
  });
  write('medium-article', {
    tier: '3 (Specialized)', title: 'Medium Article Writing Protocol',
    purpose: 'Produce Medium-ready drafts in plain text.',
    triggers: 'Writing an article or a blog post for publication.',
  });
  write('gardening', {
    tier: '3 (Specialized)', title: 'Gardening Protocol',
    purpose: 'Completely unrelated, so it should never match a coding prompt.',
    triggers: 'Tomatoes, soil, compost.',
  });

  fs.writeFileSync(path.join(dir, 'triggers.json'), JSON.stringify({
    protocols: {
      debugging: { keywords: ['stack trace', 'exception', 'traceback', 'debug'] },
      'medium-article': { keywords: ['medium', 'article', 'blog post'] },
      gardening: { keywords: ['tomato', 'compost'] },
    },
  }, null, 2));

  fs.writeFileSync(path.join(dir, 'tool-map.json'), JSON.stringify([
    { situation: 'debugging a failing test', keywords: ['debug', 'failing', 'test'], tools: ['smalledit', 'filesystem-enhanced'], note: 'read the file before editing it' },
    { situation: 'writing for publication', keywords: ['article', 'medium', 'draft'], tools: ['tracked-search'], note: 'check the facts first' },
  ], null, 2));

  return { base, dir };
}

export async function startServer(dir, base, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(REPO, 'index.js')],
    cwd: REPO,
    env: {
      ...process.env,
      PROTOCOLS_DIR: dir,
      HARNESS_LEDGER: path.join(base, 'ledger.db'),
      HARNESS_TRACE_PTR: path.join(base, 'current_trace.txt'),
      ...extraEnv,
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'protocols-lean-tests', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw new Error(`tool ${name} errored: ${r.content?.[0]?.text}`);
    return JSON.parse(r.content[0].text);
  };
  const expectError = async (name, args = {}) => {
    try {
      const r = await client.callTool({ name, arguments: args });
      return r.isError ? (r.content?.[0]?.text ?? '') : null;
    } catch (e) { return e.message; }
  };
  return { client, call, expectError };
}

export function cleanup(base) {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
}
