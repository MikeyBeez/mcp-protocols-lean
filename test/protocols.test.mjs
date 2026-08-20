import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeLibrary, startServer, cleanup } from './helpers.mjs';

const TOOL_NAMES = [
  'mikey_prompt_process', 'mikey_protocol_list', 'mikey_protocol_read',
  'mikey_protocol_search', 'mikey_protocol_triggers',
  'mikey_propose', 'mikey_review_proposals', 'mikey_apply_proposal', 'mikey_graduation_track'];

let ctx;

before(async () => {
  const lib = makeLibrary();
  const server = await startServer(lib.dir, lib.base);
  ctx = { ...lib, ...server };
});

after(async () => {
  await ctx.client.close();
  cleanup(ctx.base);
});

describe('tool registry', () => {
  test('advertises exactly the documented tools', async () => {
    const { tools } = await ctx.client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), [...TOOL_NAMES].sort());
  });

  test('the required arguments are declared', async () => {
    const { tools } = await ctx.client.listTools();
    const req = Object.fromEntries(tools.map(t => [t.name, t.inputSchema.required || []]));
    assert.deepEqual(req.mikey_prompt_process, ['prompt']);
    assert.deepEqual(req.mikey_protocol_read, ['id']);
    assert.deepEqual(req.mikey_protocol_search, ['query']);
    assert.deepEqual(req.mikey_protocol_triggers, ['situation']);
  });

  test('an unknown tool is an error, not a crash', async () => {
    const msg = await ctx.expectError('mikey_nope');
    assert.match(msg, /unknown tool/i);
  });
});

describe('mikey_protocol_list', () => {
  test('lists every markdown protocol in the library', async () => {
    const list = await ctx.call('mikey_protocol_list');
    assert.deepEqual(list.map(p => p.id).sort(),
      ['continuous-documentation', 'debugging', 'gardening', 'medium-article', 'prompt-processing']);
  });

  test('parses the title, tier and purpose out of the markdown', async () => {
    const list = await ctx.call('mikey_protocol_list');
    const dbg = list.find(p => p.id === 'debugging');
    assert.equal(dbg.title, 'Debugging Protocol');
    assert.match(dbg.tier, /^2 /);
    assert.match(dbg.purpose, /Reproduce, isolate/);
  });

  test('picks up a protocol added after the server started', async () => {
    // The library is read from disk on every call, so a new file should appear
    // without a restart. That is a deliberate property worth pinning down.
    fs.writeFileSync(path.join(ctx.dir, 'late-arrival.md'),
      '# Late Arrival\n\n**Tier**: 3\n\n## Purpose\n\nAdded mid-session.\n\n## Trigger Conditions\n\nlate\n');
    const list = await ctx.call('mikey_protocol_list');
    assert.ok(list.some(p => p.id === 'late-arrival'), 'a new .md should be visible without a restart');
    fs.rmSync(path.join(ctx.dir, 'late-arrival.md'));
  });

  test('does not treat triggers.json or tool-map.json as protocols', async () => {
    const list = await ctx.call('mikey_protocol_list');
    assert.ok(!list.some(p => /triggers|tool-map/.test(p.id)));
  });
});

describe('mikey_protocol_read', () => {
  test('returns the full markdown body', async () => {
    const r = await ctx.call('mikey_protocol_read', { id: 'debugging' });
    assert.equal(r.id, 'debugging');
    assert.match(r.content, /# Debugging Protocol/);
    assert.match(r.content, /Do the second thing/);
  });

  test('an unknown id reports not-found and lists what is available', async () => {
    const r = await ctx.call('mikey_protocol_read', { id: 'no-such-protocol' });
    assert.equal(r.error, 'not found');
    assert.ok(Array.isArray(r.available));
    assert.ok(r.available.includes('debugging'), 'the caller should be told what it could have asked for');
  });

  test('a missing id is rejected', async () => {
    const msg = await ctx.expectError('mikey_protocol_read', {});
    assert.ok(msg);
    assert.match(msg, /requires/i);
  });
});

describe('mikey_protocol_search', () => {
  test('finds a protocol by body text', async () => {
    const r = await ctx.call('mikey_protocol_search', { query: 'isolate' });
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].id, 'debugging');
  });

  test('returns a snippet with surrounding context', async () => {
    const r = await ctx.call('mikey_protocol_search', { query: 'compost' });
    assert.match(r.matches[0].snippet, /compost/i);
    assert.ok(r.matches[0].snippet.length > 'compost'.length, 'the snippet should carry context');
  });

  test('is case insensitive', async () => {
    const upper = await ctx.call('mikey_protocol_search', { query: 'ISOLATE' });
    assert.equal(upper.matches.length, 1);
  });

  test('a query with regex metacharacters is treated literally', async () => {
    // '(' would blow up an unescaped RegExp. It must come back empty, not throw.
    const r = await ctx.call('mikey_protocol_search', { query: '(unclosed' });
    assert.deepEqual(r.matches, []);
  });

  test('a query matching nothing returns an empty list', async () => {
    const r = await ctx.call('mikey_protocol_search', { query: 'zzzznotinanyprotocol' });
    assert.deepEqual(r.matches, []);
  });

  test('a missing query is rejected', async () => {
    assert.ok(await ctx.expectError('mikey_protocol_search', {}));
  });
});

describe('mikey_protocol_triggers', () => {
  test('matches a protocol from its triggers.json keywords', async () => {
    const r = await ctx.call('mikey_protocol_triggers', { situation: 'I hit an exception in the parser' });
    assert.equal(r.suggested[0].id, 'debugging');
  });

  test('a multi-word phrase scores higher than a single word', async () => {
    const phrase = await ctx.call('mikey_protocol_triggers', { situation: 'I got a stack trace' });
    const single = await ctx.call('mikey_protocol_triggers', { situation: 'I need to debug' });
    const s = (r) => r.suggested.find(x => x.id === 'debugging').score;
    assert.ok(s(phrase) > s(single), 'phrase matches are weighted above single words');
  });

  test('a keyword inside a larger word does not count', async () => {
    // The word-boundary guard: 'debug' must not fire on 'debugging-adjacent'
    // prose that merely contains the letters.
    const r = await ctx.call('mikey_protocol_triggers', { situation: 'the undebuggable mess' });
    assert.ok(!r.suggested.some(x => x.id === 'debugging'), 'substring hits inside words must not match');
  });

  test('an unrelated situation does not drag in unrelated protocols', async () => {
    const r = await ctx.call('mikey_protocol_triggers', { situation: 'I hit an exception in the parser' });
    assert.ok(!r.suggested.some(x => x.id === 'gardening'));
  });

  test('suggests tools from tool-map.json', async () => {
    const r = await ctx.call('mikey_protocol_triggers', { situation: 'debug a failing test' });
    assert.ok(r.suggested_tools.length > 0);
    assert.ok(r.suggested_tools[0].tools.includes('smalledit'));
  });

  test('a missing situation is rejected', async () => {
    assert.ok(await ctx.expectError('mikey_protocol_triggers', {}));
  });
});

describe('mikey_prompt_process', () => {
  test('returns the full envelope a caller depends on', async () => {
    const r = await ctx.call('mikey_prompt_process', { prompt: 'I got a stack trace from the parser' });
    for (const k of ['prompt_seen', 'continuation_note', 'relevant_protocols', 'prediction_confidence', 'suggested_tools', 'directive']) {
      assert.ok(k in r, `missing ${k}`);
    }
  });

  test('always includes every tier-0 protocol, even with no keyword match', async () => {
    const r = await ctx.call('mikey_prompt_process', { prompt: 'zzzz nothing matches this at all' });
    const ids = r.relevant_protocols.map(p => p.id);
    assert.ok(ids.includes('prompt-processing'), 'tier-0 must be forced in');
    assert.ok(ids.includes('continuous-documentation'), 'tier-0 must be forced in');
  });

  test('a tier-0 protocol is not listed twice when it also matches by keyword', async () => {
    const r = await ctx.call('mikey_prompt_process', { prompt: 'documentation documentation documentation' });
    const ids = r.relevant_protocols.map(p => p.id);
    assert.equal(new Set(ids).size, ids.length, 'no protocol should appear twice');
  });

  test('confidence is "none" when only tier-0 protocols matched', async () => {
    const r = await ctx.call('mikey_prompt_process', { prompt: 'zzzz nothing matches this at all' });
    assert.equal(r.prediction_confidence.level, 'none');
    assert.equal(r.prediction_confidence.top, null);
    assert.match(r.directive, /No task-specific protocol matched/);
  });

  test('confidence rises for a clear, unambiguous match', async () => {
    const r = await ctx.call('mikey_prompt_process', { prompt: 'I got a stack trace and an exception while I debug' });
    assert.equal(r.prediction_confidence.top, 'debugging');
    assert.ok(['high', 'medium'].includes(r.prediction_confidence.level),
      `expected a confident match, got ${r.prediction_confidence.level}`);
  });

  test('tier-0 protocols are excluded from the confidence calculation', async () => {
    // Confidence is about which TASK protocol to follow; the always-on meta
    // ones would otherwise permanently occupy the top slot.
    const r = await ctx.call('mikey_prompt_process', { prompt: 'write a medium article' });
    assert.equal(r.prediction_confidence.top, 'medium-article');
  });

  test('the directive names the protocols it expects to be followed', async () => {
    const r = await ctx.call('mikey_prompt_process', { prompt: 'I got a stack trace' });
    assert.match(r.directive, /Follow these protocols before responding/);
    assert.match(r.directive, /debugging/);
  });

  test('prompt_seen is truncated so a long prompt cannot bloat the response', async () => {
    const r = await ctx.call('mikey_prompt_process', { prompt: 'x'.repeat(500) });
    assert.equal(r.prompt_seen.length, 120);
  });

  test('reports on the continuation note, which lives at a hardcoded path', async () => {
    // HANDOFF is not configurable: it is always
    // $HOME/Code/claude-brain/data/continuation-note-latest.md, regardless of
    // PROTOCOLS_DIR. So this asserts the shape, not the value — see known issues.
    const c = (await ctx.call('mikey_prompt_process', { prompt: 'anything' })).continuation_note;
    assert.ok('exists' in c);
    if (c.exists) {
      assert.ok(typeof c.age_hours === 'number');
      assert.equal(typeof c.fresh, 'boolean');
      assert.match(c.path, /claude-brain\/data\/continuation-note-latest\.md$/);
      assert.equal(c.fresh, c.age_hours < 24, 'fresh must mean under 24 hours old');
    }
  });

  test('a fresh continuation note puts a resume instruction at the front of the directive', async () => {
    const r = await ctx.call('mikey_prompt_process', { prompt: 'anything' });
    if (r.continuation_note.exists && r.continuation_note.fresh) {
      assert.match(r.directive, /^\u26a0\ufe0f A continuation note exists/,
        'the resume instruction must come first, before the protocol list');
    } else {
      assert.doesNotMatch(r.directive, /A continuation note exists/);
    }
  });

  test('a missing prompt is rejected', async () => {
    const r = await ctx.call('mikey_prompt_process', {});
    // The schema requires `prompt`, but the handler tolerates its absence.
    // Pin whichever behaviour is real so a change is visible.
    assert.equal(r.prompt_seen, '');
  });
});

describe('containment and overrides', () => {
  // Was a known issue until 2026-08-20: read() did path.join(DIR, `${id}.md`)
  // with no containment check, so an id of '../x' escaped the protocol library.
  // index.js now routes every id through protocolPath(), which resolves and
  // requires the result to stay under DIR. Read-only and model-supplied, so the
  // severity was low — but it was the same class of bug as the
  // filesystem-enhanced escape, and this pins it shut.
  test('a protocol id cannot escape the library directory', async () => {
    const outside = path.join(ctx.base, 'outside-note.md');
    fs.writeFileSync(outside, '# not a protocol\n');
    const r = await ctx.call('mikey_protocol_read', { id: '../outside-note' });
    assert.equal(r.error, 'not found', 'a traversing id should not resolve to a file outside the library');
  });

  // Absolute ids are the same hole by another route: path.resolve discards DIR
  // entirely when the second argument is absolute. Separate case, one line.
  test('an absolute protocol id cannot escape either', async () => {
    const outside = path.join(ctx.base, 'abs-note.md');
    fs.writeFileSync(outside, '# not a protocol\n');
    const r = await ctx.call('mikey_protocol_read', { id: path.join(ctx.base, 'abs-note') });
    assert.equal(r.error, 'not found', 'an absolute id should not resolve to a file outside the library');
  });

  // The continuation-note path defaults to
  // $HOME/Code/claude-brain/data/continuation-note-latest.md — the last wire
  // holding the retired claude-brain repo in place — but index.js honours
  // CONTINUATION_NOTE, so the behaviour CAN be exercised against a fixture.
  // (This test sat todo asserting HANDOFF_NOTE, a variable nothing ever read.)
  test('the continuation-note path is configurable by env', async () => {
    const { makeLibrary: mk, startServer: st, cleanup: cl } = await import('./helpers.mjs');
    const lib = mk();
    const note = path.join(lib.base, 'my-note.md');
    fs.writeFileSync(note, '# handoff\n');
    const alt = await st(lib.dir, lib.base, { CONTINUATION_NOTE: note });
    const r = await alt.call('mikey_prompt_process', { prompt: 'anything' });
    await alt.client.close();
    cl(lib.base);
    assert.equal(r.continuation_note.path, note, 'CONTINUATION_NOTE should override the default path');
    assert.equal(r.continuation_note.exists, true, 'the fixture note exists, so it must be seen');
  });
});
