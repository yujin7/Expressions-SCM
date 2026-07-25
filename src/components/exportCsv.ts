/**
 * 轻量 CSV 导出（<5000 行列表页内联下载；大表仍走异步导出任务——DoD 口径）。
 *
 * 与服务端 `server/modules/report/export.ts` 的 toCsv 保持同一套转义与行尾：
 * - 转义判据含 `\r`：只判 `\n` 的话，值里带回车（Excel 单元格内换行、
 *   从别处粘进来的备注）不会被加引号，CSV 会在那一格断行、整份文件错位；
 * - 行尾用 CRLF：服务端导出一直是 CRLF，两边不一致会让同一份数据
 *   在两条导出路径下表现不同。
 *
 * `truncatedNote` 用于**把截断说出来**：几个报表页在浏览器里串行翻页取数，
 * 跑满页数上限后此前直接下载，用户拿到的是一份「看起来完整」的残缺 CSV。
 */
export function exportCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
  truncatedNote?: string,
): void {
  const esc = (v: string | number | null | undefined): string => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = truncatedNote ? [...rows, [truncatedNote]] : rows;
  const csv = "﻿" + [headers, ...body].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
