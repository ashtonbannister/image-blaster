import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const APP_NAME = 'image_blaster';
export const ISSUER = 'https://auth.openai.com';
export const RESOURCE = 'https://api.openai.com/v1';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const DIRECT = 'chatgpt.tokens.use.direct';
export const opaque = () => randomBytes(32).toString('base64url');
export const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
}

export async function loadJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

// Fetch only fixed/pinned provider endpoints. Never include response bodies in errors.
export async function providerJson(fetcher, url, options = {}) {
  const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) {
    const error = new Error(`Provider request failed (HTTP ${response.status}). Reconnect your account or check Manage usage.`);
    error.status = response.status;
    throw error;
  }
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('Provider response is too large.');
  return JSON.parse(text);
}

function secureAuthUrl(value) {
  const url = new URL(value);
  if (url.origin !== ISSUER || url.username || url.password) throw new Error('Untrusted OpenID endpoint.');
  return url.href;
}

export function validateIdToken(token, jwks, { clientId, nonce, subject, now = Date.now() }) {
  if (typeof token !== 'string' || token.length > 50_000) throw new Error('Missing or oversized ID token.');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error('Invalid ID token.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (header.alg !== 'RS256' || header.crit) throw new Error('Unsupported ID-token signing algorithm.');
  const keys = (jwks.keys || []).filter(k => k.kid === header.kid && k.kty === 'RSA' &&
    (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
  if (keys.length !== 1) throw new Error('ID-token signing key not found.');
  const key = createPublicKey({ key: keys[0], format: 'jwk' });
  if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) {
    throw new Error('ID-token signature verification failed.');
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ISSUER || !audience.includes(clientId) ||
      (audience.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId) ||
      !Number.isFinite(claims.exp) || claims.exp * 1000 <= now ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > now + 30_000)) ||
      typeof claims.sub !== 'string' || !claims.sub) throw new Error('Invalid ID-token identity or expiry.');
  if (nonce !== undefined && !equal(claims.nonce, nonce)) throw new Error('ID-token nonce mismatch.');
  if (subject && claims.sub !== subject) throw new Error('The returned account differs from the selected account.');
  return claims;
}

export class Auth {
  constructor(directory, { fetcher = fetch, now = Date.now } = {}) {
    this.directory = directory;
    this.file = path.join(directory, 'accounts.json');
    this.fetcher = fetcher;
    this.now = now;
    this.pending = null;
    this.queue = Promise.resolve();
  }
  async init() {
    this.state = await loadJson(this.file, { version: 1, hostId: `urn:uuid:${randomUUID()}`, active: null, accounts: [] });
    if (this.state.version !== 1 || !Array.isArray(this.state.accounts) || !this.state.hostId) throw new Error('Invalid account store.');
    await this.save();
  }
  save() { return saveJson(this.file, this.state); }
  serial(fn) {
    const operation = this.queue.then(fn);
    this.queue = operation.catch(() => {});
    return operation;
  }
  active() { return this.state.accounts.find(a => a.id === this.state.active); }
  publicState() {
    return { active: this.state.active, accounts: this.state.accounts.map(a => ({
      id: a.id, label: a.label, email: a.email, connected: Boolean(a.accessToken),
      planEnabled: Boolean(a.accessToken && a.scopes.includes(DIRECT)), welcomed: Boolean(a.welcomed),
    })) };
  }
  secrets() { return [...this.state.accounts.flatMap(a => [a.accessToken, a.refreshToken, a.idToken]), process.env.FAL_KEY, process.env.WORLD_LABS_API_KEY].filter(Boolean); }
  async discovery() {
    const config = await providerJson(this.fetcher, `${ISSUER}/.well-known/openid-configuration`);
    if (config.issuer !== ISSUER) throw new Error('Unexpected OpenID issuer.');
    secureAuthUrl(config.jwks_uri);
    if (config.revocation_endpoint) secureAuthUrl(config.revocation_endpoint);
    return config;
  }
  async claims(token, validation) {
    const config = await this.discovery();
    const jwks = await providerJson(this.fetcher, config.jwks_uri);
    return validateIdToken(token, jwks, { ...validation, now: this.now() });
  }
  begin(redirectUri, accountId = null) {
    const callback = new URL(redirectUri);
    if (callback.username || callback.password || callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.pathname !== '/auth/callback' || callback.search || callback.hash) {
      throw new Error('OAuth requires an HTTP 127.0.0.1 /auth/callback listener.');
    }
    const account = accountId ? this.state.accounts.find(a => a.id === accountId) : null;
    if (accountId && !account) throw new Error('Unknown account registration.');
    const verifier = opaque();
    this.pending = { state: opaque(), nonce: opaque(), verifier, redirectUri,
      accountId, clientId: account?.clientId, expiresAt: this.now() + 10 * 60_000 };
    const url = new URL(AUTHORIZE);
    url.search = new URLSearchParams({ client_id: account?.clientId || 'dynamic_agent_client',
      ext_agent_host_id: this.state.hostId, response_type: 'code', redirect_uri: redirectUri,
      scope: SCOPE, resource: RESOURCE, state: this.pending.state, nonce: this.pending.nonce,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    if (!account) url.searchParams.set('agent_name_hint', APP_NAME);
    // Omit optional id_token_hint so ID tokens never pass through the renderer.
    if (account?.email) url.searchParams.set('login_hint', account.email);
    return url.href;
  }
  exchange(parameters) {
    return providerJson(this.fetcher, TOKEN, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...parameters, resource: RESOURCE }).toString() });
  }
  tokenFields(tokens, previous = null) {
    if (typeof tokens.access_token !== 'string' || !tokens.access_token ||
        tokens.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
      throw new Error('Invalid OAuth token response.');
    }
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
    if (!scopes) throw new Error('OAuth response did not include granted scopes.');
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || previous?.refreshToken,
      idToken: tokens.id_token || previous?.idToken, expiresAt: this.now() + tokens.expires_in * 1000, scopes };
  }
  complete(parameters) {
    return this.serial(async () => {
      const attempt = this.pending;
      if (!attempt || attempt.expiresAt <= this.now() || !equal(parameters.get('state'), attempt.state)) {
        throw new Error('Invalid or expired sign-in state. Start sign-in again.');
      }
      this.pending = null; // Single use, including denied/failed callbacks.
      if (parameters.has('error')) throw new Error('Sign-in was declined or cancelled. No account was changed.');
      const returnedId = parameters.get('client_id');
      const clientId = attempt.clientId || returnedId;
      if (!clientId || clientId === 'dynamic_agent_client' || (attempt.clientId && returnedId && returnedId !== attempt.clientId)) {
        throw new Error('OAuth client registration mismatch.');
      }
      const code = parameters.get('code');
      if (!code) throw new Error('No authorization code was returned.');
      const old = this.state.accounts.find(a => a.id === attempt.accountId);
      const tokens = await this.exchange({ grant_type: 'authorization_code', client_id: clientId,
        code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri });
      const claims = await this.claims(tokens.id_token, { clientId, nonce: attempt.nonce, subject: old?.subject });
      const fields = this.tokenFields(tokens);
      const existing = old || this.state.accounts.find(a => a.clientId === clientId);
      if (existing && existing.subject !== claims.sub) throw new Error('Stored registration identity mismatch.');
      const account = { ...existing, id: existing?.id || randomUUID(), clientId, subject: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : '',
        label: existing?.label || `Account ${this.state.accounts.length + 1}`, ...fields };
      this.state.accounts = this.state.accounts.filter(a => a.id !== account.id).concat(account);
      this.state.active = account.id;
      await this.save();
      return this.publicState();
    });
  }
  access() {
    return this.serial(async () => {
      const account = this.active();
      if (!account?.accessToken) throw new Error('Continue with ChatGPT before starting a request.');
      if (!account.scopes.includes(DIRECT)) throw new Error('ChatGPT plan permission is not enabled. Reconnect and enable it.');
      if (account.expiresAt <= this.now() + 60_000) {
        if (!account.refreshToken) throw new Error('Session expired. Continue with ChatGPT again.');
        let tokens;
        try { tokens = await this.exchange({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refreshToken }); }
        catch (error) {
          if (error.status === 400 || error.status === 401) {
            delete account.accessToken; delete account.refreshToken; delete account.idToken;
            await this.save();
          }
          throw error;
        }
        if (tokens.id_token) await this.claims(tokens.id_token, { clientId: account.clientId, subject: account.subject });
        Object.assign(account, this.tokenFields(tokens, account));
        await this.save();
        if (!account.scopes.includes(DIRECT)) throw new Error('ChatGPT plan permission was removed.');
      }
      return { token: account.accessToken, accountId: account.id, expiresAt: account.expiresAt };
    });
  }
  async models() {
    const { token } = await this.access();
    const response = await providerJson(this.fetcher, `${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!Array.isArray(response.models)) throw new Error('Unexpected ChatGPT model catalog. Reconnect or update the integration.');
    return response.models.filter(m => m.visibility === 'list' && typeof m.slug === 'string')
      .map(m => ({ id: m.slug, name: m.display_name || m.slug }));
  }
  welcome() { return this.serial(async () => { const a = this.active(); if (a) { a.welcomed = true; await this.save(); } }); }
  logout() {
    this.pending = null;
    return this.serial(async () => {
      const account = this.active();
      if (!account) return { revoked: true };
      let revoked = !account.refreshToken;
      if (account.refreshToken) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const config = await this.discovery();
            if (!config.revocation_endpoint) break;
            const response = await this.fetcher(secureAuthUrl(config.revocation_endpoint), {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token: account.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }).toString(),
            });
            revoked = response.status === 200;
            if (revoked || response.status < 500) break;
          } catch { /* Clear locally even if remote revocation is unavailable. */ }
          if (!attempt) await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      delete account.accessToken; delete account.refreshToken; delete account.idToken;
      this.state.active = null;
      await this.save();
      return { revoked };
    });
  }
}
