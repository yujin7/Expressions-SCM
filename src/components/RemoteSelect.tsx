"use client";

import { useEffect, useMemo, useState } from "react";
import { Select } from "antd";
import type { SelectProps } from "antd";

export type RemoteRow = Record<string, unknown> & { id: number };

export interface RemoteSelectProps extends Omit<SelectProps, "options" | "children"> {
  /** 列表接口（可带查询串），组件自动附加 page=1&pageSize=999 */
  api: string;
  getLabel: (row: RemoteRow) => string;
  filterRow?: (row: RemoteRow) => boolean;
}

/** 下拉选项来自主数据列表接口的通用 Select（前端本地搜索） */
export default function RemoteSelect({ api, getLabel, filterRow, ...rest }: RemoteSelectProps) {
  const [rows, setRows] = useState<RemoteRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`${api}${api.includes("?") ? "&" : "?"}page=1&pageSize=999`)
      .then((r) => r.json())
      .then((body: { data?: RemoteRow[] }) => {
        if (!cancelled) setRows(body.data ?? []);
      })
      .catch(() => {
        /* 下拉加载失败时保持空选项 */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const options = useMemo(
    () =>
      (filterRow ? rows.filter(filterRow) : rows).map((row) => ({
        label: getLabel(row),
        value: row.id,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, filterRow],
  );

  return <Select showSearch optionFilterProp="label" loading={loading} options={options} {...rest} />;
}
