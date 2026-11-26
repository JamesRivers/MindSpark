/**
 * MindSpark - self-hosted cloud mode.
 *
 * Serves the static app and performs the one thing a browser cannot do alone:
 * the GitHub OAuth code -> access-token exchange (it needs the OAuth App
 * client_secret). Maps are NOT stored here. After sign-in the browser talks
 * directly to GitHub and commits each map as a JSON file in the configured
 * repository, exactly like MindSpark's static/Worker deployments.
 *
 * That means:
 *   - no SQLite, no database, no map content on this server
 *   - no session cookies; the GitHub token lives in the browser's localStorage
 *   - the server only holds GITHUB_CLIENT_SECRET and serves files
 *
 * Why /healthz answers 404: the client probes it to decide between local
 * SQLite mode and forge (GitHub-backed) mode. A 200 would switch the app to
 * ServerStore and hide GitHub login. Ops checks use /status instead.
 *
 * Zero dependencies. Node.js >= 20.
 *
 * Environment (see selfhost/config.example.env):
 *   PORT                     HTTP port (default 8080)
 *   HOST                     bind address (default 127.0.0.1)
 *   PUBLIC_DIR               static directory (default ../public)
 *   APP_ORIGIN               public origin, e.g. https://mindspark.example.com
 *   GITHUB_CLIENT_ID         GitHub OAuth App client id
 *   GITHUB_CLIENT_SECRET     GitHub OAuth App client secret
 *   DEFAULT_REPO             shared maps repo, e.g. acme/mindspark-maps
 *   ALLOWED_GITHUB_LOGINS    optional comma-separated allowlist of GitHub logins
 *   EXTRA_CONNECT_SRC        optional extra CSP connect-src origins (LLM providers)
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'));

const GITHUB_CLIENT_ID = (process.env.GITHUB_CLIENT_ID || '').trim();
const GITHUB_CLIENT_SECRET = (process.env.GITHUB_CLIENT_SECRET || '').trim();
const OAUTH_ENABLED = !!(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
const DEFAULT_REPO = (process.env.DEFAULT_REPO || '').trim() || 'mindspark-maps';
const ALLOWED_LOGINS = new Set(
  (process.env.ALLOWED_GITHUB_LOGINS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);
const EXTRA_CONNECT = (process.env.EXTRA_CONNECT_SRC || '')
  .trim().split(/\s+/).filter(o => /^https?:\/\/[^\s'"<>]+$/.test(o)).join(' ');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};
const COMPRESSIBLE = new Set([
  'text/html; charset=utf-8', 'text/javascript; charset=utf-8', 'text/css; charset=utf-8',
  'application/json; charset=utf-8', 'image/svg+xml', 'application/manifest+json; charset=utf-8'
]);

// The same policy as public/_headers, built here so a self-hosted response can
// add EXTRA_CONNECT_SRC for custom LLM providers. The browser enforces the
// intersection of this header and the <meta> tag, so the meta is patched too.
const CSP_BASE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://avatars.githubusercontent.com https://icons.duckduckgo.com",
  "connect-src 'self' https://api.github.com https://codeberg.org https://gitea.com https://gitlab.com https://api.crossref.org https://api.anthropic.com https://api.openai.com https://openrouter.ai https://api.groq.com https://opencode.ai https://api.quotable.io https://zenquotes.io https://favqs.com https://dummyjson.com https://quoteslate.vercel.app https://stoic.tekloon.net https://type.fit https://api.freeapi.app https://words.dev-apis.com https://random-word-api.herokuapp.com https://random-words-api.vercel.app https://api.datamuse.com https://api.urbandictionary.com https://wordoftheday.freeapi.me https://api.wotd.site",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
];
const CSP = CSP_BASE.join('; ') + (EXTRA_CONNECT ? ' ' + EXTRA_CONNECT : '');
const CSP_META = CSP_BASE.join('; ') + (EXTRA_CONNECT ? ' ' + EXTRA_CONNECT : '');

function appOrigin(req) {
  const explicit = (process.env.APP_ORIGIN || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || ('localhost:' + PORT)).split(',')[0].trim();
  return `${proto}://${host}`;
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function send(res, status, body, type, opts = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const headers = {
    'Content-Type': type,
    'Content-Length': buf.length,
    ...(opts.headers || {})
  };
  res.writeHead(status, headers);
  res.end(buf);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', {
    headers: { 'Cache-Control': 'no-store' }
  });
}

function sendHtml(res, status, html) {
  send(res, status, html, 'text/html; charset=utf-8', {
    headers: { 'Cache-Control': 'no-store' }
  });
}

// ---------------------------------------------------------------------------
// OpenCode proxy
//
// opencode.ai/inference does not send Access-Control-Allow-Origin, so a browser
// cannot call it directly (the preflight is 404). This same-origin endpoint
// forwards the request, including the caller's own Bearer key, and returns the
// provider's response unchanged.
//
// The key is read from the request, used for exactly one upstream request, and
// never stored, logged, or attached to any error. Only the two chat-completion
// paths the app uses are allowed; this is not an open relay.
// ---------------------------------------------------------------------------
const OPENCODE_UPSTREAM = (process.env.OPENCODE_UPSTREAM || 'https://opencode.ai/inference').replace(/\/+$/, '');
const OPENCODE_PATHS = new Set([
  'openai/v1/chat/completions',
  'go/openai/v1/chat/completions'
]);
const MAX_LLM_BODY = 2 * 1024 * 1024;

function readBodyLimited(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        const e = new Error('request body too large');
        e.status = 413;
        reject(e);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function opencodeProxy(req, res, pathname) {
  const prefix = '/api/llm/opencode/';
  const rest = pathname.slice(prefix.length);
  if (!OPENCODE_PATHS.has(rest)) return sendJson(res, 404, { error: { message: 'unknown upstream path' } });

  // Same-origin only. A browser sends Origin on cross-origin requests; refusing
  // another site's origin keeps this from becoming a free relay for its keys.
  const origin = req.headers.origin;
  if (origin && origin !== appOrigin(req)) return sendJson(res, 403, { error: { message: 'origin not allowed' } });

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type' });
    return res.end();
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: { message: 'method not allowed' } });

  const auth = req.headers.authorization || '';
  if (!/^Bearer\s+\S+/i.test(auth)) return sendJson(res, 401, { error: { message: 'OpenCode API key required' } });
  if (Number(req.headers['content-length'] || 0) > MAX_LLM_BODY) return sendJson(res, 413, { error: { message: 'request body too large' } });

  let body;
  try { body = await readBodyLimited(req, MAX_LLM_BODY); }
  catch (e) { return sendJson(res, e.status || 400, { error: { message: e.message } }); }

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': auth,
    'User-Agent': 'MindSpark-selfhost/1.0'
  };
  // OpenCode Go asks clients for a stable session id. Forward one if a future
  // client sends it; otherwise this stays absent rather than inventing a new
  // "session" on every request.
  const session = req.headers['x-opencode-session'];
  if (session) headers['x-opencode-session'] = String(session);

  let upstream;
  try {
    upstream = await fetch(OPENCODE_UPSTREAM + '/' + rest, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(120000)
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return sendJson(res, 502, { error: { message: timedOut ? 'OpenCode timed out' : 'OpenCode unreachable' } });
  }

  const text = await upstream.text();
  const type = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
  res.writeHead(upstream.status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text)
  });
  res.end(text);
}

// ---------------------------------------------------------------------------
// OAuth callback. Mirrors worker/oauth-worker.js: exchange the code, then hand
// the token to the opener window via postMessage. The token is never written
// to disk or logged. ALLOWED_GITHUB_LOGINS is optional and checked server-side
// after the exchange, before the token is delivered.
// ---------------------------------------------------------------------------
async function oauthCallback(req, res, url) {
  const code = url.searchParams.get('code') || '';
  const state = (url.searchParams.get('state') || '').replace(/[^A-Za-z0-9_-]/g, '');
  const origin = appOrigin(req);
  if (!code) return sendHtml(res, 400, resultPage('', state, 'missing_code', origin));

  let token = '', error = '';
  try {
    const form = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: origin + '/callback'
    });
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const data = await r.json();
    token = data.access_token || '';
    error = data.error || (token ? '' : 'no_token');
  } catch (e) {
    error = 'exchange_failed';
  }

  if (token && ALLOWED_LOGINS.size) {
    try {
      const u = await fetch('https://api.github.com/user', {
        headers: {
          'Authorization': 'Bearer ' + token,
          'User-Agent': 'MindSpark-selfhost',
          'Accept': 'application/vnd.github+json'
        }
      });
      const user = u.ok ? await u.json() : null;
      const login = String((user && user.login) || '').toLowerCase();
      if (!login || !ALLOWED_LOGINS.has(login)) {
        error = 'not_allowed';
        // Best effort: do not leave a live grant behind for a rejected login.
        try {
          await fetch('https://api.github.com/applications/' + encodeURIComponent(GITHUB_CLIENT_ID) + '/token', {
            method: 'DELETE',
            headers: {
              'Authorization': 'Basic ' + Buffer.from(GITHUB_CLIENT_ID + ':' + GITHUB_CLIENT_SECRET).toString('base64'),
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'MindSpark-selfhost'
            },
            body: JSON.stringify({ access_token: token })
          });
        } catch (e2) { /* revoke is best effort */ }
        token = '';
      }
    } catch (e) {
      error = 'verify_failed';
      token = '';
    }
  }

  return sendHtml(res, 200, resultPage(token, state, error, origin));
}

function resultPage(token, state, error, allowedOrigin) {
  const payload = JSON.stringify({ type: 'mindspark-oauth', token, state, error })
    .replace(/</g, '\\u003c');
  const target = JSON.stringify(allowedOrigin || '*');
  let msg = 'Signed in. You can close this window.';
  if (error === 'not_allowed') msg = 'This GitHub account is not on the allowlist for this MindSpark instance.';
  else if (error) msg = 'Sign-in failed (' + String(error).replace(/[^A-Za-z0-9_-]/g, '') + '). You can close this window.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>MindSpark - GitHub</title>
<meta name="referrer" content="no-referrer">
<style>body{font:15px system-ui,-apple-system,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#333;background:#faf7f2}
.box{max-width:34rem;padding:1.5rem 2rem;border:1px solid #ddd;border-radius:14px;background:#fff;text-align:center}</style>
</head><body><div class="box"><p>${msg}</p></div>
<script>
(function(){
  try { if (window.opener) window.opener.postMessage(${payload}, ${target}); } catch (e) {}
  setTimeout(function(){ try { window.close(); } catch (e) {} }, 400);
})();
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
function injectConfig(html) {
  // config.js must run before app.js; it is local and tiny, so no defer needed.
  let out = html.replace('<script src="./templates.js"', '<script src="./config.js"></script>\n<script src="./templates.js"');
  if (EXTRA_CONNECT) {
    out = out.replace(
      /(<meta http-equiv="Content-Security-Policy" content="[^"]*?connect-src [^;"]+)/,
      '$1 ' + EXTRA_CONNECT
    );
  }
  return out;
}

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, 'Bad request', 'text/plain'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    return send(res, 403, 'Forbidden', 'text/plain');
  }
  let stat;
  try { stat = fs.statSync(filePath); } catch (e) { return send(res, 404, 'Not found', 'text/plain'); }
  if (!stat.isFile()) return send(res, 404, 'Not found', 'text/plain');

  let body;
  try { body = fs.readFileSync(filePath); } catch (e) { return send(res, 500, 'Read error', 'text/plain'); }
  const ext = path.extname(filePath).toLowerCase();
  let type = MIME[ext] || 'application/octet-stream';
  if (ext === '.html') body = Buffer.from(injectConfig(body.toString('utf8')));

  let headers = { 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' };
  const accept = req.headers['accept-encoding'] || '';
  if (body.length > 1024 && accept.includes('gzip') && COMPRESSIBLE.has(type)) {
    try {
      const gz = zlib.gzipSync(body);
      if (gz.length < body.length) {
        body = gz;
        headers['Content-Encoding'] = 'gzip';
        headers['Vary'] = 'Accept-Encoding';
      }
    } catch (e) { /* send uncompressed */ }
  }
  send(res, 200, body, type, { headers });
}

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  res.setHeader('Content-Security-Policy', CSP);
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // Deliberately 404: see the header comment. Ops health checks use /status.
    if (p === '/healthz') return send(res, 404, 'Not found', 'text/plain');

    if (p === '/status') {
      return sendJson(res, 200, {
        ok: true,
        mode: 'selfhost-cloud',
        oauth: OAUTH_ENABLED,
        repo: DEFAULT_REPO,
        allowlist: ALLOWED_LOGINS.size > 0,
        storage: 'github-repo',
        collab: false
      });
    }

    if (p === '/config.js') {
      const cfg = {
        defaultRepo: DEFAULT_REPO,
        collab: false,
        llmProxy: appOrigin(req) + '/api/llm/opencode'
      };
      if (OAUTH_ENABLED) {
        const origin = appOrigin(req);
        cfg.oauth = { clientId: GITHUB_CLIENT_ID, workerUrl: origin, appOrigin: origin };
      }
      return send(res, 200,
        'window.MINDSPARK_CONFIG=' + JSON.stringify(cfg) + ';\n',
        'text/javascript; charset=utf-8',
        { headers: { 'Cache-Control': 'no-store' } });
    }

    if (p === '/callback') return oauthCallback(req, res, url);

    if (p.startsWith('/api/llm/opencode/')) return opencodeProxy(req, res, p);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'Method not allowed', 'text/plain');
    }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error('request failed:', e && e.message);
    return send(res, 500, 'Internal error', 'text/plain');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MindSpark selfhost listening on http://${HOST}:${PORT}`);
  console.log(`  public:  ${PUBLIC_DIR}`);
  console.log(`  repo:    ${DEFAULT_REPO}`);
  console.log(`  oauth:   ${OAUTH_ENABLED ? 'enabled' : 'disabled (set GITHUB_CLIENT_ID/SECRET)'}`);
  if (ALLOWED_LOGINS.size) console.log(`  logins:  allowlist of ${ALLOWED_LOGINS.size}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nshutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
