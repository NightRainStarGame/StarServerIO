/**
 * SSIO Electron 最小示例（主进程）。
 *
 * 窗口显示「当前版本 1.2.3 → 发现更新 1.3.0 → 下载进度 → sha256 校验通过」。
 * SSIO 服务端跑在独立的 node 子进程（seed-child.mjs，见其内注释说明 ABI 问题）；
 * Electron 侧只用 @ssio/node 的 updater，不碰原生模块。
 *
 * 跑法（仓库根）：pnpm install && pnpm --filter electron-min dev
 */
/* global console, setTimeout */
import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createNodeClient, createUpdater } from '@ssio/node';

const here = dirname(fileURLToPath(import.meta.url));
const CURRENT_VERSION = '1.2.3';
let win = null;

function send(channel, payload) {
  win?.webContents.send(channel, payload);
}

/** 起种子子进程，等它打出 READY <base> <key>。 */
function waitSeed() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(here, 'seed-child.mjs')], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const line = buf.split('\n').find((l) => l.startsWith('READY '));
      if (line) {
        const [, base, apiKey] = line.trim().split(' ');
        resolve({ base, apiKey, child });
      }
    });
    child.on('exit', (code) => reject(new Error(`种子进程提前退出（code ${code}）`)));
    setTimeout(() => reject(new Error('种子进程 15 秒未就绪')), 15_000);
  });
}

app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 560, height: 460, autoHideMenuBar: true });
  await win.loadFile('index.html');
  send('status', { text: `当前版本 ${CURRENT_VERSION}，正在连接服务端…` });

  const seeded = await waitSeed();
  const client = createNodeClient({ baseUrl: seeded.base, apiKey: seeded.apiKey });
  const upd = createUpdater(client, {
    app: 'electron-min', platform: 'win', arch: 'x64', channel: 'stable',
    currentVersion: CURRENT_VERSION, clientId: 'device-emin',
    downloadDirDefault: join(tmpdir(), 'ssio-emin-dl'),
  });

  const info = await upd.check();
  if (!info.hasUpdate) {
    send('status', { text: '已是最新版本' });
    return;
  }
  send('found', { current: CURRENT_VERSION, version: info.version, notes: info.notes, size: info.size, mandatory: info.mandatory });

  const dest = await upd.download(info, {
    onProgress: (p) => send('progress', { percent: p.percent ?? 0, downloaded: p.downloaded, total: p.total }),
  });
  await upd.verify(info, dest);

  // 是否执行安装必须显式确认：示例只报告就绪，不真装（autoInstall 默认 false）
  const applyResult = await upd.apply({ strategy: 'installer' }, dest);
  send('done', { file: dest, message: applyResult.message });
  console.log(`[electron-min] 更新 ${info.version} 已下载并校验：${dest}`);
  console.log(`[electron-min] apply：${applyResult.message}`);
}).catch((err) => {
  console.error('[electron-min] 失败:', err instanceof Error ? err.message : err);
  send('status', { text: `失败：${err instanceof Error ? err.message : String(err)}` });
});

app.on('window-all-closed', () => app.quit());
