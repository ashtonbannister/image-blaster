import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { makeServer, acquireLock, imageExtension } from '../server.mjs';
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'image-blaster-http-'));
  const agent = new EventEmitter(); agent.busy = false;
  agent.publicState = () => ({ busy: agent.busy, events: [], approvals: [] });
  agent.close = () => { agent.busy = false; }; agent.clearView = () => {};
  agent.start = async params => { agent.lastTurn = params; agent.busy = true; return { threadId: 'test-thread' }; };
  agent.interrupt = async () => { agent.busy = false; }; agent.approve = () => {};
  const auth = { pending: null, state: { active: 'test-account' }, publicState: () => ({ active: 'test-account', accounts: [{ id: 'test-account', planEnabled: true }] }), secrets: () => ['never-show-this-token'],
    models: async () => [{ id: 'test-model', name: 'Test model' }], welcome: async () => {}, logout: async () => ({ revoked: true }),
    begin: uri => { auth.pending = {}; return `https://auth.openai.com/api/accounts/authorize?redirect_uri=${encodeURIComponent(uri)}`; },
    complete: async () => { throw new Error('Invalid or expired sign-in state.'); } };
  const app = makeServer({ root, auth, agent }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { app.close(); await rm(root, { recursive: true, force: true }); });
  const request = (route, body, headers = {}) => fetch(`${url}${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-image-blaster-token': app.csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { app, root, url, request, auth, agent };
}
test('local page serves security headers and injects only the local control token', async t => {
  const { url, app } = await setup(t); const response = await fetch(url); const html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /Image Blaster/); assert.ok(html.includes(app.csrf)); assert.ok(!html.includes('never-show-this-token'));
  assert.equal(response.headers.get('x-frame-options'), 'DENY'); assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
test('API requires local request token', async t => { const { url } = await setup(t); assert.equal((await fetch(`${url}/api/status`)).status, 403); });
test('cross-origin requests are rejected even with a control token', async t => {
  const { request } = await setup(t); assert.equal((await request('/api/status', undefined, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await request('/api/status', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
});
test('Host rebinding is rejected', async t => {
  const { url, app } = await setup(t);
  // fetch normalizes Host, so use the raw HTTP transport to exercise a forged Host.
  const code = await new Promise((resolve, reject) => {
    const req = httpRequest(`${url}/api/status`, { headers: { Host: 'evil.test', 'x-image-blaster-token': app.csrf } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(code, 403);
});
test('server never exposes .env, auth store, or arbitrary repository files', async t => {
  const { url } = await setup(t); for (const route of ['/.env', '/auth.mjs', '/accounts.json', '/package.json', '/input/test.png']) assert.equal((await fetch(`${url}${route}`)).status, 404);
});
test('OAuth callback without matching state does not sign in', async t => { const { url } = await setup(t); const response = await fetch(`${url}/auth/callback?code=spoof&state=spoof`); assert.equal(response.status, 400); assert.match(await response.text(), /state/); });
test('a turn requires an account-bound catalog and validated world/images', async t => {
  const { request, agent } = await setup(t); const body = { world: 'garage', model: 'test-model', text: 'Analyze only', images: [] };
  assert.equal((await request('/api/turn', body)).status, 400); await request('/api/models');
  assert.equal((await request('/api/turn', { ...body, world: '../outside' })).status, 400);
  assert.equal((await request('/api/turn', { ...body, model: 'unlisted' })).status, 400);
  assert.equal((await request('/api/turn', { ...body, images: ['../../secret'] })).status, 400);
  assert.equal((await request('/api/turn', body)).status, 200); assert.equal(agent.lastTurn.text, body.text);
});
test('valid images use server-selected local filenames; active content is rejected', async t => {
  const { root, url, app, request, agent } = await setup(t);
  const upload = bytes => fetch(`${url}/api/upload`, { method: 'POST', headers: { 'x-image-blaster-token': app.csrf, 'Content-Type': 'application/octet-stream' }, body: bytes });
  assert.equal((await upload('<svg onload="alert(1)"></svg>')).status, 400);
  const response = await upload(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); assert.equal(response.status, 201); const { id } = await response.json();
  assert.match(id, /^upload-[\da-f-]+\.png$/); await request('/api/models');
  assert.equal((await request('/api/turn', { world: 'garage', model: 'test-model', text: 'Analyze', images: [id] })).status, 200);
  assert.equal(agent.lastTurn.images[0], path.join(root, 'input', id));
});
test('upload cannot escape a symlinked input directory', async t => {
  if (process.platform === 'win32') return t.skip('Symlink creation may require elevated Windows privileges');
  const { root, url, app } = await setup(t); const outside = path.join(root, 'other'); await mkdir(outside); await symlink(outside, path.join(root, 'input'));
  const result = await fetch(`${url}/api/upload`, { method: 'POST', headers: { 'x-image-blaster-token': app.csrf }, body: Buffer.from([255, 216, 255]) }); assert.equal(result.status, 400);
});
test('account changes are blocked while the agent is busy', async t => { const { request, agent } = await setup(t); agent.busy = true; assert.equal((await request('/api/login', {})).status, 409); });
test('pending login is visible and cancellable', async t => {
  const { request } = await setup(t); await request('/api/login', {});
  assert.equal((await (await request('/api/status')).json()).pendingLogin, true); await request('/api/login/cancel', {});
  assert.equal((await (await request('/api/status')).json()).pendingLogin, false);
});
test('runtime lock prevents competing refresh writers for the same checkout', async t => {
  const { root } = await setup(t); const unlock = await acquireLock(path.join(root, 'private'));
  await assert.rejects(acquireLock(path.join(root, 'private')), /already running/); await unlock(); const second = await acquireLock(path.join(root, 'private')); await second();
});
test('image signatures are recognized without trusting extensions', () => { assert.equal(imageExtension(Buffer.from([255, 216, 255])), 'jpg'); assert.equal(imageExtension(Buffer.from('RIFFabcdWEBP')), 'webp'); assert.throws(() => imageExtension(Buffer.from('image.png'))); });
