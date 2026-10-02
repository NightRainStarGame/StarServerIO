#!/usr/bin/env node
/**
 * SSIO 一键远程部署：从**本机**把仓库推到一台 Linux 服务器并跑起来。
 *
 * 为什么不用 git clone：目标服务器在国内时访问 GitHub 经常超时/失败。
 * 所以这里是「本机打包已提交内容 → SFTP 上传 → 服务器解压 → 装依赖 → 构建 → systemd 起服务」。
 * 用 git archive 打包是有意的：**部署的永远是已提交的内容**，本地没提交的改动不会偷偷上生产。
 *
 * 依赖：ssh2（按需加载，不进 workspace 依赖，避免污染服务端镜像）
 *   npm i ssh2
 *
 * 用法：
 *   node deploy/remote-deploy.mjs --host nrsc.games --user ubuntu --password <密码>
 *   node deploy/remote-deploy.mjs --host 1.2.3.4 --user ubuntu --key ~/.ssh/id_ed25519 --dir /home/ubuntu/SSIO
 */
/* eslint-disable no-console */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.host && !args['dry-run'])) {
  console.log(
    '用法: node deploy/remote-deploy.mjs --host <域名/IP> [--port 22] --user <用户名>\n' +
      '      [--password <密码> | --key <私钥路径>] [--dir /home/ubuntu/SSIO] [--port-ssio 8100]\n' +
      '      [--no-service]   # 只用 nohup 起进程，不注册 systemd\n' +
      '      [--dry-run]      # 只打包不上传',
  );
  process.exit(args.help ? 0 : 1);
}

const host = String(args.host);
const port = Number(args.port ?? 22);
const user = String(args.user ?? 'ubuntu');
const password = args.password ? String(args.password) : undefined;
const keyPath = args.key ? resolve(String(args.key).replace(/^~/, homedir())) : undefined;
const remoteDir = String(args.dir ?? '/home/ubuntu/SSIO');
const ssioPort = Number(args['port-ssio'] ?? 8100);
const useService = !args['no-service'];

// ---------- 1. 本机打包 ----------
// 默认按脚本位置推算仓库根；脚本被拷到别处运行时用 --repo 指定
const repoRoot = args.repo ? resolve(String(args.repo)) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = join(repoRoot, '.deploy');
mkdirSync(tmpDir, { recursive: true });
const tgz = join(tmpDir, 'ssio-src.tgz');

// --restart-only：只连上去重启服务（已经手工传过改动时用它，跳过打包/上传/构建）
const restartOnly = !!args['restart-only'];

if (!restartOnly) {
  console.log('[1/7] 打包已提交内容（git archive，不含 node_modules / dist / data）');
  execFileSync('git', ['archive', '--format=tar.gz', '-o', tgz, 'HEAD'], { cwd: repoRoot });
  console.log(`      产物 ${(statSync(tgz).size / 1024).toFixed(0)} KB`);
}

if (args['dry-run']) {
  console.log('--dry-run：到此为止');
  process.exit(0);
}

// ssh2 按需加载：不进 workspace 依赖（服务端镜像不需要它，CI 也不会装）
let ssh2;
try {
  ssh2 = await import('ssh2');
} catch {
  console.error('缺少 ssh2。先装：npm i ssh2');
  process.exit(1);
}
const { Client } = ssh2;

// ---------- 2. 连接 ----------
const conn = new Client();
await new Promise((res, rej) => {
  conn.on('ready', res);
  conn.on('error', rej);
  conn.connect({
    host,
    port,
    username: user,
    password,
    privateKey: keyPath && existsSync(keyPath) ? readFileSync(keyPath) : undefined,
    readyTimeout: 20000,
  });
});
console.log(`[2/7] 已连接 ${user}@${host}:${port}`);

if (restartOnly) {
  console.log('[restart-only] 跳过上传与构建，仅重启服务以加载最新代码');
  if (useService) {
    await sh('systemctl restart ssio', { sudo: true });
    await new Promise((r) => setTimeout(r, 4000));
    console.log('      服务状态: ' + (await sh('systemctl is-active ssio', { quiet: true, sudo: true })).trim());
  } else {
    await sh(`pkill -f 'packages/server/dist/index.js' || true`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const ready = await sh(`curl -fsS -m 5 http://127.0.0.1:${ssioPort}/v1/readyz || echo FAIL`, { quiet: true });
  console.log(`      readyz: ${ready.trim()}`);
  conn.end();
  process.exit(0);
}

const remoteTgz = '/tmp/ssio-src.tgz';

try {
  // ---------- 3. 上传 ----------
  console.log('[3/7] 上传源码包');
  await sftpUpload(conn, tgz, remoteTgz);

  // ---------- 4. 运行环境 ----------
  console.log('[4/7] 准备运行环境（Node 22 / pnpm，走 npmmirror —— 国内服务器拉 GitHub 会超时）');
  await sh(`mkdir -p ${remoteDir} && tar -xzf ${remoteTgz} -C ${remoteDir} && rm -f ${remoteTgz}`);

  const nodeOk = await sh('node -v 2>/dev/null | grep -q "^v2[2-9]" && echo yes || echo no', { quiet: true });
  if (!nodeOk.includes('yes')) {
    console.log('      Node 22 不在位，从 npmmirror 下载二进制（不走 nodesource，国内更稳）');
    const arch = (await sh('uname -m', { quiet: true })).trim();
    const tarball = arch.includes('aarch64') ? 'node-v22.11.0-linux-arm64.tar.xz' : 'node-v22.11.0-linux-x64.tar.xz';
    await sh(
      `cd /tmp && curl -fsSL -o node.tar.xz https://npmmirror.com/mirrors/node/v22.11.0/${tarball} && ` +
        `sudo tar -xJf node.tar.xz -C /usr/local --strip-components=1 && rm -f node.tar.xz`,
      { sudo: true },
    );
  }
  const pnpmOk = await sh('pnpm -v 2>/dev/null || echo no', { quiet: true });
  if (pnpmOk.trim() === 'no' || pnpmOk.includes('command not found')) {
    await sh('npm i -g pnpm@10 --registry=https://registry.npmmirror.com', { sudo: true });
  }

  // ---------- 5. 装依赖 + 构建 ----------
  console.log('[5/7] 安装依赖（排除 electron-min：那是 110MB 的 Electron 示例，服务端不需要）');
  await sh(
    `cd ${remoteDir} && pnpm install --frozen-lockfile --filter '!electron-min' --registry=https://registry.npmmirror.com`,
    { timeout: 300000 },
  );
  console.log('      构建 shared + server');
  await sh(`cd ${remoteDir} && pnpm --filter @ssio/shared --filter @ssio/server build`, { timeout: 300000 });
  await sh(`cd ${remoteDir} && pnpm rebuild better-sqlite3`, { timeout: 180000 });

  // better-sqlite3 在国内服务器上几乎必然装不上：install 脚本要从 GitHub 拉预编译包
  // （不通），回退编译又要从 nodejs.org 下 headers（也不通）。兜底：直接从
  // npmmirror 的二进制镜像取对应 ABI 的 tarball，解压到包目录即可，不用编译。
  console.log('      校验 better-sqlite3 原生模块');
  let bs3 = (await sh(`find ${remoteDir}/node_modules/.pnpm -maxdepth 8 -path '*better-sqlite3*/build/Release/better_sqlite3.node' | head -1`, { quiet: true })).trim();
  if (!bs3) {
    const dir = (await sh(`find ${remoteDir}/node_modules/.pnpm -maxdepth 1 -type d -name 'better-sqlite3@*' | head -1`, { quiet: true })).trim();
    const ver = dir.includes('@') ? dir.split('@').pop() : '11.10.0';
    const abi = (await sh('node -p "process.versions.modules"', { quiet: true })).trim() || '127';
    const pkgDir = `${dir}/node_modules/better-sqlite3`;
    const url = `https://registry.npmmirror.com/-/binary/better-sqlite3/v${ver}/better-sqlite3-v${ver}-node-v${abi}-linux-x64.tar.gz`;
    console.log(`      rebuild 没产出二进制，改从镜像下载（v${ver} / ABI ${abi}）`);
    await sh(
      `curl -fsSL -m 120 -o /tmp/bs3.tar.gz ${url} && mkdir -p ${pkgDir}/build/Release && ` +
        `tar -xzf /tmp/bs3.tar.gz -C ${pkgDir} && echo ok || echo failed`,
      { timeout: 180000 },
    );
    bs3 = (await sh(`find ${remoteDir}/node_modules/.pnpm -maxdepth 8 -path '*better-sqlite3*/build/Release/better_sqlite3.node' | head -1`, { quiet: true })).trim();
  }
  if (!bs3) {
    console.log('      [严重] better-sqlite3 二进制仍未就位 —— 服务会起不来，需要手工处理');
  } else {
    console.log(`      原生模块就位：${bs3.replace(remoteDir, '.')}`);
  }

  // ---------- 6. 配置 + 起服务 ----------
  console.log('[6/7] 生成 .env 并启动服务');
  // 注：这里**不能用 heredoc** —— 多行内容经 `bash -c` 传递时换行会被吃掉（实测：
  // 整段被拼成一行，写出来的 unit 全是错的）。改用 base64 单行传输。
  const envExists = await sh(`grep -q '^MASTER_KEY=' ${remoteDir}/.env 2>/dev/null && echo yes || echo no`, { quiet: true });
  let masterKey = '(已存在有效 .env，未改动)';
  if (!envExists.includes('yes')) {
    const { randomBytes } = await import('node:crypto');
    const jwt = randomBytes(32).toString('hex');
    masterKey = randomBytes(16).toString('hex');
    await writeRemote(
      `${remoteDir}/.env`,
      [
        `JWT_SECRET=${jwt}`,
        `MASTER_KEY=${masterKey}`,
        `DATA_DIR=${remoteDir}/data`,
        `HOST=0.0.0.0`,
        `PORT=${ssioPort}`,
        `LOG_LEVEL=info`,
        `RATE_LIMIT_MAX=600`,
        '',
      ].join('\n'),
      { sudo: false, owner: user },
    );
  }

  // 数据目录必须先存在：systemd 的 ReadWritePaths 指向不存在的目录时，
  // 服务会在 NAMESPACE 阶段直接失败（status=226/NAMESPACE），然后无限重启
  await sh(`mkdir -p ${remoteDir}/data && sudo chown ${user}:${user} ${remoteDir}/data`);

  // node 的实际路径因发行版/安装方式而异（/usr/bin/node、/usr/local/bin/node…），
  // systemd 里写死路径会起不来 —— 这里按服务器实际情况取
  const nodeBin = (await sh('command -v node || which node', { quiet: true })).trim().split('\n')[0] || '/usr/bin/node';
  console.log(`      node: ${nodeBin}`);
  if (useService) {
    const unit = `[Unit]
Description=SSIO self-hosted BaaS
After=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${remoteDir}
EnvironmentFile=${remoteDir}/.env
ExecStart=${nodeBin} packages/server/dist/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=${remoteDir}/data
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ssio

[Install]
WantedBy=multi-user.target
`;
    await writeRemote('/etc/systemd/system/ssio.service', unit, { sudo: true, mode: '644' });
    // unmask：上一轮写坏的文件可能让 systemd 把它判为 masked，不解开就装不上
    await sh(
      'systemctl unmask ssio.service; systemctl daemon-reload && systemctl enable ssio && systemctl restart ssio',
      { sudo: true },
    );
  } else {
    await sh(`cd ${remoteDir} && (nohup node packages/server/dist/index.js > ssio.log 2>&1 &) ; sleep 3; echo started`);
  }

  // ---------- 7. 自检 ----------
  console.log('[7/7] 自检');
  await new Promise((r) => setTimeout(r, 4000));
  const ready = await sh(`curl -fsS -m 5 http://127.0.0.1:${ssioPort}/v1/readyz || echo FAIL`, { quiet: true });
  const status = useService ? await sh('systemctl is-active ssio', { quiet: true, sudo: true }) : 'nohup';

  console.log('\n================ 部署结果 ================');
  console.log(`目录      ${remoteDir}`);
  console.log(`服务      ${status.trim()}`);
  console.log(`readyz    ${ready.trim()}`);
  console.log(`本地访问  http://127.0.0.1:${ssioPort}/v1/healthz（服务器上）`);
  console.log(`Master Key ${masterKey}`);
  console.log('------------------------------------------');
  console.log('对外访问需要：① 云安全组放行端口；② 建议用 Nginx/Caddy 反代并开 TLS。');
  console.log('常用命令：systemctl status ssio | systemctl restart ssio | journalctl -u ssio -f');
} finally {
  conn.end();
}

// ---------- helpers ----------

/** 在远端执行一条 shell；sudo 时用密码喂给 sudo -S（key 登录则假定 sudo 免密）。 */
function sh(cmd, opts = {}) {
  const { sudo = false, timeout = 120000, quiet = false } = opts;
  const full = sudo && password ? `echo '${password}' | sudo -S bash -c ${JSON.stringify(cmd)}` : sudo ? `sudo bash -c ${JSON.stringify(cmd)}` : cmd;
  return new Promise((res, rej) => {
    conn.exec(full, { pty: sudo && password ? true : false }, (err, stream) => {
      if (err) return rej(err);
      let out = '';
      let errOut = '';
      stream
        .on('close', (code) => {
          if (!quiet && code !== 0) console.log(`      [warn] exit=${code} :: ${errOut.trim() || out.trim()}`.slice(0, 400));
          res(out);
        })
        .on('data', (d) => {
          out += d.toString();
        });
      stream.stderr.on('data', (d) => {
        errOut += d.toString();
      });
      setTimeout(() => {
        /* 超时交给 stream 自己 close */
      }, timeout);
    });
  });
}

/**
 * 写远端文件：内容 base64 编码后单行传输，绕开 heredoc 在多行/引号/特殊字符上的所有坑。
 * 带 sudo 时用 tee（避免重定向权限问题）。
 */
function writeRemote(path, content, opts = {}) {
  const { sudo = false, mode, owner } = opts;
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const cmd = sudo
    ? `echo '${b64}' | base64 -d | sudo tee ${JSON.stringify(path)} > /dev/null`
    : `echo '${b64}' | base64 -d > ${JSON.stringify(path)}`;
  return sh(cmd, {}).then(() =>
    Promise.all([
      mode ? sh(`sudo chmod ${mode} ${JSON.stringify(path)}`, {}) : null,
      owner ? sh(`sudo chown ${owner}:${owner} ${JSON.stringify(path)}`, {}) : null,
    ].filter(Boolean)),
  );
}

function sftpUpload(conn, local, remote) {
  return new Promise((res, rej) => {
    conn.sftp((err, sftp) => {
      if (err) return rej(err);
      sftp.fastPut(local, remote, (e) => (e ? rej(e) : res(undefined)));
    });
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}


