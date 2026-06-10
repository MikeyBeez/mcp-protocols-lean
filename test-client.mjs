import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'node', args: ['index.js'], env: { ...process.env } });
const c = new Client({ name: 't', version: '1' }, { capabilities: {} });
await c.connect(transport);
const call = async (n, a = {}) => JSON.parse((await c.callTool({ name: n, arguments: a })).content[0].text);

const tools = await c.listTools();
console.log('TOOLS:', tools.tools.map(t => t.name).join(', '));

console.log('\nlist:');
const l = await call('mikey_protocol_list');
l.forEach(p => console.log('  -', p.id, '| tier:', p.tier || '?'));

console.log('\nprompt_process("I need to run a bash command to fix the filesystem"):');
const pp = await call('mikey_prompt_process', { prompt: 'I need to run a bash command to fix the filesystem' });
console.log('  matched:', pp.relevant_protocols.map(h => h.id).join(', ') || '(none)');
console.log('  directive:', pp.directive);

console.log('\ntriggers("should I do this or that, I am stuck deciding"):');
const tr = await call('mikey_protocol_triggers', { situation: 'should I do this or that, I am stuck deciding' });
console.log('  suggested:', tr.suggested.map(h => h.id).join(', ') || '(none)');

console.log('\nsearch("Ollama"):');
const s = await call('mikey_protocol_search', { query: 'reflect' });
console.log('  matches:', s.matches.map(m => m.id).join(', '));

console.log('\nread("prompt-processing") length:');
const r = await call('mikey_protocol_read', { id: 'prompt-processing' });
console.log('  chars:', r.content.length);

await c.close();
const pass = l.length === 7 && pp.relevant_protocols.length > 0 && r.content.length > 0;
console.log('\nRESULT:', pass ? 'PASS' : 'CHECK');
