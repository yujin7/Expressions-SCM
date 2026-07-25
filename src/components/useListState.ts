"use client";

/**
 * 列表页状态平台（E6-P1）：URL 是唯一真相 + 本地续航 + 密度/已保存视图。
 *
 * 目标：刷新不丢筛选、链接可分享、前进后退可用、回到页面=回到离开时的现场。
 * - 筛选 / 分页 → URL（`router.replace`，不滚动）
 * - 密度 / 已保存视图 → localStorage（纯本地偏好，不入 URL）
 * - 首次进入且 URL 无参数时，从 localStorage 恢复上次的查询串
 *
 * 内部逻辑全部抽成模块级纯函数（buildQueryString / parseQuery / mergeSavedViews …），
 * 便于 vitest 直测，hook 只负责把它们接到 Next 路由与 localStorage 上。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type Density = "default" | "middle" | "small";
export type TableSize = "large" | "middle" | "small";

/** 密度 → AntD Table size 映射 */
export const DENSITY_TO_SIZE: Record<Density, TableSize> = {
  default: "large",
  middle: "middle",
  small: "small",
};

/** 默认每页条数（未在 config 指定时） */
export const DEFAULT_PAGE_SIZE = 50;
/** 已保存视图上限 */
export const MAX_SAVED_VIEWS = 20;

export interface SavedView {
  name: string;
  query: string;
}

export interface ListStateConfig<F extends Record<string, string | undefined>> {
  /** localStorage 命名空间（每页唯一，如 "risk"） */
  key: string;
  /** 筛选项默认值；键名即 URL 参数名 */
  defaults: F;
  /** 是否把 page/pageSize 也纳入 URL（默认 true） */
  paginated?: boolean;
  /** 每页条数默认值（默认 50）；等于该值时不写入 URL */
  defaultPageSize?: number;
  /**
   * URL 参数前缀——同一页面存在多个独立列表（每个 Tab 一份）时必填且互不相同，
   * 例如 prefix "fg" → 参数写作 fg_q / fg_page。不填=无前缀（单列表页，向后兼容）。
   * 有前缀时，写 URL 只增删本实例自己的参数，不动兄弟实例的（否则 Tab 间互相清空）。
   */
  paramPrefix?: string;
}

export interface ListState<F> {
  filters: F;
  setFilter: (patch: Partial<F>) => void; // 改筛选自动回到第 1 页
  resetFilters: () => void;
  page: number;
  pageSize: number;
  setPage: (p: number, ps?: number) => void;
  /** AntD Table 的 pagination 配置（收口 49 处复制；showTotal 可覆盖单位） */
  paginationProps: (opts?: { total?: number; showTotal?: (t: number) => string }) => {
    current: number;
    pageSize: number;
    total: number | undefined;
    showSizeChanger: boolean;
    showTotal: (t: number) => string;
    onChange: (p: number, ps: number) => void;
  };
  density: Density;
  setDensity: (d: Density) => void;
  /** 传给 AntD Table 的 size 值 */
  tableSize: TableSize;
  /** 当前视图的可分享 URL（含全部状态） */
  shareUrl: () => string;
  /** 已保存视图 */
  savedViews: SavedView[];
  saveView: (name: string) => void;
  applyView: (query: string) => void;
  deleteView: (name: string) => void;
  /** 供 fetch 用的查询串（不含 density 等纯 UI 项） */
  queryString: () => string;
}

/* ------------------------------------------------------------------ *
 * 纯函数区（可单测，不依赖 React / DOM）
 * ------------------------------------------------------------------ */

/** localStorage 键名 */
/** 参数名加前缀（无前缀时原样返回） */
export function pname(prefix: string | undefined, k: string): string {
  return prefix ? `${prefix}_${k}` : k;
}

export function storageKeys(key: string): { last: string; density: string; views: string } {
  return {
    last: `listState:${key}:last`,
    density: `listState:${key}:density`,
    views: `listState:${key}:views`,
  };
}

function isEmpty(v: string | undefined): boolean {
  return v == null || v === "";
}

/**
 * 生成写入 URL 的查询串：等于默认值 / 空值的筛选项一律省略，保持 URL 干净。
 * page=1、pageSize=默认值 时同样省略。
 */
export function buildQueryString<F extends Record<string, string | undefined>>(
  filters: F,
  page: number,
  pageSize: number,
  defaults: F,
  opts?: { paginated?: boolean; defaultPageSize?: number; paramPrefix?: string; base?: string },
): string {
  const paginated = opts?.paginated !== false;
  const defaultPageSize = opts?.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  const px = opts?.paramPrefix;
  // 多列表页：以当前 URL 为底，只增删本实例参数，保留兄弟实例的
  const sp = new URLSearchParams(px && opts?.base ? (opts.base.startsWith("?") ? opts.base.slice(1) : opts.base) : "");
  for (const k of Object.keys(defaults)) {
    const name = pname(px, k);
    const v = filters[k];
    if (isEmpty(v) || v === defaults[k]) { sp.delete(name); continue; }
    sp.set(name, String(v));
  }
  if (paginated) {
    if (page > 1) sp.set(pname(px, "page"), String(page)); else sp.delete(pname(px, "page"));
    if (pageSize !== defaultPageSize) sp.set(pname(px, "pageSize"), String(pageSize)); else sp.delete(pname(px, "pageSize"));
  }
  return sp.toString();
}

/** 供 fetch 用：筛选项照常省略空值，但 page/pageSize 恒显式带上（后端默认值与前端不一定一致） */
/** 注意：fetch 查询串**不加前缀**——前缀只是 URL 命名空间，后端参数名不变 */
export function buildFetchQuery<F extends Record<string, string | undefined>>(
  filters: F,
  page: number,
  pageSize: number,
  defaults: F,
  opts?: { paginated?: boolean },
): string {
  const sp = new URLSearchParams();
  for (const k of Object.keys(defaults)) {
    const v = filters[k];
    if (isEmpty(v)) continue;
    sp.set(k, String(v));
  }
  if (opts?.paginated !== false) {
    sp.set("page", String(page));
    sp.set("pageSize", String(pageSize));
  }
  return sp.toString();
}

export interface ParsedListQuery<F> {
  filters: F;
  page: number;
  pageSize: number;
}

/** 解析查询串；缺失项回落到默认值。与 buildQueryString 往返一致。 */
export function parseQuery<F extends Record<string, string | undefined>>(
  query: string,
  defaults: F,
  opts?: { paginated?: boolean; defaultPageSize?: number; paramPrefix?: string },
): ParsedListQuery<F> {
  const defaultPageSize = opts?.defaultPageSize ?? DEFAULT_PAGE_SIZE;
  const px = opts?.paramPrefix;
  const sp = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const filters = { ...defaults } as Record<string, string | undefined>;
  for (const k of Object.keys(defaults)) {
    const v = sp.get(pname(px, k));
    if (v != null) filters[k] = v;
  }
  const paginated = opts?.paginated !== false;
  const rawPage = Number(sp.get(pname(px, "page")));
  const rawSize = Number(sp.get(pname(px, "pageSize")));
  return {
    filters: filters as F,
    page: paginated && Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1,
    pageSize:
      paginated && Number.isFinite(rawSize) && rawSize >= 1 ? Math.floor(rawSize) : defaultPageSize,
  };
}

/** 保存视图：同名覆盖（保留原位置），新条目追加到末尾，总数上限 MAX_SAVED_VIEWS（超出丢弃最旧的） */
export function mergeSavedViews(views: SavedView[], name: string, query: string): SavedView[] {
  const trimmed = name.trim();
  if (!trimmed) return views;
  const idx = views.findIndex((v) => v.name === trimmed);
  const next = idx >= 0
    ? views.map((v, i) => (i === idx ? { name: trimmed, query } : v))
    : [...views, { name: trimmed, query }];
  return next.length > MAX_SAVED_VIEWS ? next.slice(next.length - MAX_SAVED_VIEWS) : next;
}

/** 删除指定名称的视图 */
export function removeSavedView(views: SavedView[], name: string): SavedView[] {
  return views.filter((v) => v.name !== name);
}

/** 从 localStorage 原文解析视图数组（容错：脏数据一律当空） */
export function parseSavedViews(raw: string | null): SavedView[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (v): v is SavedView =>
          typeof v === "object" && v != null &&
          typeof (v as SavedView).name === "string" && typeof (v as SavedView).query === "string",
      )
      .slice(0, MAX_SAVED_VIEWS);
  } catch {
    return [];
  }
}

export function isDensity(v: unknown): v is Density {
  return v === "default" || v === "middle" || v === "small";
}

/** pathname + query 拼成路径（query 为空时不留问号） */
export function joinPath(pathname: string, query: string): string {
  return query ? `${pathname}?${query}` : pathname;
}

/* ------------------------------------------------------------------ *
 * Hook
 * ------------------------------------------------------------------ */

export function useListState<F extends Record<string, string | undefined>>(
  cfg: ListStateConfig<F>,
): ListState<F> {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const { key } = cfg;
  const paginated = cfg.paginated !== false;
  const defaultPageSize = cfg.defaultPageSize ?? DEFAULT_PAGE_SIZE;

  // defaults 通常是行内字面量，用 ref 固定引用，避免 memo/callback 依赖抖动
  const defaultsRef = useRef<F>(cfg.defaults);
  const optsRef = useRef({ paginated, defaultPageSize, paramPrefix: cfg.paramPrefix });
  optsRef.current = { paginated, defaultPageSize, paramPrefix: cfg.paramPrefix };
  // 写 URL 时以当前查询串为底（多列表页保留兄弟实例参数）
  const baseRef = useRef("");

  const currentQuery = searchParams.toString();
  baseRef.current = currentQuery;
  const parsed = useMemo(
    () => parseQuery(currentQuery, defaultsRef.current, optsRef.current),
    [currentQuery],
  );
  // 供回调读取最新值（避免闭包过期）
  const parsedRef = useRef(parsed);
  parsedRef.current = parsed;

  const keys = useMemo(() => storageKeys(key), [key]);

  const push = useCallback(
    (query: string) => {
      router.replace(joinPath(pathname, query), { scroll: false });
    },
    [router, pathname],
  );

  /* --- 首次进入：URL 无参数则从 localStorage 恢复上次视图 --- */
  const bootedRef = useRef(false);
  const pendingRestoreRef = useRef<string | null>(null);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    if (typeof window === "undefined") return;
    if (currentQuery) return; // URL 有参数时以 URL 为准
    if (cfg.paramPrefix) return; // 多列表页：整串恢复会抹掉兄弟实例，禁用自动恢复
    const last = window.localStorage.getItem(keys.last);
    if (last) {
      pendingRestoreRef.current = last;
      router.replace(joinPath(pathname, last), { scroll: false });
    }
  }, [currentQuery, keys.last, pathname, router]);

  /* --- 每次状态变更把当前 query 写回 localStorage --- */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (pendingRestoreRef.current !== null) {
      if (!currentQuery) return; // 恢复尚未落地，别把空串覆写回去
      pendingRestoreRef.current = null;
    }
    if (currentQuery) window.localStorage.setItem(keys.last, currentQuery);
    else window.localStorage.removeItem(keys.last);
  }, [currentQuery, keys.last]);

  /* --- 密度（纯本地偏好） --- */
  const [density, setDensityState] = useState<Density>("default");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(keys.density);
    if (isDensity(raw)) setDensityState(raw);
  }, [keys.density]);
  const setDensity = useCallback(
    (d: Density) => {
      setDensityState(d);
      if (typeof window !== "undefined") window.localStorage.setItem(keys.density, d);
    },
    [keys.density],
  );

  /* --- 已保存视图（纯本地偏好） --- */
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setSavedViews(parseSavedViews(window.localStorage.getItem(keys.views)));
  }, [keys.views]);
  const saveView = useCallback(
    (name: string) => {
      setSavedViews((prev) => {
        const next = mergeSavedViews(prev, name, currentQuery);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(keys.views, JSON.stringify(next));
        }
        return next;
      });
    },
    [currentQuery, keys.views],
  );
  const applyView = useCallback((query: string) => push(query), [push]);
  const deleteView = useCallback(
    (name: string) => {
      setSavedViews((prev) => {
        const next = removeSavedView(prev, name);
        if (typeof window !== "undefined") {
          window.localStorage.setItem(keys.views, JSON.stringify(next));
        }
        return next;
      });
    },
    [keys.views],
  );
  /* --- 筛选 / 分页写入 --- */
  const setFilter = useCallback(
    (patch: Partial<F>) => {
      const cur = parsedRef.current;
      const nextFilters = { ...cur.filters, ...patch } as F;
      push(buildQueryString(nextFilters, 1, cur.pageSize, defaultsRef.current, { ...optsRef.current, base: baseRef.current }));
    },
    [push],
  );
  const resetFilters = useCallback(() => {
    const cur = parsedRef.current;
    push(buildQueryString(defaultsRef.current, 1, cur.pageSize, defaultsRef.current, { ...optsRef.current, base: baseRef.current }));
  }, [push]);
  const setPage = useCallback(
    (p: number, ps?: number) => {
      const cur = parsedRef.current;
      push(
        buildQueryString(cur.filters, p, ps ?? cur.pageSize, defaultsRef.current, { ...optsRef.current, base: baseRef.current }),
      );
    },
    [push],
  );

  const shareUrl = useCallback(() => {
    const path = joinPath(pathname, currentQuery);
    if (typeof window === "undefined") return path;
    return `${window.location.origin}${path}`;
  }, [pathname, currentQuery]);

  const queryString = useCallback(() => {
    const cur = parsedRef.current;
    return buildFetchQuery(cur.filters, cur.page, cur.pageSize, defaultsRef.current, {
      paginated: optsRef.current.paginated,
    });
  }, []);

  /**
   * AntD Table 的 pagination 配置。
   *
   * 此前这 6 行在 40 个客户端文件、49 个位置逐字复制。它不只是样板：
   * pageSizeOptions、是否显示快速跳页、默认每页条数这类决策散在 49 处，
   * 想统一调整就得改 49 个地方——于是没人调，页面之间的分页体验各不相同。
   *
   * `showTotal` 保留覆盖参数：确实有 3 处单位不是「条」
   * （「共 N 家」供应商、「共 N 组候选」去重、「共 N 条待修复」健康度），
   * 强行统一成「条」会把话说错。
   */
  const paginationProps = useCallback(
    (opts?: { total?: number; showTotal?: (t: number) => string }) => ({
      current: parsed.page,
      pageSize: parsed.pageSize,
      total: opts?.total,
      showSizeChanger: true,
      showTotal: opts?.showTotal ?? ((t: number) => `共 ${t} 条`),
      onChange: (p: number, ps: number) => setPage(p, ps),
    }),
    [parsed.page, parsed.pageSize, setPage],
  );

  return {
    filters: parsed.filters,
    setFilter,
    resetFilters,
    page: parsed.page,
    pageSize: parsed.pageSize,
    setPage,
    paginationProps,
    density,
    setDensity,
    tableSize: DENSITY_TO_SIZE[density],
    shareUrl,
    savedViews,
    saveView,
    applyView,
    deleteView,
    queryString,
  };
}
