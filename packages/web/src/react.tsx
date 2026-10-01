import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AnnouncementRecord } from '@ssio/shared';
import type { SsioWebClient, UploadOptions, UploadProgress } from './index.js';

/**
 * React hooks（子路径 @ssio/web/react）。
 *
 * 放子路径而不是独立包的原因：SsioProvider/useUpload 与 client 的耦合只在类型层面，
 * 子路径 + optional peerDependency 就能让「不用 React 的消费方」零成本；独立包
 * 反而多一层版本同步负担（两个包版本不一致的坑比 peerDep 复杂度更疼）。
 */
const Ctx = createContext<SsioWebClient | null>(null);

export function SsioProvider({ client, children }: { client: SsioWebClient; children: ReactNode }) {
  return <Ctx.Provider value={client}>{children}</Ctx.Provider>;
}

export function useSsio(): SsioWebClient {
  const client = useContext(Ctx);
  if (!client) throw new Error('useSsio 必须在 <SsioProvider> 内使用');
  return client;
}

export type UploadStatus = 'idle' | 'uploading' | 'done' | 'error';

export interface UseUploadResult {
  progress: UploadProgress | null;
  status: UploadStatus;
  error: Error | null;
  result: { fileId: string; sha256: string; sizeBytes: number } | null;
  upload: (file: File | Blob, opts?: UploadOptions) => Promise<void>;
  reset: () => void;
}

export function useUpload(defaults: UploadOptions = {}): UseUploadResult {
  const client = useSsio();
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<UseUploadResult['result']>(null);

  const upload = useCallback(
    async (file: File | Blob, opts: UploadOptions = {}) => {
      setStatus('uploading');
      setError(null);
      setResult(null);
      try {
        const done = await client.upload(file, {
          ...defaults,
          ...opts,
          onProgress: (p) => {
            setProgress(p);
            opts.onProgress?.(p);
          },
        });
        setResult({ fileId: done.fileId, sha256: done.sha256, sizeBytes: done.sizeBytes });
        setStatus('done');
      } catch (e) {
        setError(e instanceof Error ? e : new Error(String(e)));
        setStatus('error');
      }
    },
    [client, defaults],
  );

  const reset = useCallback(() => {
    setProgress(null);
    setStatus('idle');
    setError(null);
    setResult(null);
  }, []);

  return { progress, status, error, result, upload, reset };
}

export interface UseAnnouncementsResult {
  items: AnnouncementRecord[];
  loading: boolean;
  error: Error | null;
  /** 手动刷新（公告是运营内容，拉新频率交给消费方）。 */
  reload: () => void;
}

export function useAnnouncements(onlyActive = true): UseAnnouncementsResult {
  const client = useSsio();
  const [items, setItems] = useState<AnnouncementRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // reload 用递增 tick 触发 effect；放 ref 里避免它成为依赖
  const tickRef = useRef(0);
  const [, forceTick] = useState(0);

  const reload = useCallback(() => {
    tickRef.current += 1;
    forceTick((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = onlyActive ? client.announcements.active() : client.announcements.list();
    load
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // tickRef.current 只作 reload 计数；仅当 client/onlyActive/tick 变化时重拉
  }, [client, onlyActive, tickRef.current]);

  return { items, loading, error, reload };
}
