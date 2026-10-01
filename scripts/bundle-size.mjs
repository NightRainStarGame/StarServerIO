/**
 * SDK 体积测量：tree-shaking 视角 —— 以「只 import 入口」为消费方式打包 minify 后测 gzip。
 *
 * 跑法（仓库根）：pnpm sdk:size
 *
 * P4 验收要求 @ssio/web < 15 KB gzip。React hooks 在 ./react 子路径单独测
 * （不用 React 的消费方不应为 hooks 付体积）。
 */
/* eslint-disable no-console */
import esbuild from 'esbuild';
import { gzipSync } from 'node:zlib';

async function measure(name, entry, external = []) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    external,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  const gzip = gzipSync(Buffer.from(code)).length;
  const kb = (n) => (n / 1024).toFixed(2);
  console.log(`${name.padEnd(22)} minify ${kb(code.length).padStart(7)} KB   gzip ${kb(gzip).padStart(7)} KB`);
  return { name, minified: code.length, gzip };
}

console.log('SSIO SDK 体积（esbuild bundle + minify + gzip）\n');
void measure('@ssio/core', 'packages/core/dist/index.js');
const web = await measure('@ssio/web', 'packages/web/dist/index.js');
void measure('@ssio/web/react', 'packages/web/dist/react.js', ['react']);

console.log('');
const budget = 15 * 1024;
if (web.gzip > budget) {
  console.log(`✗ @ssio/web 超出预算：${(web.gzip / 1024).toFixed(2)} KB > 15 KB`);
  process.exit(1);
}
console.log(`✓ @ssio/web ${(web.gzip / 1024).toFixed(2)} KB gzip < 15 KB 预算`);
