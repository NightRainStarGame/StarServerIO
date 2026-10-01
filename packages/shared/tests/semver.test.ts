import { describe, expect, it } from 'vitest';
import { compare, format, isValid, parse, satisfiesRange, SemVerError } from '../src/semver.js';

describe('parse / format', () => {
  it('补齐缺失的 minor/patch', () => {
    expect(parse('1')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: [] });
    expect(parse('1.2')).toEqual({ major: 1, minor: 2, patch: 0, prerelease: [] });
    expect(parse('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
  });

  it('解析预发布与构建元数据', () => {
    expect(parse('1.0.0-beta.1').prerelease).toEqual(['beta', '1']);
    // 构建元数据参与合法性校验但不参与比较
    expect(parse('1.0.0+build.5')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: [] });
    expect(format(parse('1.0.0-beta.1'))).toBe('1.0.0-beta.1');
  });

  it('非法版本抛 SemVerError', () => {
    expect(() => parse('abc')).toThrow(SemVerError);
    expect(() => parse('1.2.3.4')).toThrow(SemVerError);
    expect(isValid('1.2.3')).toBe(true);
    expect(isValid('1.2.x')).toBe(false);
  });
});

describe('compare', () => {
  it('按 major/minor/patch 逐级比较', () => {
    expect(compare('1.0.0', '2.0.0')).toBe(-1);
    expect(compare('1.2.0', '1.1.9')).toBe(1);
    expect(compare('1.2.3', '1.2.3')).toBe(0);
    expect(compare('0.0.1', '0.0.2')).toBe(-1);
  });

  it('预发布版本低于同版本正式版', () => {
    expect(compare('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compare('1.0.0', '1.0.0-beta.1')).toBe(1);
    expect(compare('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compare('1.0.0-alpha.1', '1.0.0-alpha.2')).toBe(-1);
    // 数字标识符优先级低于字母标识符
    expect(compare('1.0.0-alpha.2', '1.0.0-alpha.beta')).toBe(-1);
    // 段数少的更小
    expect(compare('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
  });
});

describe('satisfiesRange', () => {
  it('精确版本', () => {
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true);
    expect(satisfiesRange('1.2.4', '1.2.3')).toBe(false);
    expect(satisfiesRange('1.2.3', '=1.2.3')).toBe(true);
  });

  it('^ 插入符', () => {
    expect(satisfiesRange('1.2.3', '^1.2.0')).toBe(true);
    expect(satisfiesRange('1.9.9', '^1.2.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.2.0')).toBe(false);
    expect(satisfiesRange('1.1.9', '^1.2.0')).toBe(false);
    // 0.x 的 ^ 只锁 minor
    expect(satisfiesRange('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false);
    // 0.0.x 的 ^ 锁死 patch
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false);
    // 省略位
    expect(satisfiesRange('1.5.0', '^1.2')).toBe(true);
    expect(satisfiesRange('1.0.0', '^1')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1')).toBe(false);
  });

  it('~ 波浪符', () => {
    expect(satisfiesRange('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfiesRange('1.2.9', '~1.2')).toBe(true);
    expect(satisfiesRange('1.3.0', '~1.2')).toBe(false);
    // ~1 只锁 major
    expect(satisfiesRange('1.9.9', '~1')).toBe(true);
    expect(satisfiesRange('2.0.0', '~1')).toBe(false);
  });

  it('比较运算符与多 token 区间', () => {
    expect(satisfiesRange('1.5.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfiesRange('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfiesRange('0.9.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfiesRange('1.0.0', '>1.0.0')).toBe(false);
    expect(satisfiesRange('1.0.1', '>1.0.0')).toBe(true);
    expect(satisfiesRange('1.0.0', '<=1.0.0')).toBe(true);
  });

  it('* 与空 range 接受任意版本', () => {
    expect(satisfiesRange('9.9.9', '*')).toBe(true);
    expect(satisfiesRange('9.9.9', '')).toBe(true);
  });

  it('预发布版本不会被稳定 range 命中（避免 beta 推给稳定渠道）', () => {
    expect(satisfiesRange('1.3.0-beta.1', '^1.2.0')).toBe(false);
    expect(satisfiesRange('1.3.0-beta.1', '>=1.0.0 <2.0.0')).toBe(false);
    // 显式写出同三元组的预发布才放行
    expect(satisfiesRange('1.3.0-beta.1', '^1.3.0-beta.1')).toBe(true);
    expect(satisfiesRange('1.3.0-beta.2', '^1.3.0-beta.1')).toBe(true);
  });

  it('非法输入抛错而非静默通过', () => {
    expect(() => satisfiesRange('1.2.3', '^abc')).toThrow(SemVerError);
    expect(() => satisfiesRange('abc', '^1.0.0')).toThrow(SemVerError);
  });
});
