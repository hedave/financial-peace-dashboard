/**
 * Cross-platform `npm start`: python3, then Node, then Windows `py -3`.
 * Serves the repo root at http://127.0.0.1:8080
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = 8080;
const host = '127.0.0.1';

function trySpawn(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: root });
    child.once('error', reject);
    child.once('spawn', () => {
      child.once('exit', (code, signal) => {
        if (signal) process.kill(process.pid, signal);
        else process.exit(code ?? 0);
      });
      resolvePromise();
    });
  });
}

function serveWithNode() {
  const mime = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json',
  };

  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      try {
        let p = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
        if (p === '/') p = '/index.html';
        const file = normalize(join(root, p));
        if (file !== root && !file.startsWith(root + sep)) {
          res.writeHead(403);
          return res.end('Forbidden');
        }
        readFile(file, (err, data) => {
          if (err) {
            res.writeHead(404);
            return res.end('Not found');
          }
          const ext = extname(file).toLowerCase();
          res.writeHead(200, {
            'Content-Type': mime[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
          });
          res.end(data);
        });
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`Serving http://${host}:${port} (node)`);
      resolvePromise();
    });
  });
}

async function main() {
  try {
    await trySpawn('python3', ['-m', 'http.server', String(port), '--bind', host]);
    return;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  try {
    await serveWithNode();
    return;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  try {
    await trySpawn('py', ['-3', '-m', 'http.server', String(port), '--bind', host]);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      console.error('ERROR: No local server runtime found. Need python3, node, or Windows py -3.');
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
