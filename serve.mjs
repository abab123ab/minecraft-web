import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = import.meta.dirname;
const PORT = 8321;
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg']);
const MIN_GZIP = 1024;

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404).end('not found'); return; }

    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = '"' + stat.size + '-' + stat.mtimeMs + '"';

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, Connection: 'keep-alive' });
      res.end();
      return;
    }

    const accept = req.headers['accept-encoding'] || '';
    const useGzip = COMPRESSIBLE.has(ext) && stat.size >= MIN_GZIP && accept.includes('gzip');

    const headers = {
      'Content-Type': type,
      ETag: etag,
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Keep-Alive': 'timeout=120, max=1000'
    };
    if (useGzip) headers['Content-Encoding'] = 'gzip';

    res.writeHead(200, headers);

    const stream = fs.createReadStream(filePath);
    if (useGzip) {
      stream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
    } else {
      stream.pipe(res);
    }
  });
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 130000;
server.listen(PORT, HOST, () => {
  console.log('serving ' + ROOT + ' on http://' + HOST + ':' + PORT + ' (gzip + keep-alive)');
});
