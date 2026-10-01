import { createClient, type SsioClient } from '@ssio/core';
import type { AppRecord } from '@ssio/shared';
import { loadConfig, resolveMasterKey, resolveUrl, type CliConfig } from './config.js';

/**
 * CLI 的两条通道：
 * - Master（X-Master-Key）：建应用、签发/吊销 Key、发卡批次 —— 平台级操作
 * - APIKey（X-API-Key）：发版、公告、存储 —— 应用级操作，按 slug 取配置里的 Key
 *
 * 业务命令一律走 APIKey 通道，是为了让 CLI 的行为与真实客户端一致
 * （权限、scope、限流都按 APIKey 来），Master 只用于管理面。
 */
export interface MasterClient extends SsioClient {
  /** Master 通道请求。query 用于 `?appId=` 这类参数（发卡接口 Master 通道必须带）。 */
  masterRequest<T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T>;
}

export interface Ctx {
  config: CliConfig;
  url: string;
  master(): MasterClient;
  /** 按 slug 取应用级 client，找不到就抛可读的错误。 */
  appClient(slug: string): Promise<{ client: SsioClient; app: AppRecord }>;
}

export function createCtx(config: CliConfig = loadConfig()): Ctx {
  const url = resolveUrl(config);

  function master(): MasterClient {
    const masterKey = resolveMasterKey(config);
    if (!masterKey) {
      throw new Error('缺少 Master Key。先跑：ssio config set --master-key <key>（或用环境变量 SSIO_MASTER_KEY）');
    }
    const client = createClient({ baseUrl: url });
    // Object.assign 的推断对泛型方法不友好，这里显式断言到 MasterClient
    return Object.assign(client, {
      masterRequest: <T>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> => {
        const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
        return client.request<T>(method, `${path}${qs}`, { body, headers: { 'X-Master-Key': masterKey } });
      },
    }) as MasterClient;
  }

  async function appClient(slug: string): Promise<{ client: SsioClient; app: AppRecord }> {
    const entry = config.apps[slug];
    if (!entry?.apiKey) {
      throw new Error(
        `配置里没有应用 ${slug} 的 APIKey。先跑：ssio key issue --app ${slug} --scopes release:write,release:read`,
      );
    }
    const apps = await master().masterRequest<AppRecord[]>('GET', '/v1/apps');
    const app = apps.find((a) => a.slug === slug);
    if (!app) throw new Error(`应用不存在：${slug}`);
    return { client: createClient({ baseUrl: url, apiKey: entry.apiKey }), app };
  }

  return { config, url, master, appClient };
}
