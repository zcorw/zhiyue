import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname } from 'node:path';

const port = Number(process.argv[2] ?? 4178);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('端口必须是 1 至 65535 之间的整数。');
  process.exit(1);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.svg': 'image/svg+xml',
};
const root = new URL('./', import.meta.url);

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  const [path] = request.url.split('?');
  if (path === '/' || path === '/preview') {
    response.writeHead(302, { Location: '/preview/' }).end();
    return;
  }

  const file = path === '/preview/' ? '/preview/index.html' : path;
  const isPublicFile = /^\/(?:preview\/[a-zA-Z0-9_-]+\.(?:html|css|js|svg)|aiui\/data\/articles\.js|aiui\/assets\/[a-z0-9-]+\.ogg)$/.test(file);
  if (!isPublicFile) {
    response.writeHead(404).end();
    return;
  }

  try {
    const content = await readFile(new URL(file.slice(1), root));
    response.writeHead(200, {
      'Content-Type': types[extname(file)],
      'Content-Length': content.byteLength,
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  }
});

server.on('error', (error) => {
  console.error(`预览服务启动失败（${error.code}）。可以运行 node serve-preview.mjs 4179 换用端口。`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`知阅电脑预览：http://127.0.0.1:${port}/preview/`);
});
