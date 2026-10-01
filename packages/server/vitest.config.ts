import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 测试直接吃 shared 的源码：避免依赖 shared 的构建产物过期导致「改了不生效」
    // （运行时仍走 node_modules → @ssio/shared 的 dist，由 pnpm build 产出）
    alias: {
      '@ssio/shared': new URL('../shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
