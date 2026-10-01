import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// base 必须是相对路径：Capacitor 用 file:// 协议加载 dist，绝对路径会取不到资源
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', sourcemap: true },
});
