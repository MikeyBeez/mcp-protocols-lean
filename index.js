#!/usr/bin/env node
/**
 * mcp-protocols-lean
 *
 * One protocol server over the existing markdown library. Replaces the cluster:
 *   - protocols        (library + prompt_process hook)  <- the only load-bearing one
 *   - protocol-engine  (step-runner; only ever held test data, dead since Aug 2025)
 *   - protocol-tracker (compliance logging; no persistent store)
 *
 * mcp-architecture is intentionally NOT folded in — it manages architecture documents,
 * a separate concern from protocols.
 *
 * Read-only over the .md library: it never modifies your protocol files. Tool names match
 * the originals (mikey_prompt_process, mikey_protocol_*) so existing workflow keeps working.
 *
 * 2026-06-10: prompt_process and protocol_triggers now also return `suggested_tools`,
 * matched from protocols/tool-map.json (situation -> tools map, read live like the .md
 * files, so the map can be edited without restarting the server).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

// Phase 4: best-effort ledger logging (enforcement-via-detection).
// Optional — if the helper is missing/broken the server still runs, logging disabled.
let noteCall = () => {};
try { ({ noteCall } = await import('../harness/ledger_log.mjs')); }
catch (e) { console.error('[protocols-lean] ledger logging disabled:', e.message); }

const DIR = CONFIG.PROTOCOLS_DIR;
if (!fs.existsSync(DIR)) { console.error(`[protocols-lean] FATAL: no protocols dir at ${DIR}`); process.exit(1); }

const ok  = (o) => ({ content: [{ type: 'text', text: typeof o === 'string' ? o : JSON.stringify(o, null, 2) }] });
const err = (m) => ({ content: [{ type: 'text', text: `Error: ${m}` }], isError: true });

const STOP = new Set(('the a an to of for and or is are be when need any new this that with your you my our it its as on in at by').split(' '));
const tokens = (s) => (s || '').toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 2 && !STOP.has(w)) || [];

// ---- load + parse the library ---------------------------------------------

function section(body, heading) {
  const re = new RegExp(`##+\\s*${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  const m = body.match(re); return m ? m[1].trim() : '';
}

function parseProtocol(file) {
  const id = path.basename(file, '.md');
  const body = fs.readFileSync(path.join(DIR, file), 'utf8');
  const title = (body.match(/^#\s+(.+)$/m) || [, id])[1].trim();
  const purpose = section(body, 'Purpose').replace(/\s+/g, ' ').slice(0, 300);
  const triggers = section(body, 'Trigger Conditions') || section(body, 'Triggers');
  const tier = (body.match(/Tier\*?\*?:\s*([^\n]+)/i) || [, ''])[1].trim();
  const priority = (body.match(/Priority\*?\*?:\s*([^\n]+)/i) || [, ''])[1].trim();
  return { id, title, purpose, tier, priority, triggers, body };
}

function loadAll() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.md')).map(parseProtocol);
}

// score a protocol against a free-text situation/prompt
function score(p, qToks) {
  if (!qToks.length) return 0;
  const hay = (p.title + ' ' + p.purpose + ' ' + p.triggers).toLowerCase();
  let s = 0;
  for (const t of qToks) if (hay.includes(t)) s += hay.includes(t) ? 1 : 0;
  // weight title/trigger hits a bit higher
  const tt = (p.title + ' ' + p.triggers).toLowerCase();
  for (const t of qToks) if (tt.includes(t)) s += 0.5;
  return s;
}

function match(text, limit = 4) {
  const promptLower = (text || '').toLowerCase();
  const qset = new Set(tokens(text));
  const trig = loadTriggers();
  return loadAll().map(p => ({ p, s: scoreKw(p, promptLower, qset, trig) }))
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit)
    .map(({ p, s }) => ({ id: p.id, title: p.title, tier: p.tier, score: Math.round(s * 10) / 10, why: `matched ${Math.round(s * 10) / 10} signal(s)`, purpose: p.purpose }));
}

// ---- situation -> tools map (protocols/tool-map.json, read live) -----------

function loadToolMap() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, 'tool-map.json'), 'utf8'));
  } catch { return []; }
}

function loadTriggers() {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, 'triggers.json'), 'utf8')).protocols || {}; }
  catch { return {}; }
}

// Keyword scoring from triggers.json (machine authority). Phrases (multi-word) match
// as substrings and weigh a bit more; single words match as tokens or substrings.
// Falls back to the old .md prose scoring if a protocol is absent from triggers.json.
// word-boundary match: avoids short keywords matching inside larger words
// (e.g. 'gh' must not match 'right'); handles phrases + hyphen/underscore compounds.
function wbTest(text, k) {
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + esc + '([^a-z0-9]|$)').test(text);
}
function scoreKw(p, promptLower, qset, trig) {
  const t = trig[p.id];
  if (t && Array.isArray(t.keywords) && t.keywords.length) {
    let s = 0;
    for (const k of t.keywords) if (wbTest(promptLower, k)) s += k.includes(' ') ? 1.5 : 1;
    return s;
  }
  return score(p, [...qset]);
}

function matchTools(text, limit = 4) {
  const q = new Set(tokens(text));
  if (!q.size) return [];
  return loadToolMap().map(e => {
    let s = 0;
    for (const k of (e.keywords || [])) if (q.has(k.toLowerCase())) s += 1;
    return { e, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit)
    .map(({ e, s }) => ({ situation: e.situation, tools: e.tools, note: e.note, why: `matched ${s} keyword(s)` }));
}

// ---- continuation note (surfaced through the one call that always runs) ----

const HANDOFF = path.join(process.env.HOME || '', 'Code/claude-brain/data/continuation-note-latest.md');

function continuationNotice() {
  try {
    const st = fs.statSync(HANDOFF);
    const ageH = Math.round(((Date.now() - st.mtimeMs) / 3.6e6) * 10) / 10;
    return { exists: true, age_hours: ageH, fresh: ageH < 24, path: HANDOFF };
  } catch { return { exists: false }; }
}

// ---- tools -----------------------------------------------------------------

function promptProcess({ prompt }) {
  const hits = match(prompt, 4);
  // prediction confidence over the TASK-relevant matches (exclude tier-0 always-active).
  // 'none' flags a likely TRUE-MISS (no protocol fits) live, in the directive.
  const taskHits = hits.filter(h => !/^0\b/.test((h.tier || '').trim()));
  const _top = taskHits[0], _second = taskHits[1];
  const _topScore = _top ? (_top.score || 0) : 0;
  const _margin = Math.round((_topScore - (_second ? (_second.score || 0) : 0)) * 10) / 10;
  const _level = !_top ? 'none' : (_topScore >= 2 && _margin >= 1 ? 'high' : (_topScore >= 1.5 ? 'medium' : 'low'));
  const prediction_confidence = { level: _level, top: _top ? _top.id : null, top_score: _topScore, margin: _margin };
  const confHint = _level === 'none'
    ? ' ⚠️ No task-specific protocol matched (trigger confidence: none) — consider whether a protocol is missing for this kind of request.'
    : (_level === 'low' ? ' (low trigger confidence — the match is weak.)' : '');
  // Tier-0 meta protocols are ALWAYS active and inject regardless of keyword score.
  // Keyword matching can't guarantee an always-on meta protocol, so we force them in here.
  const have = new Set(hits.map(h => h.id));
  const always = loadAll()
    .filter(p => /^0\b/.test((p.tier || '').trim()) && !have.has(p.id))
    .map(p => ({ id: p.id, title: p.title, tier: p.tier, why: 'tier-0 always-active', purpose: p.purpose }));
  const relevant = [...always, ...hits];
  const suggested_tools = matchTools(prompt, 4);
  const cont = continuationNotice();
  const contDirective = (cont.exists && cont.fresh)
    ? `⚠️ A continuation note exists (${cont.age_hours}h old) at ${cont.path}. BEFORE anything else, call continuation_read_with_staleness to resume the prior session, then open your reply with the timestamp. `
    : '';
  return {
    prompt_seen: (prompt || '').slice(0, 120),
    continuation_note: cont,
    relevant_protocols: relevant,
    prediction_confidence,
    suggested_tools,
    directive: contDirective + (relevant.length
      ? `Follow these protocols before responding: ${relevant.map(h => h.id).join(', ')}. Read any with mikey_protocol_read.`
        + (suggested_tools.length ? ` USE the suggested tools — they exist for this exact situation.` : '')
      : 'No specific protocol triggered; proceed normally.') + confHint,
  };
}

function list() {
  return loadAll().map(p => ({ id: p.id, title: p.title, tier: p.tier, priority: p.priority, purpose: p.purpose }));
}

function read({ id }) {
  if (!id) throw new Error('protocol_read requires `id`');
  const f = path.join(DIR, `${id}.md`);
  if (!fs.existsSync(f)) return { id, error: 'not found', available: loadAll().map(p => p.id) };
  return { id, content: fs.readFileSync(f, 'utf8') };
}

function search({ query }) {
  if (!query) throw new Error('protocol_search requires `query`');
  const q = query.toLowerCase();
  return {
    query,
    matches: loadAll().filter(p => p.body.toLowerCase().includes(q))
      .map(p => ({ id: p.id, title: p.title, snippet: (p.body.match(new RegExp(`.{0,60}${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.{0,60}`, 'i')) || [''])[0].replace(/\s+/g, ' ').trim() })),
  };
}

function triggers({ situation }) {
  if (!situation) throw new Error('protocol_triggers requires `situation`');
  return { situation, suggested: match(situation, 5), suggested_tools: matchTools(situation, 4) };
}

const TOOLS = {
  mikey_prompt_process:   { fn: promptProcess, desc: 'Pre-process a user prompt: returns the protocols whose triggers match, suggested tools for the situation, plus a directive. Run before responding.', schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  mikey_protocol_list:    { fn: list,          desc: 'List all available protocols with tier and purpose.', schema: { type: 'object', properties: {} } },
  mikey_protocol_read:    { fn: read,          desc: 'Read the full text of a protocol by id.', schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  mikey_protocol_search:  { fn: search,        desc: 'Full-text search across protocol bodies.', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  mikey_protocol_triggers:{ fn: triggers,      desc: 'Given a situation, return the most relevant protocols and the tools to use for it.', schema: { type: 'object', properties: { situation: { type: 'string' } }, required: ['situation'] } },
};

const server = new Server({ name: 'mcp-protocols-lean', version: '1.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.desc, inputSchema: t.schema })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};
  const t = TOOLS[name];
  if (!t) return err(`unknown tool: ${name}`);
  let status = 'success', result, raw;
  try { raw = t.fn(args); result = ok(raw); } catch (e) { status = 'failure'; result = err(e.message); }
  try { noteCall('protocols', name, args, status, raw); } catch { /* never break the call */ }
  return result;
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[protocols-lean] connected. dir=${DIR} protocols=${loadAll().length} toolmap=${loadToolMap().length}`);
