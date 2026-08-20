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
import { execFileSync } from 'node:child_process';
import { CONFIG } from './config.js';

// Phase 4: best-effort ledger logging (enforcement-via-detection).
// Optional — if the helper is missing/broken the server still runs, logging disabled.
let noteCall = () => {};
let complianceGap = () => [];
try { ({ noteCall, complianceGap } = await import('../harness/ledger_log.mjs')); }
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

/** Raw text of one protocol, or null. Used to inline the top match. */
function readBody(id) {
  try { return fs.readFileSync(path.join(DIR, `${id}.md`), 'utf8'); } catch { return null; }
}

// How much protocol text to put in front of the model at once. The library is 36
// files, mean 5.3 KB, p90 8.1 KB, largest 10.8 KB — so one whole protocol is
// affordable and four are not. Hence: exactly one, and only when the match is good.
const INLINE_MAX = 14000;

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


// ---- protocol graph (edges.json) -------------------------------------------
// Wired 2026-08-19 (plan step 4). Rationale: keyword scoring judges each protocol
// in isolation, but failure situations run in chains — stop, recover, escalate.
// After scoring, pull the top match's escalates_to / pairs_with neighbours in at
// REDUCED weight so the whole spine surfaces. A neighbour can never outrank the
// direct keyword match; it is a suggestion, not a verdict.
const EDGE_TYPES_PULLED = ['escalates_to', 'pairs_with'];
const NEIGHBOUR_WEIGHT = 0.35;
let _edges = null;
function loadEdges() {
  if (_edges) return _edges;
  const m = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'edges.json'), 'utf8'));
    for (const e of (raw.edges || [])) {
      if (!EDGE_TYPES_PULLED.includes(e.type)) continue;
      for (const t of (e.to || [])) {
        if (!m.has(e.from)) m.set(e.from, []);
        m.get(e.from).push({ to: t, type: e.type });
        if (e.type === 'pairs_with') {           // lateral: symmetric
          if (!m.has(t)) m.set(t, []);
          m.get(t).push({ to: e.from, type: e.type });
        }
      }
    }
  } catch (err) {
    // Do NOT swallow. A silent catch here hid a ReferenceError for the whole of
    // 2026-08-19's first wiring attempt: the graph simply never loaded and the
    // matcher looked fine. Degrade, but say so on stderr.
    console.error(`[protocols] edges.json not loaded, running without the graph: ${err.message}`);
  }
  _edges = m; return m;
}


// ---- engram fallback (hybrid: keywords decide, embeddings rescue) -----------
// Wired 2026-08-20 at Mikey's call ("we can have both"). Measured on 261 historical
// prompts: 185 got none/low from keywords, and 34 of those (18%) have a semantic
// top-1 >= 0.65 pointing at a protocol that plainly should have fired — e.g.
// "smoke training job on pop, 150-step SGD regression" -> training-run-management
// at 0.708, containing no word any sane trigger list would hold. Those 34 are what
// this is for. It ADDS a candidate; it never edits triggers.json and never outranks
// a confident keyword match, so June's precision work stays intact.
const ENGRAM_MIN = 0.65;
const ENGRAM_MODEL = 'nomic-embed-text';
let _pvecs = undefined;
function protocolVectors() {
  if (_pvecs !== undefined) return _pvecs;
  try {
    const f = path.join(DIR, '..', 'protocol-engrams.json');
    _pvecs = JSON.parse(fs.readFileSync(f, 'utf8')).vectors || null;
  } catch (err) {
    console.error(`[protocols] no protocol-engrams.json, engram fallback off: ${err.message}`);
    _pvecs = null;
  }
  return _pvecs;
}
function embedSync(text) {
  try {
    const body = JSON.stringify({ model: ENGRAM_MODEL, prompt: `search_query: ${String(text).slice(0, 4000)}` });
    const out = execFileSync('/usr/bin/curl',
      ['-s','-m','3','-X','POST','http://localhost:11434/api/embeddings','-H','Content-Type: application/json','-d',body],
      { encoding: 'utf8', timeout: 4000 });
    return JSON.parse(out).embedding || null;
  } catch { return null; }   // ollama down / slow -> keywords alone, silently fine
}
function engramMatch(text) {
  const V = protocolVectors(); if (!V) return null;
  const v = embedSync(text);  if (!v) return null;
  let bestP = null, bestS = -1;
  for (const [pid, pv] of Object.entries(V)) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < pv.length && i < v.length; i++) { d += v[i]*pv[i]; na += v[i]*v[i]; nb += pv[i]*pv[i]; }
    const c = (na && nb) ? d / (Math.sqrt(na)*Math.sqrt(nb)) : 0;
    if (c > bestS) { bestS = c; bestP = pid; }
  }
  return bestS >= ENGRAM_MIN ? { id: bestP, similarity: Math.round(bestS*1000)/1000 } : null;
}

function match(text, limit = 4) {
  const promptLower = (text || '').toLowerCase();
  const qset = new Set(tokens(text));
  const trig = loadTriggers();
  const all = loadAll();
  const scored = new Map();                       // id -> {p, s, why}
  for (const p of all) {
    const s = scoreKw(p, promptLower, qset, trig);
    if (s > 0) scored.set(p.id, { p, s, why: `matched ${Math.round(s * 10) / 10} signal(s)` });
  }

  // --- graph pull: neighbours of the top keyword match, at reduced weight ---
  const ranked0 = [...scored.values()].sort((a, b) => b.s - a.s);
  const top = ranked0[0];
  if (top) {
    const ceiling = top.s - 0.1;                  // a neighbour never ties or beats the direct match
    const boost = Math.min(top.s * NEIGHBOUR_WEIGHT, ceiling);
    for (const { to, type } of (loadEdges().get(top.p.id) || [])) {
      if (to === top.p.id) continue;
      const existing = scored.get(to);
      if (existing) {
        const lifted = Math.min(existing.s + boost, ceiling);
        if (lifted > existing.s) {
          existing.s = lifted;
          if (!existing.why.includes('via ')) existing.why += ` + via ${type} from ${top.p.id}`;
        }
      } else {
        const pr = all.find(x => x.id === to);
        if (pr && boost > 0) scored.set(to, { p: pr, s: boost, why: `graph: via ${type} from ${top.p.id}` });
      }
    }
  }

  return [...scored.values()]
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit)
    .map(({ p, s, why }) => ({ id: p.id, title: p.title, tier: p.tier, score: Math.round(s * 10) / 10, why, purpose: p.purpose }));
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

// Overridable so tests (and any future relocation) do not have to move the real file.
// It was hardcoded, which is why the existing suite could not exercise this path.
const HANDOFF = process.env.CONTINUATION_NOTE
  || path.join(process.env.HOME || '', 'Code/claude-brain/data/continuation-note-latest.md');

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

  // Keywords were not confident. Ask the engrams whether they can see something.
  let engram = null;
  if (_level === 'low' || _level === 'none') {
    engram = engramMatch(prompt);
    if (engram) {
      prediction_confidence.engram = engram;
      const already = taskHits.find(h => h.id === engram.id);
      if (already) {
        already.why += ` + engram ${engram.similarity}`;
      } else {
        const pr = loadAll().find(x => x.id === engram.id);
        if (pr) taskHits.push({ id: pr.id, title: pr.title, tier: pr.tier, score: 0,
          why: `engram: semantic match ${engram.similarity} (no keyword hit)`, purpose: pr.purpose });
      }
    }
  }
  const confHint = _level === 'none'
    ? ' ⚠️ No task-specific protocol matched (trigger confidence: none) — consider whether a protocol is missing for this kind of request.'
    : (_level === 'low' ? ' (low trigger confidence — the match is weak.)' : '');
  // Compliance back-check: did the PREVIOUS turn ignore a strongly-recommended protocol?
  let gapHint = '';
  try {
    const _gaps = complianceGap();
    if (_gaps && _gaps.length) gapHint = ` ↩️ FOLLOW-UP from last turn: "${_gaps[0]}" was strongly recommended and there is no record you engaged it. This is EITHER a compliance error (you skipped it) OR a logging error (you applied it but it was not recorded). Check both: if you did NOT apply it, read it now (mikey_protocol_read) and apply it; if you DID apply it, record that engagement now so the ledger reflects reality. Do NOT just disregard — an unrecorded application is a logging error that corrupts the loop's own data. `;
  } catch {}
  // Tier-0 meta protocols are ALWAYS active and inject regardless of keyword score.
  // Keyword matching can't guarantee an always-on meta protocol, so we force them in here.
  const have = new Set(hits.map(h => h.id));
  const always = loadAll()
    .filter(p => /^0\b/.test((p.tier || '').trim()) && !have.has(p.id))
    .map(p => ({ id: p.id, title: p.title, tier: p.tier, why: 'tier-0 always-active', purpose: p.purpose }));
  const relevant = [...always, ...hits];

  // ---- deliver the top match, do not merely name it -------------------------
  //
  // Retrieval was never the problem here. Across 254 traced turns the ledger held
  // 233 protocol spans, of which 200 were prompt-processing recording itself: 34
  // real engagements, about one turn in seven, and 21 of 36 protocols never engaged
  // even once. Meanwhile the ONE protocol that fires reliably is prompt-processing —
  // the only one whose content arrives inline, inside this directive.
  //
  // The protocols that get followed are the ones you do not have to go fetch. That
  // is an interface property, not a discipline problem, so the interface changes:
  // the top task-relevant protocol arrives as text, not as a name plus a round trip.
  //
  // Only one, and only at medium or high confidence. A weak match inlined is worse
  // than a weak match named — it spends the budget AND teaches the reader to skim
  // past inlined text.
  let inlined = null;
  if (_top && (_level === 'high' || _level === 'medium')) {
    const body = readBody(_top.id);
    if (body) {
      const truncated = body.length > INLINE_MAX;
      inlined = {
        id: _top.id,
        title: _top.title,
        why: `top task-relevant match at ${_level} confidence (score ${_topScore}, margin ${_margin})`,
        bytes: Math.min(body.length, INLINE_MAX),
        truncated,
        content: truncated
          ? body.slice(0, INLINE_MAX) + `\n\n[truncated at ${INLINE_MAX} bytes — read the rest with mikey_protocol_read id=${_top.id}]`
          : body,
      };
    }
  }
  const inlineDirective = inlined
    ? ` The full text of "${inlined.id}" is included below under \`inlined_protocol\` — it is the top match and you do NOT need to read it separately. APPLY it.`
    : '';

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
    inlined_protocol: inlined,
    suggested_tools,
    directive: contDirective + gapHint + (relevant.length
      ? `Follow these protocols before responding: ${relevant.map(h => h.id).join(', ')}.`
        + inlineDirective
        + ` Read any of the others with mikey_protocol_read.`
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

let improvement = null;
try { improvement = await import('../harness/improvement.mjs'); }
catch (err) { console.error(`[protocols] improvement loop unavailable: ${err.message}`); }
const needLoop = () => ({ ok: false, error: 'improvement loop module not loaded — see stderr' });

const TOOLS = {
  mikey_prompt_process:   { fn: promptProcess, desc: 'Pre-process a user prompt: returns the protocols whose triggers match, suggested tools for the situation, plus a directive. Run before responding.', schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  mikey_protocol_list:    { fn: list,          desc: 'List all available protocols with tier and purpose.', schema: { type: 'object', properties: {} } },
  mikey_protocol_read:    { fn: read,          desc: 'Read the full text of a protocol by id.', schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  mikey_protocol_search:  { fn: search,        desc: 'Full-text search across protocol bodies.', schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  mikey_protocol_triggers:{ fn: triggers,      desc: 'Given a situation, return the most relevant protocols and the tools to use for it.', schema: { type: 'object', properties: { situation: { type: 'string' } }, required: ['situation'] } },
  mikey_propose:          { fn: a => improvement ? improvement.propose(a) : needLoop(),
    desc: 'Propose a change to a protocol. Records what should change and why. Trigger-keyword changes apply automatically (guarded); everything else waits for Mikey.',
    schema: { type: 'object', properties: {
      protocol_id: { type: 'string' },
      change_type: { type: 'string', enum: ['add_step','clarify_step','add_trigger','add_failure_mode','new_protocol','retire'] },
      description: { type: 'string' }, reason: { type: 'string' }, evidence: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' }, description: 'For add_trigger — supplying these auto-applies.' },
      trace_id: { type: 'string' } }, required: ['protocol_id','change_type','description'] } },
  mikey_review_proposals: { fn: a => improvement ? improvement.reviewProposals(a || {}) : needLoop(),
    desc: 'List protocol-change proposals, with the trace each came from. The human review point.',
    schema: { type: 'object', properties: { status: { type: 'string', enum: ['pending','applied','rejected','all'] }, limit: { type: 'number' } } } },
  mikey_apply_proposal:   { fn: a => improvement ? improvement.applyProposal(a) : needLoop(),
    desc: 'Apply or reject a proposal. Prose changes REQUIRE new_text; this tool never writes protocol prose itself. Always backs up first.',
    schema: { type: 'object', properties: {
      id: { type: 'number' }, approve: { type: 'boolean' },
      keywords: { type: 'array', items: { type: 'string' } },
      section: { type: 'string' }, new_text: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } },
  mikey_graduation_track: { fn: a => improvement ? improvement.graduationTrack(a) : needLoop(),
    desc: 'Record that a protocol ran and whether it worked. Flags when one is stable enough to become a tool.',
    schema: { type: 'object', properties: {
      protocol_id: { type: 'string' }, execution_type: { type: 'string', enum: ['text','chunked','tool'] },
      success: { type: 'boolean' }, complexity_score: { type: 'number' }, trace_id: { type: 'string' } },
      required: ['protocol_id'] } },
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
