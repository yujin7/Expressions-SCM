"use client";

/**
 * 制单时间窗筛选芯片（BH / WO / SH 列表共用）。
 *
 * 全链达成漏斗（`/report/funnel`）的「计划 / 下单 / 到货」三级点数字后带 `?from=&to=` 跳到这三个列表。
 * 若列表不把窗口显示出来，用户看到的是一张「行数莫名其妙变少」的列表——比不跳转更糟。
 * 因此：窗口生效时必须可见、可一键清除，并说明口径是**单据创建时间**（上海业务日，含首尾）。
 */
import { Tag, Tooltip } from "antd";

export default function DocWindowFilterTag({
  from,
  to,
  onClear,
}: {
  from: string;
  to: string;
  onClear: () => void;
}) {
  if (!from && !to) return null;
  return (
    <Tooltip title="口径：单据创建时间（Asia/Shanghai 业务日，含首尾）。来自全链达成漏斗的回链，可一键清除看全量。">
      <Tag color="blue" closable onClose={onClear}>
        制单时间窗 {from || "不限"} ~ {to || "不限"}
      </Tag>
    </Tooltip>
  );
}
