import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptWebSocket } from './net/websocket.mjs';
import { attachNetwork } from './net/user-network.mjs';

const root = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.gz': 'application/gzip', '.webmanifest': 'application/manifest+json' };

// Guest networking: the compatibility engine's virtual network card sends
// Ethernet frames over a WebSocket to this loopback server, which forwards
// the guest's TCP/UDP traffic with ordinary sockets. Only pages served by this
// server may connect. The guest cannot reach this computer's loopback or local
// network addresses unless BROWSER_LINUX_NET_LOCAL=1 is set.
const networkEnabled = process.env.BROWSER_LINUX_NETWORK !== 'off';
const allowNonPublic = process.env.BROWSER_LINUX_NET_LOCAL === '1';
const networkOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
const networks = new Set();
const MAX_NETWORKS = 4;

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
    if (pathname === '/net') {
      // Lets the page detect the relay before starting a guest. Static hosts
      // without it answer 404.
      res.setHeader('X-Browser-Linux-Network', networkEnabled ? 'available' : 'disabled');
      res.writeHead(networkEnabled ? 426 : 404).end();
      return;
    }
    const candidate = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    const filename = await realpath(candidate);
    if (!filename.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    const info = await stat(filename);
    if (!info.isFile()) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      // Lazily loaded disk images fetch only the chunks the guest reads.
      const start = Number(range[1]), end = Math.min(range[2] ? Number(range[2]) : info.size - 1, info.size - 1);
      if (start > end || start >= info.size) { res.writeHead(416, {'Content-Range': `bytes */${info.size}`}).end(); return; }
      res.writeHead(206, {'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Accept-Ranges': 'bytes'});
      if (req.method === 'HEAD') res.end(); else createReadStream(filename, {start, end}).pipe(res);
      return;
    }
    res.setHeader('Content-Length', info.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.writeHead(200);
    if (req.method === 'HEAD') res.end(); else createReadStream(filename).pipe(res);
  } catch { res.writeHead(404).end('Not found'); }
});

server.on('upgrade', (req, socket, head) => {
  const refuse = status => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.on('error', () => {});
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/net' || !networkEnabled) { refuse('404 Not Found'); return; }
  if (!networkOrigins.has(req.headers.origin)) { refuse('403 Forbidden'); return; }
  if (networks.size >= MAX_NETWORKS) { refuse('503 Service Unavailable'); return; }
  const ws = acceptWebSocket(req, socket, head, {protocols: ['binary']});
  if (!ws) return;
  const network = attachNetwork(ws, {allowNonPublic});
  networks.add(network);
  console.log(`Guest network connected (${networks.size} active).`);
  ws.on('error', () => {});
  ws.on('close', () => {
    networks.delete(network);
    const {tcpConnections, udpFlows, dnsQueries, refused} = network.stats;
    console.log(`Guest network closed: ${tcpConnections} TCP connections, ${udpFlows} UDP flows, ${dnsQueries} DNS queries, ${refused} refused.`);
  });
});

server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. If Browser Linux is already running, open http://127.0.0.1:${port}. Otherwise choose a different PORT.`:error.message);process.exitCode=1;});
server.listen(port, '127.0.0.1', () => {
  console.log(`Browser Linux: http://127.0.0.1:${port}`);
  console.log(networkEnabled
    ? `Guest networking: on (Internet only${allowNonPublic ? ', plus this computer and local network' : ''}). Set BROWSER_LINUX_NETWORK=off to disable.`
    : 'Guest networking: off.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const network of networks) network.close(); server.close(); process.exit(); });
