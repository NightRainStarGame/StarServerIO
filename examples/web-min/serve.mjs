/**
 * web-min 的本地静态服务：把 workspace 的 dist 映射成 import map 可用的 /vendor/* URL。
 *
 * 跑法（仓库根）：
 *   pnpm build && node examples/web-min/serve.mjs
 * 然后浏览器打开 http://127.0.0.1:5175/
 *
 * 先起一个 SSIO（cd packages/server && pnpm dev，默认 8100）并在页面填入 APIKey。
 */
/* eslint-disable no-console */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const vendorRoots = {
  '/vendor/web/': join(repo, 'packages/web/dist/'),
  '/vendor/core/': join(repo, 'packages/core/dist/'),
  '/vendor/shared/': join(repo, 'packages/shared/dist/'),
};

const types = {
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
};

createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  try {
    for (const [prefix, dir] of Object.entries(vendorRoots)) {
      if (url.startsWith(prefix)) {
        const data = await readFile(join(dir, url.slice(prefix.length).replace(/\.js$/, '.js')));
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(data);
        return;
      }
    }
    const file = url === '/' ? join(here, 'index.html') : join(here, url);
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': types[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(5175, '127.0.0.1', () => {
  console.log('web-min 已就绪：http://127.0.0.1:5175/（服务端默认按 http://127.0.0.1:8100 连）');
});
