import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

/** 服务端版本号，取自 package.json（发版由 CI 统一 bump，避免硬编码漂移）。 */
export const VERSION: string = pkg.version;
