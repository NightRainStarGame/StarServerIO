#!/usr/bin/env node
/**
 * ssio —— SSIO 命令行运维工具。
 *
 *   ssio config set --url http://127.0.0.1:8100 --master-key <key>
 *   ssio app create myapp --name "我的应用"
 *   ssio key issue --app myapp --scopes release:write,release:read,storage:write
 *   ssio release publish --app myapp --version 1.2.3 --file ./Setup.exe
 *   ssio release list --app myapp
 *   ssio card batch --app myapp --total 100 --days 30
 *   ssio announce post --app myapp --title "停服维护" --content-md "..." --pinned
 *   ssio quota --app myapp
 *
 * 所有命令都支持 `--json`（输出原始 JSON，便于管道消费）。
 */
 
import { SsioError } from '@ssio/core';
import { createCtx } from './client.js';
import { loadConfig } from './config.js';
import * as admin from './commands/admin.js';
import * as biz from './commands/biz.js';
import { createOut } from './format.js';
import { parse } from './parse.js';

const USAGE = `用法：ssio <命令> [子命令] [选项]

配置
  config set --url <url> --master-key <key>     写入 ~/.ssio/config.json（权限 0600）
  config show                                   查看当前配置（密钥掩码）

应用与 Key（Master 通道）
  app list | app create <slug> [--name <n>] [--quota-mb <n>]
  key issue --app <slug> --scopes a,b [--name <n>] [--no-save]
  key list | key revoke <keyId>

发行（APIKey 通道）
  release publish --app <slug> --version <x.y.z> --file <path>
                  [--channel stable|beta|alpha] [--platform win|linux|android|any] [--arch x64|arm64|any]
                  [--notes <md>] [--min-version <v>] [--rollout <0-100>] [--mandatory] [--draft]
  release list --app <slug> [--channel stable]
  release yank <releaseId> --app <slug>
  release latest --app <slug> --platform win [--current <v>] [--client-id <id>]

卡密（Master 通道）
  card batch --app <slug> [--total 100] [--days 30] [--prefix <p>] [--payload '<json>']
  card export <batchId> --out cards.csv

公告与配额
  announce post --app <slug> --title <t> --content-md <md> [--pinned] [--level info]
  announce list --app <slug> [--active]
  quota --app <slug>

通用：--json 输出 JSON；环境变量 SSIO_URL / SSIO_MASTER_KEY 优先于配置文件。`;

type Handler = () => Promise<void>;

/** 命令分发：返回 null 表示不认识这条命令（调用方打印 usage）。 */
export async function run(argv: string[]): Promise<number> {
  const { args, flags } = parse(argv);
  const json = flags.json === true;
  const out = createOut(json);
  const ctx = createCtx(loadConfig());

  const [group, sub] = args;
  const rest = args.slice(2);

  let handler: Handler | null = null;
  switch (group) {
    case 'config':
      handler = sub === 'set' ? () => admin.configSet(ctx, out, flags) : sub === 'show' ? () => admin.configShow(ctx, out) : null;
      break;
    case 'app':
      handler = sub === 'list' ? () => admin.appList(ctx, out) : sub === 'create' ? () => admin.appCreate(ctx, out, rest, flags) : null;
      break;
    case 'key':
      handler =
        sub === 'issue'
          ? () => admin.keyIssue(ctx, out, flags)
          : sub === 'list'
            ? () => admin.keyList(ctx, out)
            : sub === 'revoke'
              ? () => admin.keyRevoke(ctx, out, rest)
              : null;
      break;
    case 'release':
      handler =
        sub === 'publish'
          ? () => biz.releasePublish(ctx, out, flags)
          : sub === 'list'
            ? () => biz.releaseList(ctx, out, flags)
            : sub === 'yank'
              ? () => biz.releaseYank(ctx, out, rest, flags)
              : sub === 'latest'
                ? () => biz.releaseLatest(ctx, out, flags)
                : null;
      break;
    case 'card':
      handler = sub === 'batch' ? () => biz.cardBatch(ctx, out, flags) : sub === 'export' ? () => biz.cardExport(ctx, out, rest, flags) : null;
      break;
    case 'announce':
      handler = sub === 'post' ? () => biz.announcePost(ctx, out, flags) : sub === 'list' ? () => biz.announceList(ctx, out, flags) : null;
      break;
    case 'quota':
      handler = () => biz.quotaShow(ctx, out, flags);
      break;
    default:
      handler = null;
  }

  if (!handler) {
    console.error(USAGE);
    return 1;
  }

  try {
    await handler();
    return 0;
  } catch (e) {
    if (e instanceof SsioError) {
      const status = (e as { status?: number }).status;
      console.error(`[${e.code}] ${e.message}${status ? ` (HTTP ${status})` : ''}`);
    } else {
      console.error(e instanceof Error ? e.message : String(e));
    }
    return 1;
  }
}

// 直接被 node 执行时才跑；被 import（测试）时不跑
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}
