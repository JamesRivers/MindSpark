// The self-hosted cloud server is deliberately tiny, but three of its choices
// are load-bearing and easy to "fix" into breakage:
//   - /healthz must be 404, or the client switches to SQLite mode and hides
//     GitHub sign-in;
//   - /config.js must carry the deployment's OAuth origin and repo;
//   - index.html must load config.js before app.js.
// This boots the real server (no mocks) and pins those contracts.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18100 + Math.floor(Math.random() * 700);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status) return r;
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

before(async () => {
  child = spawn(process.execPath, [join(ROOT, 'selfhost', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      APP_ORIGIN: 'https://maps.example.com',
      GITHUB_CLIENT_ID: 'client-id',
      GITHUB_CLIENT_SECRET: 'client-secret',
      DEFAULT_REPO: 'acme/mindspark-maps',
      ALLOWED_GITHUB_LOGINS: 'alice,bob'
    },
    stdio: 'ignore'
  });
  await waitFor(`${BASE}/status`);
});

after(() => { try { child.kill('SIGTERM'); } catch {} });

describe('selfhost server', () => {
  test('/healthz is 404 so the client selects GitHub-backed storage', async () => {
    const r = await fetch(`${BASE}/healthz`);
    assert.equal(r.status, 404);
  });

  test('/status reports cloud mode and never leaks the secret', async () => {
    const r = await fetch(`${BASE}/status`);
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.equal(j.mode, 'selfhost-cloud');
    assert.equal(j.storage, 'github-repo');
    assert.equal(j.oauth, true);
    assert.equal(j.repo, 'acme/mindspark-maps');
    assert.equal(j.allowlist, true);
    assert.equal(JSON.stringify(j).includes('client-secret'), false);
  });

  test('/config.js points OAuth and maps at this deployment', async () => {
    const text = await (await fetch(`${BASE}/config.js`)).text();
    const json = JSON.parse(text.replace(/^window\.MINDSPARK_CONFIG=/, '').replace(/;\s*$/, ''));
    assert.equal(json.defaultRepo, 'acme/mindspark-maps');
    assert.equal(json.collab, false);
    assert.deepEqual(json.oauth, {
      clientId: 'client-id',
      workerUrl: 'https://maps.example.com',
      appOrigin: 'https://maps.example.com'
    });
  });

  test('index.html loads config.js before app.js', async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    const cfg = html.indexOf('<script src="./config.js"></script>');
    const app = html.indexOf('<script src="./app.js"');
    assert.ok(cfg !== -1, 'config script tag injected');
    assert.ok(app !== -1, 'app script tag present');
    assert.ok(cfg < app, 'config runs before the app');
  });

  test('a callback without a code renders the failure page, not a token', async () => {
    const r = await fetch(`${BASE}/callback`);
    assert.equal(r.status, 400);
    const html = await r.text();
    assert.match(html, /missing_code/);
    assert.equal(html.includes('access_token'), false);
  });

  test('path traversal cannot escape public/', async () => {
    const r = await fetch(`${BASE}/..%2fselfhost%2fserver.js`);
    assert.ok(r.status === 403 || r.status === 404);
    const body = await r.text();
    assert.equal(body.includes('GITHUB_CLIENT_SECRET'), false);
  });
});
