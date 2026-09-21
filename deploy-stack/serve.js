// Serves the built interface and proxies /api to the indexer running in this same
// process. One port, one container, no web server to configure.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const PORT = Number(process.env.PORT ?? 8787);
const API_PORT = Number(process.env.API_PORT ?? 8788);

// In the image this file sits at the project root. During development it sits one
// level down, in deploy-stack. Accept both.
const HERE = import.meta.dirname;
const ROOT = existsSync(join(HERE, 'web', 'dist')) ? HERE : join(HERE, '..');
const WEB_ROOT = join(ROOT, 'web', 'dist');

// The indexer keeps its own port, and this server is the only thing exposed.
process.env.SERVER_PORT = String(API_PORT);
await import(new URL(`file://${join(ROOT, 'server', 'src', 'index.js')}`).href);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendFile(res, path) {
  res.writeHead(200, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(path).pipe(res);
}

createServer((req, res) => {
  // A path like /% makes URL parsing and decodeURIComponent throw. Uncaught, that ends the
  // process serving both the interface and the API, which any unauthenticated caller could
  // then repeat at will.
  let url;
  let pathname;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'malformed request path' }));
  }

  if (url.pathname.startsWith('/api/')) {
    const upstream = new URL(url.pathname + url.search, `http://127.0.0.1:${API_PORT}`);
    fetch(upstream, { headers: { accept: req.headers.accept ?? '*/*' } })
      .then(async (response) => {
        // Server sent events must stream rather than buffer.
        if (response.headers.get('content-type')?.includes('event-stream')) {
          res.writeHead(response.status, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          });
          const reader = response.body.getReader();
          const pump = () => reader.read().then(({ done, value }) => {
            if (done) return res.end();
            res.write(value);
            return pump();
          });
          req.on('close', () => reader.cancel().catch(() => {}));
          return pump();
        }
        const body = await response.text();
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
        res.end(body);
      })
      .catch((err) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err.message ?? err) }));
      });
    return;
  }

  // Static files, with a fall back to the single page entry point.
  const requested = normalize(join(WEB_ROOT, pathname));
  if (requested.startsWith(WEB_ROOT) && existsSync(requested) && statSync(requested).isFile()) {
    return sendFile(res, requested);
  }
  return sendFile(res, join(WEB_ROOT, 'index.html'));
}).listen(PORT, () => {
  console.log(`[serve] interface and API on http://0.0.0.0:${PORT}`);
});
