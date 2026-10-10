import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent, appServerArgs, redact } from '../codex.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'image-blaster-agent-')); const root = path.join(directory, 'project');
  let token = 'oauth-secret-test-token'; const children = [], calls = [];
  const auth = { secrets: () => [token], access: async () => ({ token, accountId: 'account-1' }) };
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    child.send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const message = JSON.parse(chunk.toString()); calls.push(message);
      if (message.method === 'initialize') setImmediate(() => child.send({ id: message.id, result: {} }));
      if (['thread/start', 'thread/resume'].includes(message.method)) setImmediate(() => child.send({ id: message.id, result: { thread: { id: 'thread-1' } } }));
      if (message.method === 'turn/start') setImmediate(() => child.send({ id: message.id, result: { turn: { id: 'turn-1' } } }));
      if (message.method === 'turn/interrupt') setImmediate(() => { child.send({ id: message.id, result: {} }); child.send({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } }); });
      done();
    } });
    child.kill = () => { child.exitCode = 0; setImmediate(() => child.emit('exit', 0)); return true; };
    children.push({ child, command, args, options }); return child;
  };
  const agent = new Agent({ root, directory, auth, spawnProcess }); await agent.init();
  t.after(async () => { agent.close(false); await rm(directory, { recursive: true, force: true }); });
  const start = () => agent.start({ world: 'garage', model: 'catalog-model', text: 'Analyze only', images: [path.join(root, 'input/test.png')] });
  return { agent, calls, children, auth, start, rotate: () => { token = 'rotated-oauth-token'; } };
}
test('configured provider uses Responses OAuth without legacy Codex login', () => {
  const args = appServerArgs(); assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
  assert.ok(args.includes('model_providers.openai_chatgpt_plan.requires_openai_auth=false'));
  assert.ok(args.includes('model_providers.openai_chatgpt_plan.supports_websockets=false'));
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'));
});
test('handshake precedes thread and turn; secret is passed through env, never args', async t => {
  const { agent, start, calls, children } = await setup(t); await start();
  assert.deepEqual(calls.map(c => c.method), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.equal(calls[0].params.clientInfo.name, 'image_blaster');
  assert.equal(calls[2].params.approvalPolicy, 'untrusted');
  assert.equal(calls[3].params.input[1].type, 'skill'); assert.equal(calls[3].params.input[2].type, 'localImage');
  assert.equal(children[0].options.env.ACCESS_TOKEN, 'oauth-secret-test-token');
  assert.ok(!JSON.stringify(children[0].args).includes('oauth-secret-test-token')); assert.ok(children[0].options.env.CODEX_HOME.endsWith('codex/account-1'));
  assert.equal(agent.busy, true);
});
test('concurrent turns are rejected', async t => { const { agent, start } = await setup(t); await start(); await assert.rejects(start(), /already running/); assert.equal(agent.busy, true); });
test('approvals require explicit one-time response and cannot be replayed', async t => {
  const { agent, start, children, calls } = await setup(t); await start();
  children[0].child.send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { command: 'node generate.mjs' } });
  assert.equal(agent.approvals.size, 1); assert.ok(!calls.some(c => c.id === 'approval-1'));
  assert.throws(() => agent.approve('approval-1', 'acceptForSession'), /one-time/);
  agent.approve('approval-1', 'decline'); assert.deepEqual(calls.at(-1), { id: 'approval-1', result: { decision: 'decline' } });
  assert.throws(() => agent.approve('approval-1', 'accept'), /expired/);
});
test('unknown permission requests fail closed', async t => {
  const { start, children, calls } = await setup(t); await start(); children[0].child.send({ id: 900, method: 'future/permissions', params: {} });
  assert.equal(calls.at(-1).id, 900); assert.equal(calls.at(-1).error.code, -32601);
});
test('streaming is redacted and failed turns are never marked completed', async t => {
  const { agent, start, children } = await setup(t); await start(); const c = children[0].child;
  c.send({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'do not leak oauth-secret-test-token' } });
  c.send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'Not available' } } } });
  assert.equal(agent.busy, false); assert.equal(agent.events.at(-1).value.status, 'failed'); assert.ok(!JSON.stringify(agent.publicState()).includes('oauth-secret-test-token'));
});
test('interrupt observes the terminal interrupted state', async t => {
  const { agent, start } = await setup(t); await start(); await agent.interrupt(); await tick();
  assert.equal(agent.busy, false); assert.equal(agent.events.at(-1).value.status, 'interrupted');
});
test('stop during token lookup cannot start a late turn', async t => {
  const { agent, auth, children, start } = await setup(t); let release;
  auth.access = () => new Promise(resolve => { release = resolve; });
  const pending = start(); await agent.interrupt(); release({ token: 'late-token', accountId: 'account-1' });
  await assert.rejects(pending, /interrupted/); assert.equal(children.length, 0); assert.equal(agent.busy, false);
});
test('token rotation restarts app-server and resumes saved world thread', async t => {
  const { agent, start, rotate, children, calls } = await setup(t); await start();
  children[0].child.send({ method: 'turn/completed', params: { turn: { status: 'completed' } } }); rotate(); await start();
  assert.equal(children.length, 2); assert.ok(calls.some(c => c.method === 'thread/resume'));
  assert.equal(children[1].options.env.ACCESS_TOKEN, 'rotated-oauth-token'); assert.equal(agent.busy, true);
});
test('malformed protocol and unexpected process exit fail instead of hanging', async t => {
  const { agent, start, children } = await setup(t); await start(); children[0].child.stdout.write('not-json\n');
  assert.equal(agent.busy, false); assert.equal(agent.events.at(-1).value.status, 'failed');
  await start(); children[1].child.emit('exit', 1); assert.equal(agent.busy, false); assert.match(agent.events.at(-1).value.error, /exited/);
});
test('redactor removes bearer and structured credentials', () => {
  assert.equal(redact('Bearer secret-value'), 'Bearer [REDACTED]');
  const value = JSON.parse(redact(JSON.stringify({ access_token: 'secret-value' })));
  assert.equal(value.access_token, '[REDACTED]');
});
