/** 终端输出：默认表格，`--json` 时输出原始 JSON（便于管道与脚本消费）。 */

export interface Out {
  /** 表格：表头 + 行。 */
  table(headers: string[], rows: string[][]): void;
  /** 单行信息。 */
  info(message: string): void;
  /** JSON 直通。 */
  json(value: unknown): void;
  error(message: string): void;
}

export function createOut(jsonMode: boolean): Out & {
  /** 测试用：收集已输出内容。 */
  lines: string[];
} {
  const lines: string[] = [];
  const emit = (text: string): void => {
    lines.push(text);
    // CLI 的 stdout 就是它的产物
    // eslint-disable-next-line no-console
    console.log(text);
  };

  return {
    lines,
    table(headers, rows) {
      if (jsonMode) {
        emit(JSON.stringify(rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])))));
        return;
      }
      // 列宽按内容算，中文按 2 列宽计（否则中文表会错位）
      const width = (s: string): number => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
      const cols = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))));
      const pad = (s: string, i: number): string => s + ' '.repeat(Math.max(0, cols[i]! - width(s)));
      emit(headers.map((h, i) => pad(h, i)).join('  '));
      emit(cols.map((w) => '-'.repeat(w)).join('  '));
      for (const row of rows) emit(row.map((c, i) => pad(c ?? '', i)).join('  '));
    },
    info(message) {
      if (jsonMode) return;
      emit(message);
    },
    json(value) {
      emit(JSON.stringify(value, null, 2));
    },
    error(message) {
      lines.push(message);
       
      console.error(message);
    },
  };
}
