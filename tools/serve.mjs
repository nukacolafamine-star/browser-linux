import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.gz': 'application/gzip', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const candidate = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const filename = await realpath(candidate);
    if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const info = await stat(filename);
    if (!info.isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
    res.setHeader('Content-Length', info.size);
    res.writeHead(200);
    if (req.method === 'HEAD') res.end(); else createReadStream(filename).pipe(res);
  } catch { res.writeHead(404).end('Not found'); }
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. If Browser Linux is already running, open http://127.0.0.1:${port}. Otherwise choose a different PORT.`:error.message);process.exitCode=1;});
server.listen(port, '127.0.0.1', () => console.log(`Browser Linux: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit()));
