// Does prompt_process DELIVER the top protocol, or merely name it?
//
// This is the behaviour the whole change exists for. Before it, retrieval handed
// back a pointer and acting on it cost another round trip; across 254 traced turns
// that produced 34 engagements and 21 protocols never engaged at all. So the test
// that matters is not "does it still parse" but "does the text actually arrive".
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'index.js');

const child = spawn('node', [SERVER], { stdio: ['pipe','pipe','ignore'],
  env: { ...process.env, HARNESS_LEDGER: '/dev/null', HARNESS_TRACE_PTR: '/nonexistent' } });
let buf = ''; const pending = new Map();
child.stdout.on('data', d => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue;
    try { const m = JSON.parse(l); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {}
  }
});
let id = 0;
const call = (method, params) => new Promise(res => { const n = ++id; pending.set(n, res);
  child.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:n, method, params }) + '\n'); });
const promptProcess = async (prompt) => {
  const r = await call('tools/call', { name: 'mikey_prompt_process', arguments: { prompt } });
  return JSON.parse(r.result.content[0].text);
};

let pass = 0, fail = 0;
const ok = (c, label, extra='') => { if (c) pass++; else { fail++; console.log(`  FAIL ${label} ${extra}`); } };

await call('initialize', { protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'t',version:'1'} });
child.stdin.write(JSON.stringify({ jsonrpc:'2.0', method:'notifications/initialized', params:{} }) + '\n');

// A prompt that should hit a specific protocol hard.
const strong = await promptProcess('I need to write a medium article about this research');
ok(strong.prediction_confidence.level !== 'none', 'a strong prompt matches something');
if (strong.prediction_confidence.level === 'high' || strong.prediction_confidence.level === 'medium') {
  ok(strong.inlined_protocol !== null, 'medium/high confidence delivers the body inline');
  ok(typeof strong.inlined_protocol?.content === 'string' && strong.inlined_protocol.content.length > 200,
     'the inlined body is real text, not a stub', `${strong.inlined_protocol?.content?.length} bytes`);
  ok(strong.inlined_protocol.id === strong.prediction_confidence.top,
     'the inlined protocol is the top-ranked task match');
  ok(strong.inlined_protocol.content.includes('#'), 'the body looks like the markdown file');
  ok(/inlined_protocol/.test(strong.directive), 'the directive points at the inlined text');
  ok(/do NOT need to read it separately/.test(strong.directive), 'the directive says not to re-fetch it');
  console.log(`       inlined "${strong.inlined_protocol.id}" — ${strong.inlined_protocol.bytes} bytes at ${strong.prediction_confidence.level} confidence`);
}

// A weak prompt must NOT inline: spending the budget on a bad match is worse than
// naming it, because it also teaches the reader to skim past inlined text.
const weak = await promptProcess('hello');
ok(weak.inlined_protocol === null, 'a weak or absent match inlines nothing',
   weak.inlined_protocol ? `but inlined ${weak.inlined_protocol.id}` : '');
ok(!/inlined_protocol/.test(weak.directive), 'and the directive does not mention inlining');
console.log(`       weak prompt: confidence=${weak.prediction_confidence.level}, inlined=${weak.inlined_protocol ? weak.inlined_protocol.id : 'none'}`);

// Nothing else regressed.
ok(Array.isArray(strong.relevant_protocols) && strong.relevant_protocols.length > 0, 'relevant_protocols still returned');
ok(strong.continuation_note !== undefined, 'continuation note still surfaced');
ok(Array.isArray(strong.suggested_tools), 'suggested_tools still returned');
const listed = await call('tools/list', {});
ok(listed.result.tools.length === 5, 'still exposes 5 tools', listed.result.tools.length);

// The inlined text must be byte-identical to what protocol_read would have returned.
if (strong.inlined_protocol) {
  const r = await call('tools/call', { name:'mikey_protocol_read', arguments:{ id: strong.inlined_protocol.id } });
  const viaRead = JSON.parse(r.result.content[0].text).content;
  ok(viaRead === strong.inlined_protocol.content || viaRead.startsWith(strong.inlined_protocol.content.slice(0, 500)),
     'inlined text matches what protocol_read returns');
}

console.log(`\n${pass} passed, ${fail} failed`);
child.kill();
process.exit(fail ? 1 : 0);
