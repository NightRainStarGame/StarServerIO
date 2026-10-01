import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * API 文档生成（P6）：文档必须从源码提取，且漂移能被检测出来。
 *
 * 这里跑的是脚本本体（子进程），不是 import 内部函数 —— 因为要验证的正是
 * 「命令行能跑通 + 退出码正确」，这是 CI 依赖的契约。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const script = join(repoRoot, 'scripts', 'gen-api-docs.mjs');
const docPath = join(repoRoot, 'docs', '03-API参考.md');

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('API 文档生成', () => {
  it('文档与源码一致（--check 通过）', () => {
    const res = run(['--check']);
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toContain('一致');
  });

  it('覆盖了各模块的代表性路由', () => {
    const md = readFileSync(docPath, 'utf8');
    for (const route of [
      '/v1/storage/uploads',
      '/v1/storage/quota',
      '/v1/releases/latest',
      '/v1/cards/redeem',
      '/v1/announcements/active',
      '/v1/auth/refresh',
    ]) {
      expect(md, `文档里缺 ${route}`).toContain(route);
    }
    // 每条路由都得有鉴权说明，不允许出现「未识别」
    expect(md).not.toContain('未识别');
    // 表格行数应与路由总数对得上（标题 + 分隔行 + 数据行）
    const rows = md.split('\n').filter((l) => l.startsWith('| ') && !l.includes('|---'));
    expect(rows.length).toBeGreaterThan(40);
  });

  it('文档被手改后 --check 会失败（防漂移真的生效）', () => {
    const original = readFileSync(docPath, 'utf8');
    try {
      writeFileSync(docPath, `${original}\n| DELETE | \`/v1/手写路由\` | Master Key |\n`, 'utf8');
      const res = run(['--check']);
      expect(res.status, '手改后的文档应该被判为不一致').toBe(1);
      expect(res.stderr).toContain('不一致');
    } finally {
      writeFileSync(docPath, original, 'utf8');
    }
    // 还原后必须重新通过
    expect(run(['--check']).status).toBe(0);
  });
});
