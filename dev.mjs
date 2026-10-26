import http from 'node:http';
import { readFile } from 'node:fs/promises';

// Demo-only static preview. No host credentials or live backend proxy.
const files = new Map([
  ['/', ['panel/index.html', 'text/html']],
  ['/index.html', ['panel/index.html', 'text/html']],
  ['/main.js', ['panel/main.js', 'text/javascript']],
  ['/styles.css', ['panel/styles.css', 'text/css']],
]);
const port = Number(process.env.PORT || 4318);
http.createServer(async (req, res) => {
  const route = files.get(new URL(req.url || '/', 'http://127.0.0.1').pathname);
  if (!route || req.method !== 'GET') { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(new URL(route[0], import.meta.url));
    res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' }).end(body);
  } catch { res.writeHead(503).end('Run npm run build first.'); }
}).listen(port, '127.0.0.1', () => console.log(`Maxwell illustrative demo: http://127.0.0.1:${port}/?demo=1`));
