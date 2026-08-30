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

/** Shorten to `max` without ever splitting a word, and mark the cut so it reads as
 *  shortened rather than as text that ended. Silent truncation is the bug; the ellipsis
 *  is the whole fix. Same lesson as gen-tool-inventory.mjs, where a mid-word cut turned
 *  "brain_recall" into "brain_re" and made the contract checker report a phantom tool. */
function clip(s, max) {
  const t = String(s || '');
  if (t.length <= max) return t;
  let cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  if (sp > 0) cut = cut.slice(0, sp);
  return cut.replace(/[\s,;:.\-]+$/, '') + '…';
}

function parseProtocol(file) {
  const id = path.basename(file, '.md');
  const body = fs.readFileSync(path.join(DIR, file), 'utf8');
  const title = (body.match(/^#\s+(.+)$/m) || [, id])[1].trim();
  // Cut at a WORD BOUNDARY and SAY that it was cut. A bare .slice(0,300) here produced
  // exactly the symptom Mikey reported on 2026-08-22 -- "partial sentences, things cut
  // off" -- and an example is visible in that day's own transcript: intent-gate's purpose
  // arrived ending "...hard to write down (ties to strugg". No ellipsis, no marker, so it
  // reads as text that simply stops rather than text that was shortened. This field is in
  // front of the model on EVERY prompt_process call, which is why it was the one people saw.
  // FALL BACK to the `- **Purpose**:` metadata line when there is no `## Purpose` SECTION.
  // Found 2026-08-22 by protocol_critic: three protocols -- create-project, tool-selection
  // and training-run-management -- state their purpose ONLY on the metadata line, so this
  // parser returned '' and every prompt_process result showed them with an empty purpose.
  // tool-selection is among the most-matched protocols in the library; it had been arriving
  // with no purpose text for as long as this parser has existed.
  const purposeText = section(body, 'Purpose')
    || (body.match(/^-\s*\*\*Purpose\*\*:\s*(.+)$/m) || [, ''])[1]
    || '';
  const purpose = clip(purposeText.replace(/\s+/g, ' '), 300);
  const triggers = section(body, 'Trigger Conditions') || section(body, 'Triggers');
  const tier = (body.match(/Tier\*?\*?:\s*([^\n]+)/i) || [, ''])[1].trim();
  const priority = (body.match(/Priority\*?\*?:\s*([^\n]+)/i) || [, ''])[1].trim();
  return { id, title, purpose, tier, priority, triggers, body };
}

function loadAll() {
  return fs.readdirSync(DIR).filter(f => f.endsWith('.md')).map(parseProtocol);
}

/** Resolve a protocol id to its file INSIDE the library, or null if it escapes.
 *  path.join(DIR, `${id}.md`) is not containment: an id of '../x', or an absolute
 *  path, resolves to a file outside the library. Read-only, and ids come from the
 *  model rather than an outside caller, so severity is low — but it is the same
 *  class of bug as the filesystem-enhanced escape. BOTH call sites (readBody and
 *  read) go through here; fixing one and not the other leaves the hole open. */
function protocolPath(id) {
  const base = path.resolve(DIR);
  const f = path.resolve(base, `${id}.md`);
  return f.startsWith(base + path.sep) ? f : null;
}

/** Raw text of one protocol, or null. Used to inline the top match. */
function readBody(id) {
  const f = protocolPath(id);
  if (!f) return null;
  try { return fs.readFileSync(f, 'utf8'); } catch { return null; }
}

// How much protocol text to put in front of the model at once. The library is 36
// files, mean 5.3 KB, p90 8.1 KB, largest 10.8 KB — so one whole protocol is
// affordable and four are not. Hence: exactly one, and only when the match is good.
const INLINE_MAX = 14000;
// A SECOND inline slot, for tier-1 protocols only.
//
// WHY (measured 2026-08-22). Only the TOP match was ever delivered as text; everything
// else arrived as a name in a list. Being second was nearly the same as not matching.
// That is survivable for a tier-2 protocol and not survivable for tier 1, which is where
// the safety rules live -- github-anonymization governs what gets pushed to the internet.
//
// It matters MORE on this surface than it looks. The UserPromptSubmit hook, which used to
// inject several protocols in full, was proven that day to fire ONLY in the Claude Code
// CLI: 13 hours of desktop/Cowork prompts produced no hook.log entry, while one CLI prompt
// produced one immediately. So on the surface Mikey actually talks to, this tool IS the
// enforcement layer -- there is no hook rung above it.
//
// Tier 1 only, and a tighter budget than the top slot. Tier 0 is excluded on purpose:
// it always matches, so inlining it would spend the budget every single turn and teach
// the reader to skim past inlined text, which is the one thing that would break the top
// slot too.
const SAFETY_INLINE_MAX = 7000;
const SAFETY_INLINE_LIMIT = 2;

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

// ---- session brain boot (folded in 2026-08-22) -----------------------------
//
// WHY THIS LIVES HERE. Mikey's standing instruction was "call brain_init at
// session start", and on 2026-08-21 a four-hour session never called it once.
// He then changed the instruction to "before responding to ANY user message",
// which removes the ambiguity but re-reads ~36,800 characters (~9,200 tokens) of
// byte-identical text every turn -- about 368,000 tokens over a forty-turn
// session. His own better idea, from the same evening: put the call INSIDE a tool
// that has to run anyway, so it stops being a decision at all. prompt_process is
// that tool.
//
// Loaded once per session, then not again. "Session" is approximated by an
// inactivity gap, because the server process outlives any single session -- it is
// spawned when the app launches and serves every session until the app quits, so
// a plain once-per-process flag would starve every session after the first.
//
// Reads brain.db directly through the sqlite3 CLI rather than adding a native
// dependency to this server. Fails soft: no brain, no problem, routing still works.

const BRAIN_DB = path.join(process.env.HOME || '', 'Code/Claude_Data/brain/brain.db');
const SQLITE = ['/usr/bin/sqlite3', '/opt/homebrew/bin/sqlite3'].find(p => { try { return fs.existsSync(p); } catch { return false; } });
const SESSION_GAP_MS = 30 * 60 * 1000;   // 30 min of silence => treat the next call as a new session
// PERSISTED across process restarts (2026-08-30, Mikey: use pointers so the
// payload can be dropped after it runs). The old in-memory flag reset every
// time the app or the MCP bridge respawned this server, so one conversation
// received the full ~9K-token brain payload once per reconnect -- measured
// six deliveries in a single session on 2026-08-29/30. A stamp file survives
// the respawn; the payload re-sends only after a true 30-minute silence gap.
const BOOT_STAMP = path.join(process.env.HOME || '', 'Code/Claude_Data/brain/.prompt_process_last');
function readStamp() { try { return parseInt(fs.readFileSync(BOOT_STAMP, 'utf8'), 10) || 0; } catch { return 0; } }
function writeStamp(t) { try { fs.writeFileSync(BOOT_STAMP, String(t)); } catch {} }
let _lastPromptAt = readStamp();
let _freshProcess = true;

function sq(query) {
  if (!SQLITE || !fs.existsSync(BRAIN_DB)) return null;
  try {
    const out = execFileSync(SQLITE, ['-json', '-readonly', BRAIN_DB, query], { encoding: 'utf8', timeout: 5000 });
    return out.trim() ? JSON.parse(out) : [];
  } catch { return null; }
}

// Same four queries brain_init runs (mcp-brain-lean/index.js init()), so the
// folded-in payload and the standalone tool cannot drift apart.
function brainBoot() {
  const identity = sq("SELECT key,value FROM memories WHERE type IN ('identity','core_principle','philosophy') ORDER BY updated_at DESC LIMIT 8");
  if (identity === null) return null;
  const user_preferences = sq("SELECT key,value FROM memories WHERE type IN ('user_preferences','user_preference','user_profile') ORDER BY updated_at DESC LIMIT 8");
  const recent = sq("SELECT key,type,substr(value,1,120) AS snippet,updated_at FROM memories ORDER BY updated_at DESC LIMIT 10");
  const total = sq("SELECT count(*) AS n FROM memories");
  return {
    loaded_because: 'first prompt_process of this session',
    total_memories: total && total[0] ? total[0].n : null,
    identity: identity || [],
    user_preferences: user_preferences || [],
    recent: recent || [],
  };
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

// FIXED 2026-08-22. This used to test `tokenSet.has(keyword)`, so a multi-word
// keyword could never equal a single token and every PHRASE in tool-map.json
// scored zero -- silently, forever. Measured before the fix: 22 of 154 keywords
// were dead, and the mcp-github-research entry had 14 of its 15 dead ("prior art",
// "has anyone", "already working", "been reported" -- every phrase Mikey would
// actually say). Only the bare word "upstream" survived, which is why that server
// showed 1 call after being deliberately routed.
//
// It now uses the SAME wbTest as scoreKw() does for protocols, so the two matchers
// agree and phrases weigh slightly more, exactly as they do on the protocol side.
function matchTools(text, limit = 4) {
  const promptLower = (text || '').toLowerCase();
  if (!promptLower.trim()) return [];
  return loadToolMap().map(e => {
    let s = 0;
    for (const k of (e.keywords || [])) if (wbTest(promptLower, k)) s += k.includes(' ') ? 1.5 : 1;
    return { e, s };
  }).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit)
    .map(({ e, s }) => ({ situation: e.situation, tools: e.tools, note: e.note, why: `matched ${s} keyword(s)` }));
}

// ---- continuation note (surfaced through the one call that always runs) ----

// Overridable so tests (and any future relocation) do not have to move the real file.
// The env var is CONTINUATION_NOTE. Exercised by test/protocols.test.mjs.
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
  let engram = null, engramPromoted = null;
  if (_level === 'low' || _level === 'none') {
    engram = engramMatch(prompt);
    if (engram) {
      prediction_confidence.engram = engram;
      const already = taskHits.find(h => h.id === engram.id);
      if (already) {
        already.why += ` + engram ${engram.similarity}`;
      } else {
        const pr = loadAll().find(x => x.id === engram.id);
        if (pr) {
          // FIXED 2026-08-22. This used to push onto taskHits ONLY. taskHits is a
          // .filter() of hits -- a NEW array -- so the rescued protocol was computed,
          // appended to a throwaway, and never reached `relevant`, which is built from
          // `hits`. The engram was not merely "reported but not acted on"; it was
          // dropped on the floor.
          //
          // Measured cost of that, 2026-08-21: on "it should be a repo if it's
          // anonymized" the keywords scored github-anonymization at ZERO (the prompt
          // contains none of push/github/publish/remote/origin) while the engram saw
          // it at 0.759, the highest similarity of that whole session. It is a TIER 1
          // safety protocol governing what gets published to the internet, and the
          // directive never named it. The next action on the table was `gh repo
          // create` on a repo holding an ssh config block.
          const rescued = { id: pr.id, title: pr.title, tier: pr.tier, score: 0,
            why: `engram: semantic match ${engram.similarity} (no keyword hit)`, purpose: pr.purpose };
          const tier01 = /^[01]\b/.test((pr.tier || '').trim());
          if (tier01 && engram.similarity >= 0.70) {
            // A strong hit on a tier 0/1 protocol is promoted to the FRONT and named in
            // the directive. Deliberately narrower than the 0.65 rescue floor and scoped
            // to the two tiers that carry safety and always-on meta rules, so it cannot
            // flood the list with tier-2 guesses.
            rescued.why = `engram rescue ${engram.similarity} — TIER ${pr.tier.trim()[0]}, keywords missed it entirely`;
            engramPromoted = rescued;
            hits.unshift(rescued);
          } else {
            hits.push(rescued);
          }
          taskHits.push(rescued);
        }
      }
    }
  }
  const engramHint = engramPromoted
    ? ` ⚠️ ${engramPromoted.id} was matched by MEANING, not by keywords — its trigger words are absent from this prompt and it is tier ${engramPromoted.tier.trim()[0]}. Treat it as recommended, not incidental.`
    : '';
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

  // Tier-1 matches are DELIVERED, never merely named -- see SAFETY_INLINE_MAX above.
  const also_inlined = [];
  for (const h of relevant) {
    if (also_inlined.length >= SAFETY_INLINE_LIMIT) break;
    if (!/^1\b/.test((h.tier || '').trim())) continue;
    if (inlined && h.id === inlined.id) continue;
    const body = readBody(h.id);
    if (!body) continue;
    const truncated = body.length > SAFETY_INLINE_MAX;
    also_inlined.push({
      id: h.id, title: h.title, tier: h.tier,
      why: `TIER 1 and it matched (${h.why}) — tier-1 protocols are delivered, not named`,
      bytes: Math.min(body.length, SAFETY_INLINE_MAX),
      truncated,
      content: truncated
        ? body.slice(0, SAFETY_INLINE_MAX) + `\n\n[truncated at ${SAFETY_INLINE_MAX} bytes — read the rest with mikey_protocol_read id=${h.id}]`
        : body,
    });
  }
  const safetyDirective = also_inlined.length
    ? ` ⚠️ TIER 1 also matched: ${also_inlined.map(x => x.id).join(', ')} — full text is below under \`also_inlined\`. These are the critical-tier rules; APPLY them too, do not skim past them because they are not the top match.`
    : '';

  const suggested_tools = matchTools(prompt, 4);

  // Fold in the session brain load. Once per session, not once per turn.
  const _now = Date.now();
  const _newSession = (_now - _lastPromptAt) > SESSION_GAP_MS;
  const _sinceMin = _lastPromptAt ? Math.round((_now - _lastPromptAt) / 60000) : null;
  _lastPromptAt = _now;
  writeStamp(_now);
  let brain = _newSession ? brainBoot() : null;
  if (!brain && _freshProcess) {
    // Fresh process, ongoing conversation: hand back a POINTER, not a copy.
    brain = { already_loaded: true, minutes_since_last_delivery: _sinceMin,
              note: 'brain payload was already delivered to this conversation; call brain_init only if this is genuinely a new conversation with no brain context above.' };
  }
  _freshProcess = false;
  const brainDirective = (brain && brain.identity)
    ? `Session context is included below under \`brain\` (${brain.total_memories} memories; identity, preferences, and the 10 most recent). This is the brain_init payload, loaded once for this session — you do NOT need to call brain_init separately. `
    : '';

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
    also_inlined,
    suggested_tools,
    brain,
    directive: brainDirective + contDirective + engramHint + gapHint + (relevant.length
      ? `Follow these protocols before responding: ${relevant.map(h => h.id).join(', ')}.`
        + inlineDirective
        + safetyDirective
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
  const f = protocolPath(id);
  if (!f || !fs.existsSync(f)) return { id, error: 'not found', available: loadAll().map(p => p.id) };
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
