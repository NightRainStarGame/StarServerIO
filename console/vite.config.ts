import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 控制台是纯静态站点，靠服务端的 CORS 直连 API（默认 CORS_ORIGIN=*）。
 * dev 下给的 proxy 只是图方便：填相对地址也能用。
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: process.env.SSIO_URL ?? 'http://127.0.0.1:8100',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
