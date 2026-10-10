import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Auth, equal, opaque } from './auth.mjs';
import { Agent, redact } from './codex.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(HERE);
const MIME = { '/': 'text/html; charset=utf-8', '/ui.mjs': 'text/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8' };
const FILES = { '/': 'index.html', '/ui.mjs': 'ui.mjs', '/style.css': 'style.css' };

export async function readBody(request, limit = 100_000) {
  const chunks = []; let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

export function imageExtension(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'jpg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('Use a PNG, JPEG, or WebP image.');
}

export async function acquireLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'runtime.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid)); await handle.close();
      return async () => { await unlink(file).catch(() => {}); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(await readFile(file, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid runtime lock. Inspect ${file} before removing it.`);
      try { process.kill(pid, 0); }
      catch (probe) { if (probe.code === 'ESRCH') { await unlink(file); continue; } throw probe; }
      throw new Error('Image Blaster is already running for this checkout.');
    }
  }
  throw new Error('Could not acquire the runtime lock.');
}

export function makeServer({ root, auth, agent, viewerPort = 5173, viewerAvailable = false }) {
  const csrf = opaque();
  const streams = new Set();
  const uploads = new Map();
  let origin = '';
  let models = [];
  let modelAccount = null;
  let operation = false;
  const protectedOperation = async fn => {
    if (operation) throw Object.assign(new Error('Another operation is in progress.'), { status: 409 });
    operation = true;
    try { return await fn(); } finally { operation = false; }
  };
  const idle = () => { if (agent.busy) throw Object.assign(new Error('Stop the current turn before changing accounts.'), { status: 409 }); };
  const status = () => ({ auth: auth.publicState(), agent: agent.publicState(), viewerAvailable, pendingLogin: Boolean(auth.pending),
    providers: { worldLabs: Boolean(process.env.WORLD_LABS_API_KEY && !process.env.WORLD_LABS_API_KEY.startsWith('your_')),
      fal: Boolean(process.env.FAL_KEY && !process.env.FAL_KEY.startsWith('your_')) } });
  const clearAccountView = () => { models = []; modelAccount = null; agent.close(); agent.clearView(); };
  const update = event => {
    for (const res of streams) {
      if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) { streams.delete(res); res.end(); }
    }
  };
  agent.on('update', update);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-src http://127.0.0.1:${viewerPort}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`);
    try {
      // Exact Host + peer + Origin checks prevent DNS rebinding and cross-origin control.
      if (req.headers.host !== new URL(origin).host || !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress)) {
        return json(res, 403, { error: 'Loopback access only. Open the printed 127.0.0.1 URL.' });
      }
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/auth/callback') {
        await protectedOperation(async () => { idle(); await auth.complete(url.searchParams); clearAccountView(); });
        res.writeHead(303, { Location: '/?connected=1' }); res.end(); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site' ||
            !equal(req.headers['x-image-blaster-token'], csrf)) return json(res, 403, { error: 'Request authorization failed.' });
        if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, status());
        if (req.method === 'GET' && url.pathname === '/api/events') {
          if (streams.size >= 8) return json(res, 429, { error: 'Too many event streams.' });
          res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
          res.write(`data: ${JSON.stringify({ type: 'snapshot', value: agent.publicState() })}\n\n`);
          streams.add(res);
          const heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.end(); }, 15_000);
          res.on('close', () => { streams.delete(res); clearInterval(heartbeat); });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/models') {
          const data = await protectedOperation(async () => { idle(); models = await auth.models(); modelAccount = auth.state.active; return models; });
          return json(res, 200, data);
        }
        if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
        if (url.pathname === '/api/upload') {
          if (uploads.size >= 100) throw new Error('Upload limit reached. Restart the local app to add more images.');
          const bytes = await readBody(req, 20 * 1024 * 1024);
          const extension = imageExtension(bytes);
          const directory = path.join(root, 'input');
          await mkdir(directory, { recursive: true });
          if (await realpath(directory) !== path.join(await realpath(root), 'input')) throw new Error('The input directory must not be a symlink.');
          const id = `upload-${randomUUID()}.${extension}`;
          const target = path.join(directory, id);
          await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
          uploads.set(id, target);
          return json(res, 201, { id, name: id });
        }
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'JSON is required.' });
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        if (url.pathname === '/api/login') {
          const value = await protectedOperation(async () => { idle(); return { url: auth.begin(`${origin}/auth/callback`, body.accountId || null) }; });
          return json(res, 200, value);
        }
        if (url.pathname === '/api/login/cancel') { await protectedOperation(async () => { auth.pending = null; }); return json(res, 200, {}); }
        if (url.pathname === '/api/logout') {
          const result = await protectedOperation(async () => { clearAccountView(); return await auth.logout(); });
          return json(res, 200, result);
        }
        if (url.pathname === '/api/welcome') { await auth.welcome(); return json(res, 200, {}); }
        if (url.pathname === '/api/stop') { await agent.interrupt(); return json(res, 200, {}); }
        if (url.pathname === '/api/approval') { agent.approve(body.id, body.decision); return json(res, 200, {}); }
        if (url.pathname === '/api/turn') {
          const result = await protectedOperation(async () => {
            if (auth.pending) throw new Error('Complete or cancel the pending sign-in first.');
            if (!body || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 30_000) throw new Error('Enter a prompt of 1–30,000 characters.');
            if (typeof body.world !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(body.world)) throw new Error('World name must use lowercase letters, numbers, and hyphens.');
            if (modelAccount !== auth.state.active || !models.some(m => m.id === body.model)) throw new Error('Refresh the model catalog and select an available model.');
            if (!Array.isArray(body.images) || body.images.length > 8) throw new Error('Attach at most eight images per turn.');
            const images = [];
            for (const id of body.images) {
              const file = uploads.get(id);
              if (!file || !(await lstat(file)).isFile() || (await realpath(file)) !== file) throw new Error('An attached image is missing, moved, or invalid. Attach it again.');
              images.push(file);
            }
            return await agent.start({ ...body, text: body.text.trim(), images, fresh: body.fresh === true });
          });
          return json(res, 200, result);
        }
        return json(res, 404, { error: 'Unknown API route.' });
      }
      if (req.method !== 'GET' || !FILES[url.pathname]) return json(res, 404, { error: 'Not found.' });
      let content = await readFile(path.join(HERE, FILES[url.pathname]), 'utf8');
      if (url.pathname === '/') content = content.replaceAll('@@CSRF@@', csrf).replaceAll('@@VIEWER@@', `http://127.0.0.1:${viewerPort}`);
      res.writeHead(200, { 'Content-Type': MIME[url.pathname] }); res.end(content);
    } catch (error) {
      const text = redact(error.message || 'Request failed.', auth.secrets());
      if (!res.headersSent) json(res, error.status && error.status >= 400 && error.status <= 599 ? error.status : 400, { error: text });
      else res.end();
    }
  });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000;
  server.on('listening', () => { origin = `http://127.0.0.1:${server.address().port}`; });
  server.on('close', () => { agent.off('update', update); });
  return { server, csrf, status, close: () => { agent.close(); for (const res of streams) res.end(); server.closeAllConnections(); server.close(); } };
}

async function main() {
  if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
  const directory = path.join(homedir(), '.image-blaster', createHash('sha256').update(ROOT).digest('hex').slice(0, 16));
  const unlock = await acquireLock(directory);
  let app; let viewer;
  try {
    const port = Number(process.env.IMAGE_BLASTER_PORT || 3210);
    const viewerPort = Number(process.env.IMAGE_BLASTER_VIEWER_PORT || 5173);
    for (const p of [port, viewerPort]) if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Choose a port from 1024 to 65535.');
    if (port === viewerPort) throw new Error('The control panel and viewer need different ports.');
    const auth = new Auth(directory); await auth.init();
    const agent = new Agent({ root: ROOT, directory, auth }); await agent.init();
    const vite = [path.join(ROOT, 'node_modules/vite/bin/vite.js'), path.join(ROOT, 'app/node_modules/vite/bin/vite.js')].find(existsSync);
    const viewerAvailable = Boolean(vite && process.env.IMAGE_BLASTER_NO_VIEWER !== '1');
    app = makeServer({ root: ROOT, auth, agent, viewerPort, viewerAvailable });
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(port, '127.0.0.1', resolve); });
    if (viewerAvailable) {
      viewer = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(viewerPort), '--strictPort'], {
        cwd: path.join(ROOT, 'app'), stdio: 'inherit', shell: false,
      });
      viewer.on('error', () => console.error('Viewer could not start. Run npm install in app/ and restart.'));
      viewer.on('exit', code => { if (code) console.error('Viewer stopped. Check its terminal output and port availability.'); });
    }
    console.log(`Image Blaster: http://127.0.0.1:${port}`);
    console.log('Local-only. ChatGPT tokens stay outside the repository. World Labs and FAL are billed separately.');
    if (!viewerAvailable) console.log('Viewer not started. Install the existing app dependencies, then restart (or use the viewer separately).');
    let exiting = false;
    const stop = async () => { if (exiting) return; exiting = true; app.close(); viewer?.kill(); await unlock(); };
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
  } catch (error) { app?.close(); viewer?.kill(); await unlock(); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
