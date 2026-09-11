"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Select } from "antd";
import type { SelectProps } from "antd";
import {
  mergeRemoteRows, readRemotePage, remoteListUrl, remoteOptions, remoteValueKey,
  selectedRemoteValues, selectedValueBatches,
  type RemoteRow, type RemoteValue,
} from "@/lib/remote-select";

export type { RemoteRow } from "@/lib/remote-select";
export interface RemoteSelectProps extends Omit<SelectProps, "options" | "children"> {
  /** 列表接口（保留固定筛选），服务端搜索，每次最多读取 50 条候选。 */
  api: string;
  getLabel: (row: RemoteRow) => string;
  getValue?: (row: RemoteRow) => RemoteValue;
  filterRow?: (row: RemoteRow) => boolean;
}

type ListState = { scope: string; rows: RemoteRow[]; total: number; page: number; loading: boolean; error: boolean };
type SelectedState = { scope: string; rows: RemoteRow[]; incomplete: string[]; loading: boolean; error: boolean };
const rowId = (row: RemoteRow) => row.id;

async function fetchPage(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Option request failed (${response.status})`);
  return readRemotePage(await response.json());
}

/** Bounded remote search + explicit pagination; selected labels use scoped exact lookups. */
export default function RemoteSelect({ api, getLabel, getValue = rowId, filterRow, ...rest }: RemoteSelectProps) {
  const [search, setSearch] = useState({ api, value: "" });
  const [hasOpened, setHasOpened] = useState(Boolean(rest.defaultOpen || rest.open));
  const enabled = hasOpened || Boolean(rest.open);
  const [uncontrolledValue, setUncontrolledValue] = useState<unknown>(rest.defaultValue);
  const query = rest.searchValue ?? (search.api === api ? search.value : "");
  const scope = JSON.stringify([api, query]);
  const valuesKey = JSON.stringify(selectedRemoteValues("value" in rest ? rest.value : uncontrolledValue));
  const selectedScope = JSON.stringify([api, valuesKey]);
  const [list, setList] = useState<ListState>({ scope: "", rows: [], total: 0, page: 0, loading: true, error: false });
  const [selected, setSelected] = useState<SelectedState>({ scope: "", rows: [], incomplete: [], loading: false, error: false });
  const [selectedRetry, setSelectedRetry] = useState(0);
  const [remembered, setRemembered] = useState<{ api: string; rows: RemoteRow[] }>({ api, rows: [] });
  const listRequest = useRef<{ generation: number; controller?: AbortController; scope?: string; page?: number; pending?: boolean }>({ generation: 0 });
  const selectionRequest = useRef(0);
  const activeList = useRef(list);
  activeList.current = list;

  useEffect(() => {
    setSearch((previous) => previous.api === api ? previous : { api, value: "" });
  }, [api]);

  const load = useCallback(async (page: number) => {
    if (listRequest.current.pending && !listRequest.current.controller?.signal.aborted
      && listRequest.current.scope === scope && listRequest.current.page === page) return;
    listRequest.current.controller?.abort();
    const controller = new AbortController();
    const generation = ++listRequest.current.generation;
    listRequest.current.controller = controller;
    listRequest.current.scope = scope;
    listRequest.current.page = page;
    listRequest.current.pending = true;
    setList((previous) => ({
      scope, rows: page > 1 && previous.scope === scope ? previous.rows : [],
      total: page > 1 && previous.scope === scope ? previous.total : 0,
      page: page - 1, loading: true, error: false,
    }));
    try {
      const result = await fetchPage(remoteListUrl(api, page, query), controller.signal);
      if (controller.signal.aborted || generation !== listRequest.current.generation) return;
      const previous = activeList.current.scope === scope && page > 1 ? activeList.current.rows : [];
      const rows = mergeRemoteRows(previous, result.rows);
      if (page > 1 && result.total > previous.length && rows.length === previous.length) {
        throw new Error("Option pagination did not advance");
      }
      setList({ scope, rows, total: result.total, page, loading: false, error: false });
    } catch {
      if (controller.signal.aborted || generation !== listRequest.current.generation) return;
      setList((previous) => ({ ...previous, loading: false, error: true }));
    } finally {
      if (generation === listRequest.current.generation) listRequest.current.pending = false;
    }
  }, [api, query, scope]);

  useEffect(() => {
    if (!enabled) return;
    // This ref object is never replaced; its fields track the active request.
    const request = listRequest.current;
    // Clear the old query immediately; debounce only network work, never stale options.
    setList({ scope, rows: [], total: 0, page: 0, loading: true, error: false });
    const timer = query ? setTimeout(() => { void load(1); }, 250) : undefined;
    if (!query) void load(1);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      request.generation += 1;
      request.controller?.abort();
    };
  }, [enabled, load, query, scope]);

  useEffect(() => {
    const controller = new AbortController();
    const generation = ++selectionRequest.current;
    const values = JSON.parse(valuesKey) as RemoteValue[];
    setSelected({ scope: selectedScope, rows: [], incomplete: [], loading: values.length > 0, error: false });
    if (values.length) void (async () => {
      let rows: RemoteRow[] = [];
      const incomplete: string[] = [];
      try {
        // Only explicit selected values are batched. Never scan the full master table.
        for (const batch of selectedValueBatches(values)) {
          const result = await fetchPage(remoteListUrl(api, 1, undefined, batch), controller.signal);
          if (controller.signal.aborted || generation !== selectionRequest.current) return;
          rows = mergeRemoteRows(rows, result.rows);
          if (result.total > result.rows.length) incomplete.push(...batch.map(remoteValueKey));
        }
        setSelected({ scope: selectedScope, rows, incomplete, loading: false, error: false });
      } catch {
        if (controller.signal.aborted || generation !== selectionRequest.current) return;
        setSelected({ scope: selectedScope, rows, incomplete, loading: false, error: true });
      }
    })();
    return () => { controller.abort(); selectionRequest.current += 1; };
  }, [api, selectedScope, valuesKey, selectedRetry]);

  const current = list.scope === scope ? list : { ...list, rows: [], total: 0, page: 0, loading: enabled, error: false };
  const currentSelected = selected.scope === selectedScope ? selected : { ...selected, rows: [], incomplete: [], loading: true, error: false };
  const options = useMemo(() => {
    const candidates = remoteOptions(current.rows, getLabel, getValue, filterRow);
    const byValue = new Map(candidates.map((option) => [remoteValueKey(option.value), option]));
    const knownRows = mergeRemoteRows(currentSelected.loading && remembered.api === api ? remembered.rows : [], currentSelected.rows);
    for (const value of JSON.parse(valuesKey) as RemoteValue[]) {
      const key = remoteValueKey(value);
      const matches = knownRows.filter((row) => getValue(row) === value);
      const labels = new Set(matches.map(getLabel));
      const eligible = matches.length > 0 && matches.every((row) => !filterRow || filterRow(row));
      let label: string;
      if (currentSelected.error) label = `${String(value)}（名称加载失败）`;
      else if (currentSelected.incomplete.includes(key)) label = `${String(value)}（补取不完整，待核对）`;
      else if (labels.size > 1) label = `${String(value)}（重名，待核对）`;
      else if (matches.length && !eligible) label = `${[...labels][0]}（当前不可选）`;
      else if (matches.length) label = [...labels][0];
      else if (currentSelected.loading) label = `${String(value)}（名称加载中）`;
      else label = `${String(value)}（不存在或不在可选范围）`;
      // rc-select also uses option.disabled to block ×/Backspace removal.
      // Keep explicitly selected values removable; once removed, this override
      // disappears and the ordinary candidate eligibility/ambiguity rules apply.
      byValue.set(key, { value, label, disabled: false, ambiguous: labels.size > 1 });
    }
    return [...byValue.values()];
  }, [api, current.rows, currentSelected.rows, currentSelected.loading, currentSelected.error, currentSelected.incomplete,
    filterRow, getLabel, getValue, remembered, valuesKey]);

  const hasMore = current.rows.length < current.total;
  const renderMenu: NonNullable<SelectProps["popupRender"]> = (menu) => (
    <>
      {rest.popupRender ? rest.popupRender(menu) : rest.dropdownRender ? rest.dropdownRender(menu) : menu}
      <div onMouseDown={(event) => event.preventDefault()} style={{ padding: "8px 12px", borderTop: "1px solid #f0f0f0", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span role="status" aria-live="polite" style={{ fontSize: 12, color: "#667085" }}>
          {current.error ? "选项加载失败，已保留现有选择" : current.loading ? "正在读取选项…" : `已读取 ${current.rows.length} / ${current.total} 条`}
        </span>
        {current.error
          ? <Button size="small" onClick={() => { void load(current.page + 1); }}>重试选项</Button>
          : hasMore && <Button size="small" loading={current.loading} onClick={() => { void load(current.page + 1); }}>加载更多</Button>}
        {currentSelected.error && <Button size="small" onClick={() => setSelectedRetry((value) => value + 1)}>重试已选名称</Button>}
        <Button size="small" type="text" disabled={current.loading} onClick={() => {
          void load(1);
          setSelectedRetry((value) => value + 1);
        }}>刷新选项</Button>
        {!current.loading && !current.error && hasMore && <span style={{ fontSize: 12, color: "#667085" }}>可输入编码或名称缩小范围</span>}
      </div>
    </>
  );

  return <Select
    {...rest}
    showSearch={rest.showSearch ?? true}
    searchValue={query}
    filterOption={false}
    optionFilterProp="label"
    options={options}
    loading={Boolean(rest.loading || current.loading || currentSelected.loading)}
    notFoundContent={current.error ? "加载失败，请重试" : current.loading ? "加载中…" : rest.notFoundContent ?? "当前页没有可选项；可搜索或加载更多"}
    popupRender={renderMenu}
    onSearch={(value) => {
      if (rest.searchValue === undefined && value !== query) {
        listRequest.current.controller?.abort();
        listRequest.current.generation += 1;
      }
      setSearch({ api, value });
      rest.onSearch?.(value);
    }}
    onChange={(value, option) => {
      const keys = new Set(selectedRemoteValues(value).map(remoteValueKey));
      setRemembered({ api, rows: mergeRemoteRows(currentSelected.rows, current.rows).filter((row) => keys.has(remoteValueKey(getValue(row)))) });
      setUncontrolledValue(value);
      if (rest.autoClearSearchValue !== false) setSearch({ api, value: "" });
      rest.onChange?.(value, option);
    }}
    onOpenChange={(open) => {
      if (open) setHasOpened(true);
      rest.onOpenChange?.(open);
      rest.onDropdownVisibleChange?.(open);
    }}
    onPopupScroll={(event) => { rest.onPopupScroll?.(event); }}
  />;
}
