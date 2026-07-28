"use client";

import { useEffect, useMemo, useState } from "react";
import { Select } from "antd";
import type { SelectProps } from "antd";

export type RemoteRow = Record<string, unknown> & { id: number };

export interface RemoteSelectProps extends Omit<SelectProps, "options" | "children"> {
  /** 列表接口（可带查询串），组件自动附加 page=1&pageSize=999 */
  api: string;
  getLabel: (row: RemoteRow) => string;
  /** 选项值取数（缺省 row.id）——需要编码等业务键时传入 */
  getValue?: (row: RemoteRow) => string | number;
  filterRow?: (row: RemoteRow) => boolean;
}

const CACHE_TTL_MS = 30_000;
const rowCache = new Map<string, { rows: RemoteRow[]; expiresAt: number }>();
const inflight = new Map<string, Promise<RemoteRow[]>>();

function cachedRows(api: string): RemoteRow[] | undefined {
  const entry = rowCache.get(api);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    rowCache.delete(api);
    return undefined;
  }
  return entry.rows;
}

async function loadRows(api: string): Promise<RemoteRow[]> {
  const cached = cachedRows(api);
  if (cached) return cached;
  const pending = inflight.get(api);
  if (pending) return pending;
  const request = fetch(`${api}${api.includes("?") ? "&" : "?"}page=1&pageSize=999`)
    .then(async (response) => {
      if (!response.ok) throw new Error(`RemoteSelect ${response.status}`);
      const body = (await response.json()) as { data?: RemoteRow[] };
      const rows = body.data ?? [];
      rowCache.set(api, { rows, expiresAt: Date.now() + CACHE_TTL_MS });
      return rows;
    })
    .finally(() => inflight.delete(api));
  inflight.set(api, request);
  return request;
}

/** 下拉选项来自主数据列表接口的通用 Select（前端本地搜索） */
export default function RemoteSelect({ api, getLabel, getValue, filterRow, ...rest }: RemoteSelectProps) {
  const [rows, setRows] = useState<RemoteRow[]>(() => cachedRows(api) ?? []);
  const [loading, setLoading] = useState(() => cachedRows(api) === undefined);

  useEffect(() => {
    let cancelled = false;
    const cached = cachedRows(api);
    if (cached) {
      setRows(cached);
      setLoading(false);
      return;
    }
    setRows([]);
    setLoading(true);
    void loadRows(api)
      .then((loaded) => {
        if (!cancelled) setRows(loaded);
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
        value: getValue ? getValue(row) : row.id,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 标签函数仅影响显示，调用方应提供稳定引用以避免重建全部选项
    [rows, filterRow, getValue],
  );

  return <Select showSearch optionFilterProp="label" loading={loading} options={options} {...rest} />;
}
