// POS-PERF-P40R2 — local fault-injection proxy in front of local Supabase
// Storage, so the proof-photo specs can exercise real Storage answers for
// outage and misconfiguration states. Local only: refuses a non-loopback
// upstream. Point the API's SUPABASE_URL at this proxy.
//
//   node storage-fault-proxy.cjs            (PROXY_PORT=54400, STORAGE_UPSTREAM=http://127.0.0.1:54321)
//   GET /__ctl?mode=<mode>[&token=<t>]      -> switch mode
//   GET /__log                              -> recent requests (method, path, mode, status)
//
// Modes:
//   pass         forward unchanged
//   down         destroy every socket (Storage unreachable)
//   nobucket     rewrite the proof bucket segment to a bucket that does not exist
//   expire-once  send the next signed-object GET with `token` (an already-expired
//                signed token for the same object), then return to pass
//
// The log never records headers, query strings or tokens.
const http = require('node:http');

const PORT = Number(process.env.PROXY_PORT || 54400);
const upstream = new URL(process.env.STORAGE_UPSTREAM || 'http://127.0.0.1:54321');
if (!['127.0.0.1', 'localhost'].includes(upstream.hostname)) throw new Error('STORAGE_UPSTREAM is not local — refusing to run');

const MISSING_BUCKET = 'p40r2-no-such-bucket';
let mode = 'pass';
let expiredToken = null;
const log = [];

function record(entry) {
  log.push({ at: new Date().toISOString(), ...entry });
  if (log.length > 2000) log.shift();
}

function json(res, body) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://proxy');
  if (url.pathname === '/__ctl') {
    mode = url.searchParams.get('mode') ?? mode;
    expiredToken = url.searchParams.get('token') ?? expiredToken;
    json(res, { mode, hasExpiredToken: Boolean(expiredToken) });
    return;
  }
  if (url.pathname === '/__log') {
    json(res, log);
    return;
  }
  if (mode === 'down') {
    record({ method: req.method, path: url.pathname, mode, status: 'socket-destroyed' });
    req.socket.destroy();
    return;
  }

  let path = url.pathname;
  const params = new URLSearchParams(url.search);
  if (mode === 'nobucket') path = path.replace(/\/(payment-proofs|discount-proofs)(\/|$)/, `/${MISSING_BUCKET}$2`);
  if (mode === 'expire-once' && req.method === 'GET' && path.startsWith('/storage/v1/object/sign/') && expiredToken) {
    params.set('token', expiredToken);
    mode = 'pass';
    record({ method: req.method, path, mode: 'expire-once', status: 'token-swapped' });
  }
  const query = params.toString();
  const forward = http.request(
    {
      host: upstream.hostname,
      port: upstream.port,
      method: req.method,
      path: path + (query ? `?${query}` : ''),
      headers: { ...req.headers, host: upstream.host },
    },
    (upstreamRes) => {
      record({ method: req.method, path, mode, status: upstreamRes.statusCode });
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  forward.on('error', (error) => {
    record({ method: req.method, path, mode, status: `upstream-error ${error.code}` });
    res.destroy();
  });
  req.pipe(forward);
});

server.listen(PORT, '127.0.0.1', () => console.log(`storage fault proxy on 127.0.0.1:${PORT} -> ${upstream.host}`));
