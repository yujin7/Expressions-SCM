/**
 * CSV 读取（只服务「导出 → 线下填 → 导回」这一条回路）。
 *
 * 为什么要它：`/master/supply-params` 的导出是 CSV（前端 `components/exportCsv`），
 * 业务在 Excel/WPS 里填完最自然的另存仍是 CSV。若上传只收 .xlsx，
 * 这条自助回路就断在最后一步，等于又回到「只有那两份供应商工作簿能进系统」。
 *
 * 输出与 `parse/xlsx.readWorkbook` 同一个 `WorkbookData` 形状，
 * 让模板指纹校验（template-contract）和适配器不必分两套代码。
 *
 * 解析口径：RFC4180 子集——逗号分隔、双引号包裹、`""` 转义引号、支持字段内换行；
 * 去 UTF-8 BOM；CRLF/LF 都认。数值不在此层转换（各适配器按列语义用 toNumberTolerant）。
 */
import { readFileSync } from "node:fs";
import type { CellValue, WorkbookData } from "./xlsx";

export function parseCsv(text: string): CellValue[][] {
  const src = text.replace(/^﻿/, "");
  const rows: CellValue[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false; // 该字段是否已经开始（用来区分 "" 空串与真正的空单元格）

  const endField = (): void => {
    row.push(field);
    field = "";
    started = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row.map((v) => (v === "" ? null : v)));
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && !started) {
      quoted = true;
      started = true;
      continue;
    }
    if (c === ",") {
      endField();
      continue;
    }
    if (c === "\r") {
      if (src[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    if (c === "\n") {
      endRow();
      continue;
    }
    field += c;
    started = true;
  }
  // 末尾没有换行时补最后一行；纯尾随换行不产生空行
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/** 把一个 CSV 文件读成单页工作簿；页名由调用方给（与模板契约的页名一致） */
export function readCsvWorkbook(filePath: string, sheetName: string): WorkbookData {
  const rows = parseCsv(readFileSync(filePath, "utf8"));
  return { sheets: [{ name: sheetName, rows, hidden: false }], channel: "ooxml" };
}
