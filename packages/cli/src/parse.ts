export type Flags = Record<string, string | boolean>;

export interface Parsed {
  /** 位置参数（命令后面的裸词）。 */
  args: string[];
  flags: Flags;
}

/**
 * 极简 argv 解析：`--k v` / `--k=v` / `--flag`（布尔）。
 *
 * 不引第三方 CLI 框架的原因：命令集不大，且 CLI 要能在 `pnpm install --prod` 的
 * 部署环境里直接跑 —— 少一个依赖就少一个装不上的可能。
 */
export function parse(argv: string[]): Parsed {
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      args.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 0) {
      flags[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { args, flags };
}
