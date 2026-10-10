import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Auth, APP_NAME, ISSUER, RESOURCE, validateIdToken, equal } from '../auth.mjs';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' }] };
const direct = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(claims, header = { alg: 'RS256', kid: 'test-key' }) {
  const unsigned = `${encode(header)}.${encode(claims)}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'image-blaster-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = Date.now();
  const config = { clientId: 'oaiapp-test-one', subject: 'subject-one', scope: direct, claims: {}, refreshError: 0, revokeError: 0 };
  const requests = [];
  let nonce;
  const fetcher = async (url, options = {}) => {
    requests.push({ url, options });
    const json = value => new Response(JSON.stringify(value), { status: 200 });
    if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` });
    if (url.endsWith('/jwks')) return json(jwks);
    if (url.endsWith('/revoke')) return new Response('', { status: config.revokeError || 200 });
    if (url === `${RESOURCE}/models`) return json({ models: [{ slug: 'visible-model', display_name: 'Visible model', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] });
    assert.equal(url, `${ISSUER}/api/accounts/oauth/token`);
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('resource'), RESOURCE);
    assert.equal(body.get('client_id'), config.clientId);
    if (body.get('grant_type') === 'refresh_token') {
      assert.equal(body.has('scope'), false);
      if (config.refreshError) return new Response('Do not leak provider details', { status: config.refreshError });
      return json({ access_token: 'refreshed-access-token', refresh_token: 'rotated-refresh-token', token_type: 'Bearer', expires_in: 3600 });
    }
    return json({ access_token: 'initial-access-token', refresh_token: 'initial-refresh-token', token_type: 'Bearer', expires_in: 3600, scope: config.scope,
      id_token: jwt({ iss: ISSUER, aud: config.clientId, sub: config.subject, exp: Math.floor(now / 1000) + 3600, nonce, email: 'same-email@example.test', ...config.claims }) });
  };
  const auth = new Auth(directory, { fetcher, now: () => now }); await auth.init();
  const begin = account => { const url = new URL(auth.begin('http://127.0.0.1:3210/auth/callback', account)); nonce = url.searchParams.get('nonce'); return url; };
  const complete = url => auth.complete(new URLSearchParams({ state: url.searchParams.get('state'), code: 'one-time-code', client_id: config.clientId }));
  return { auth, directory, config, requests, begin, complete, advance: ms => { now += ms; } };
}
test('first authorization has PKCE, stable host ID, resource, and no secret', async t => {
  const { auth, begin } = await setup(t); const url = begin();
  assert.equal(url.origin, ISSUER); assert.equal(url.pathname, '/api/accounts/authorize');
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), APP_NAME);
  assert.equal(url.searchParams.get('resource'), RESOURCE);
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(auth.pending.verifier).digest('base64url'));
  assert.match(url.searchParams.get('ext_agent_host_id'), /^urn:uuid:/);
  const again = begin(); assert.equal(again.searchParams.get('ext_agent_host_id'), url.searchParams.get('ext_agent_host_id'));
  assert.notEqual(again.searchParams.get('state'), url.searchParams.get('state'));
  assert.ok(!url.href.includes(auth.pending.verifier));
});
test('callback validates identity and keeps secrets out of public state', async t => {
  const { auth, begin, complete, directory } = await setup(t); await complete(begin());
  assert.equal(auth.publicState().accounts[0].planEnabled, true);
  assert.ok(!JSON.stringify(auth.publicState()).includes('initial-access-token'));
  if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, 'accounts.json'))).mode & 0o777, 0o600);
  const fresh = new Auth(directory); await fresh.init(); assert.equal(fresh.state.hostId, auth.state.hostId);
});
test('wrong state and duplicate callbacks cannot exchange a token', async t => {
  const { auth, begin, complete, requests } = await setup(t); const url = begin();
  await assert.rejects(auth.complete(new URLSearchParams({ state: 'wrong', code: 'bad' })), /state/);
  assert.equal(requests.length, 0); await complete(url);
  await assert.rejects(complete(url), /state/);
  assert.equal(requests.filter(r => r.url.endsWith('/oauth/token')).length, 1);
});
test('expired state is rejected', async t => {
  const { begin, complete, advance } = await setup(t); const url = begin(); advance(11 * 60_000); await assert.rejects(complete(url), /expired/);
});
test('authorization denial consumes state without creating an account', async t => {
  const { auth, begin, requests } = await setup(t); const url = begin();
  await assert.rejects(auth.complete(new URLSearchParams({ state: url.searchParams.get('state'), error: 'access_denied' })), /declined/);
  assert.equal(auth.pending, null); assert.equal(requests.length, 0); assert.equal(auth.state.accounts.length, 0);
});
test('returning account reuses registration but never trusts a different subject', async t => {
  const { auth, begin, complete, config } = await setup(t); await complete(begin());
  const account = auth.active(); const url = begin(account.id);
  assert.equal(url.searchParams.get('client_id'), account.clientId); assert.equal(url.searchParams.has('agent_name_hint'), false);
  config.subject = 'unexpected-account'; await assert.rejects(complete(url), /differs/);
  assert.equal(auth.active().subject, 'subject-one');
});
test('returning callback cannot substitute another client ID', async t => {
  const { auth, begin, complete } = await setup(t); await complete(begin()); const url = begin(auth.active().id);
  await assert.rejects(auth.complete(new URLSearchParams({ state: url.searchParams.get('state'), code: 'code', client_id: 'other-client' })), /registration mismatch/);
});
test('two registrations with the same email keep distinct credentials and labels', async t => {
  const { auth, begin, complete, config } = await setup(t); await complete(begin()); const first = auth.active();
  config.clientId = 'oaiapp-test-two'; config.subject = 'subject-two'; await complete(begin());
  assert.equal(auth.state.accounts.length, 2); assert.notEqual(auth.active().id, first.id);
  assert.notEqual(auth.active().label, first.label); assert.equal(auth.active().email, first.email);
});
test('identity-only authorization does not grant inference', async t => {
  const { auth, config, begin, complete } = await setup(t); config.scope = 'openid profile email'; await complete(begin());
  assert.equal(auth.publicState().accounts[0].planEnabled, false); await assert.rejects(auth.access(), /permission/);
});
test('refreshes are serialized and rotated refresh tokens are stored', async t => {
  const { auth, begin, complete, advance, requests } = await setup(t); await complete(begin()); advance(3_550_000);
  const tokens = await Promise.all(Array.from({ length: 8 }, () => auth.access()));
  assert.ok(tokens.every(t => t.token === 'refreshed-access-token')); assert.equal(auth.active().refreshToken, 'rotated-refresh-token');
  assert.equal(requests.filter(r => r.options.body?.includes('grant_type=refresh_token')).length, 1);
});
test('invalid refresh clears credentials, but not the registration', async t => {
  const { auth, config, begin, complete, advance } = await setup(t); await complete(begin()); config.refreshError = 400; advance(3_550_000);
  await assert.rejects(auth.access(), /HTTP 400/); assert.equal(auth.active().accessToken, undefined); assert.equal(auth.active().clientId, config.clientId);
});
test('models use the OAuth catalog, filtering hidden entries in source order', async t => {
  const { auth, begin, complete } = await setup(t); await complete(begin()); assert.deepEqual(await auth.models(), [{ id: 'visible-model', name: 'Visible model' }]);
});
test('logout revokes the renewable session and retains nonsecret account mapping', async t => {
  const { auth, begin, complete, requests, directory } = await setup(t); await complete(begin()); const id = auth.active().clientId;
  assert.deepEqual(await auth.logout(), { revoked: true });
  assert.equal(auth.state.active, null); assert.equal(auth.state.accounts[0].clientId, id);
  assert.equal(auth.secrets().length, 0); assert.equal(requests.filter(r => r.url.endsWith('/revoke')).length, 1);
  assert.ok(!(await readFile(path.join(directory, 'accounts.json'), 'utf8')).includes('initial-access-token'));
});
test('failed remote revocation still clears local credentials and reports uncertainty', async t => {
  const { auth, config, begin, complete } = await setup(t); await complete(begin()); config.revokeError = 503;
  assert.deepEqual(await auth.logout(), { revoked: false }); assert.equal(auth.state.active, null); assert.equal(auth.secrets().length, 0);
});
test('redirect validation rejects other hosts, credentials, and paths', async t => {
  const { auth } = await setup(t);
  for (const uri of ['http://localhost:3210/auth/callback', 'http://evil.test/auth/callback', 'http://user@127.0.0.1/auth/callback', 'http://127.0.0.1/other']) assert.throws(() => auth.begin(uri), /OAuth/);
});
const baseClaims = { iss: ISSUER, aud: 'client', sub: 'subject', exp: Math.floor(Date.now() / 1000) + 3600, nonce: 'nonce' };
for (const [name, update] of Object.entries({ issuer: { iss: 'https://evil.test' }, audience: { aud: 'other' }, expiry: { exp: 0 }, nonce: { nonce: 'other' }, authorizedParty: { aud: ['client', 'other'], azp: 'other' } })) {
  test(`ID-token ${name} mismatch is rejected`, () => assert.throws(() => validateIdToken(jwt({ ...baseClaims, ...update }), jwks, { clientId: 'client', nonce: 'nonce' })));
}
test('ID-token signature tampering and unsupported algorithms are rejected', () => {
  const token = jwt(baseClaims); const parts = token.split('.'); parts[1] = encode({ ...baseClaims, sub: 'intruder' });
  assert.throws(() => validateIdToken(parts.join('.'), jwks, { clientId: 'client', nonce: 'nonce' }), /signature/);
  assert.throws(() => validateIdToken(jwt(baseClaims, { alg: 'HS256', kid: 'test-key' }), jwks, { clientId: 'client' }), /algorithm/);
  assert.equal(equal(undefined, 'anything'), false); assert.equal(equal('same', 'same'), true);
});
