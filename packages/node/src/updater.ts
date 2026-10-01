import type { LatestCheckResponse } from '@ssio/shared';
import type { SsioClient } from '@ssio/core';
import { downloadToFile, verifyFile, type DownloadProgress } from './index.js';

export interface UpdaterOptions {
  /**
   * 应用标识（仅用于调用方自查/日志；SSIO 的租户由 APIKey 决定，
   * 这个字段不会发给服务端）。
   */
  app?: string;
  platform: string;
  arch?: string;
  channel?: 'stable' | 'beta' | 'alpha';
  /** 客户端当前版本。 */
  currentVersion: string;
  /** 灰度分桶标识（设备/安装 ID，建议用机器稳定的值）。 */
  clientId?: string;
  /** 下载落盘的默认目录（download 的参数可覆盖）。 */
  downloadDirDefault?: string;
}

export interface UpdaterCheckResult {
  hasUpdate: boolean;
  version?: string;
  notes?: string | null;
  size?: number;
  sha256?: string;
  mandatory?: boolean;
  /** 内部用：直接下载的文件签名 URL（latest 响应自带）。 */
  url?: string;
  releaseId?: string;
}

export interface UpdaterApplyOptions {
  /**
   * - `installer`：Windows 静默执行安装包（/S），Linux 打开下载目录；
   * - `manual`：只把文件路径交还调用方；
   * - `asar`：占位（TaskManager 的 asar 替换流程在 P9 定制）。
   */
  strategy: 'installer' | 'asar' | 'manual';
  /** 是否真的执行安装。默认 false —— 「要不要装」必须由人确认。 */
  autoInstall?: boolean;
  /** 下载落盘目录。 */
  downloadDir?: string;
}

export interface Updater {
  check(): Promise<UpdaterCheckResult>;
  download(
    info: UpdaterCheckResult,
    opts?: { onProgress?: (p: DownloadProgress) => void; downloadDir?: string },
  ): Promise<string>;
  verify(info: UpdaterCheckResult, file: string): Promise<boolean>;
  apply(opts: UpdaterApplyOptions, file: string): Promise<{ applied: boolean; file: string; message: string }>;
}

/**
 * Electron / Node 自动更新执行器。
 *
 * 唯一的原则：**apply 默认不自动执行**。下载、校验都是无副作用动作，
 * 但「替换用户机器上的程序」必须由调用方显式确认（autoInstall: true）。
 */
export function createUpdater(client: SsioClient, cfg: UpdaterOptions): Updater {
  const channel = cfg.channel ?? 'stable';

  return {
    async check(): Promise<UpdaterCheckResult> {
      const res: LatestCheckResponse = await client.releases.latest({
        platform: cfg.platform,
        channel,
        arch: cfg.arch,
        current: cfg.currentVersion,
        clientId: cfg.clientId,
      });
      if (!res.hasUpdate) return { hasUpdate: false };
      return {
        hasUpdate: true,
        version: res.version,
        notes: res.notes,
        size: res.size,
        sha256: res.sha256,
        mandatory: res.mandatory,
        url: res.url,
        releaseId: res.releaseId,
      };
    },

    async download(info, opts = {}): Promise<string> {
      if (!info.hasUpdate || !info.url) throw new Error('没有可下载的更新（先 check 且 hasUpdate 为 true）');
      const dir = opts.downloadDir ?? cfg.downloadDirDefault ?? process.cwd();
      const filename = `update-${info.version ?? 'unknown'}.bin`;
      const dest = `${dir.replace(/[\\/]$/, '')}/${filename}`;
      await downloadToFile(info.url, dest, { expectedSha256: info.sha256, onProgress: opts.onProgress });
      return dest;
    },

    verify(info, file): Promise<boolean> {
      if (!info.sha256) throw new Error('check 结果里没有 sha256，无法校验');
      return verifyFile(file, info.sha256);
    },

    async apply(opts, file): Promise<{ applied: boolean; file: string; message: string }> {
      if (opts.strategy === 'manual' || opts.autoInstall !== true) {
        return {
          applied: false,
          file,
          message: opts.autoInstall === true ? '文件已就绪，等待调用方处理' : '已下载并校验，等待确认后安装（autoInstall 默认 false）',
        };
      }
      if (opts.strategy === 'asar') {
        throw new Error('asar 策略未实现：属于 TaskManager 的定制替换流程（P9）');
      }
      // installer：Windows 用 NSIS 的 /S 静默安装；其它平台把路径交还调用方
      if (process.platform === 'win32') {
        const { spawn } = await import('node:child_process');
        // detached + stdio ignore：安装器接管机器后自己收尾，宿主进程退出不影响它
        const child = spawn(file, ['/S'], { detached: true, stdio: 'ignore' });
        child.unref();
        return { applied: true, file, message: '已静默启动安装器（/S）' };
      }
      return { applied: false, file, message: `非 Windows 平台请手动执行：${file}` };
    },
  };
}
