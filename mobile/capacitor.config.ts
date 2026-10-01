import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 配置。
 *
 * 关于 `server.url`：留空表示加载打包进 App 的 `dist/`（离线可用）。
 * 开发期想连本机 dev server 时再打开它，但要注意 —— 真机上的 localhost 指的是
 * 手机自己，必须写电脑的局域网 IP，且服务端 CORS 要放行。
 */
const config: CapacitorConfig = {
  appId: 'io.ssio.mobile',
  appName: 'SSIO Mobile',
  webDir: 'dist',
  // 网页里所有请求都发往配置的 SSIO 地址（不是相对路径），所以不需要额外代理
  android: {
    allowMixedContent: false,
  },
};

export default config;
