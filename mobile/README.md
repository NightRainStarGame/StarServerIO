# SSIO 移动端壳（Capacitor + React）

这个 App 的存在意义不是"做一个产品"，而是**验证 `@ssio/web` 在真机 WebView 里能用** ——
localStorage 持久化、并发分片上传、弱网下的重试与 401 自动续期，这些在 Node 环境里测不出来。
所以功能刻意做得很薄：配置 → 更新检查 → 公告 → 卡密核销。

## 开发

```bash
pnpm --filter @ssio/mobile dev     # 浏览器里跑（localhost:5173）
```

## 打包 APK

```bash
pnpm --filter @ssio/mobile build          # 产出 dist/
npx cap add android                       # 首次：生成 android/ 平台目录（需已装 Android SDK）
pnpm --filter @ssio/mobile cap:sync       # 之后每次改代码：build + 同步到 android/
npx cap open android                      # 用 Android Studio 打开并构建
```

> **本仓库的开发环境没有 Android SDK，APK 从未真正构建过。**
> 已验证的部分：`tsc --noEmit` + `vite build`（151 KB / gzip 50 KB，含完整 SDK），
> 也就是"网页产物与 SDK 打包链路"是通的；Gradle 打包与真机运行没验过。

## 真机上必踩的两个坑

1. **Android 9+ 默认禁止明文 HTTP**。服务端若还没上 TLS，要在
   `android/app/src/main/AndroidManifest.xml` 的 `<application>` 上开
   `android:usesCleartextTraffic="true"`，或配 `network_security_config.xml` 只放行自己的域名。
2. **模拟器访问宿主的地址是 `10.0.2.2`**（不是 localhost）。真机调试要写电脑的局域网 IP，
   且服务端的 `CORS_ORIGIN` 得放行（默认 `*` 是放行的）。

## 灰度标识的含义

`clientId` 在首次启动时生成、存 localStorage，**卸载重装就会变**。
这是刻意的：灰度按「安装」分桶而不是按账号，换新装的机器等于重新进桶。
若要按用户分桶，把它换成用户 ID 即可（服务端只当字符串哈希，不关心语义）。
