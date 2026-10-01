import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // 迁移产物只依赖 schema 文件，不需要真实数据库文件
  dbCredentials: { url: './data/ssio.db' },
  strict: true,
  verbose: true,
});
