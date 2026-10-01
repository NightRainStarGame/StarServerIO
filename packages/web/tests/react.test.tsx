// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClientOptions } from '@ssio/core';
import { createWebClient, type SsioWebClient } from '../src/index.js';
import { SsioProvider, useAnnouncements, useSsio, useUpload } from '../src/react.js';

// React 18 需要 act 环境标记
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function mockClient(routes: Record<string, unknown>): SsioWebClient {
  const fetchImpl: NonNullable<ClientOptions['fetchImpl']> = (input) => {
    const path = new URL(input, 'http://ssio.test').pathname;
    return Promise.resolve(
      new Response(JSON.stringify(routes[path] ?? []), { headers: { 'content-type': 'application/json' } }),
    );
  };
  return createWebClient({
    baseUrl: 'http://ssio.test',
    fetchImpl,
    storage: { get: () => null, set: () => {}, remove: () => {} },
  });
}

const roots: Array<() => void> = [];
afterEach(() => {
  roots.forEach((unmount) => unmount());
  roots.length = 0;
});

function mount(client: SsioWebClient, children: React.ReactNode): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  roots.push(() => {
    void createRoot(el);
    el.remove();
  });
  act(() => {
    const root: Root = createRoot(el);
    roots.push(() => root.unmount());
    root.render(<SsioProvider client={client}>{children}</SsioProvider>);
  });
  return el;
}

describe('React hooks', () => {
  it('useSsio 在 Provider 外使用 → 抛错', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    roots.push(() => el.remove());
    const Bad = (): null => {
      useSsio();
      return null;
    };
    expect(() =>
      act(() => {
        const root = createRoot(el);
        roots.push(() => root.unmount());
        root.render(<Bad />);
      }),
    ).toThrow(/SsioProvider/);
  });

  it('useAnnouncements 渲染生效中的公告', async () => {
    const client = mockClient({
      '/v1/announcements/active': [
        { id: 'a1', appId: 'x', title: '停机维护', contentMd: '今晚', level: 'warning', pinned: true, startAt: 1, endAt: null, createdBy: null, createdAt: 1 },
        { id: 'a2', appId: 'x', title: '新版本发布', contentMd: 'v2', level: 'info', pinned: false, startAt: 1, endAt: null, createdBy: null, createdAt: 1 },
      ],
    });
    const Probe = (): JSX.Element => {
      const { items, loading } = useAnnouncements();
      return loading ? <p>loading</p> : <ul>{items.map((a) => <li key={a.id}>{a.title}</li>)}</ul>;
    };

    const el = mount(client, <Probe />);
    // 等异步 effect 完成
    await act(async () => {});
    expect(el.querySelectorAll('li').length).toBe(2);
    expect(el.textContent).toContain('停机维护');
    expect(el.textContent).toContain('新版本发布');
  });

  it('useUpload 状态机：idle → done，拿到 fileId', async () => {
    const client = mockClient({});
    // 上传链路整体 mock：状态机只关心 upload() 的成功形态
    (client as { upload: unknown }).upload = () =>
      Promise.resolve({ fileId: 'f9', sizeBytes: 1024, sha256: 'a'.repeat(64), dedup: false });

    let trigger: (() => void) | null = null;
    const Probe = (): JSX.Element => {
      const u = useUpload();
      trigger = () => void u.upload(new Blob([new Uint8Array(1024)]));
      return (
        <div>
          <span data-testid="status">{u.status}</span>
          <span data-testid="file">{u.result?.fileId ?? ''}</span>
        </div>
      );
    };

    const el = mount(client, <Probe />);
    expect(el.querySelector('[data-testid="status"]')!.textContent).toBe('idle');

    await act(async () => {
      trigger!();
    });
    expect(el.querySelector('[data-testid="status"]')!.textContent).toBe('done');
    expect(el.querySelector('[data-testid="file"]')!.textContent).toBe('f9');
  });
});
