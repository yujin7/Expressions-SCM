import { describe, it, expect } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  DENSITY_TO_SIZE,
  MAX_SAVED_VIEWS,
  buildFetchQuery,
  buildQueryString,
  isDensity,
  joinPath,
  mergeSavedViews,
  parseQuery,
  parseSavedViews,
  removeSavedView,
  storageKeys,
  type SavedView,
} from "@/components/useListState";

type F = { q?: string; action?: string; status?: string };
const defaults: F = { q: "", action: "", status: "open" };

describe("buildQueryString（URL 只留非默认值）", () => {
  it("等于默认值或空值的筛选项被省略", () => {
    expect(buildQueryString({ q: "", action: "", status: "open" }, 1, DEFAULT_PAGE_SIZE, defaults)).toBe("");
    expect(buildQueryString({ q: "AB", action: "", status: "open" }, 1, DEFAULT_PAGE_SIZE, defaults)).toBe("q=AB");
    expect(buildQueryString({ q: undefined, action: "报废评审", status: "closed" }, 1, DEFAULT_PAGE_SIZE, defaults))
      .toBe("action=%E6%8A%A5%E5%BA%9F%E8%AF%84%E5%AE%A1&status=closed");
  });

  it("page=1 / pageSize=默认值 不入 URL，其它值写入", () => {
    expect(buildQueryString(defaults, 1, 50, defaults, { defaultPageSize: 50 })).toBe("");
    expect(buildQueryString(defaults, 3, 50, defaults, { defaultPageSize: 50 })).toBe("page=3");
    expect(buildQueryString(defaults, 3, 100, defaults, { defaultPageSize: 50 })).toBe("page=3&pageSize=100");
  });

  it("paginated=false 时完全不写分页", () => {
    expect(buildQueryString({ q: "AB" }, 5, 200, { q: "" }, { paginated: false })).toBe("q=AB");
  });

  it("键顺序稳定（按 defaults 的键序）", () => {
    const a = buildQueryString({ q: "x", action: "y", status: "z" }, 1, 50, defaults, { defaultPageSize: 50 });
    const b = buildQueryString({ status: "z", action: "y", q: "x" }, 1, 50, defaults, { defaultPageSize: 50 });
    expect(a).toBe(b);
    expect(a).toBe("q=x&action=y&status=z");
  });
});

describe("parseQuery（往返一致）", () => {
  it("缺失项回落默认值", () => {
    const r = parseQuery("", defaults, { defaultPageSize: 50 });
    expect(r).toEqual({ filters: { q: "", action: "", status: "open" }, page: 1, pageSize: 50 });
  });

  it("build → parse 往返一致", () => {
    const filters: F = { q: "AB 01", action: "报废评审", status: "closed" };
    const qs = buildQueryString(filters, 4, 100, defaults, { defaultPageSize: 50 });
    const back = parseQuery(qs, defaults, { defaultPageSize: 50 });
    expect(back.filters).toEqual(filters);
    expect(back.page).toBe(4);
    expect(back.pageSize).toBe(100);
    // 再 build 一次应得到同一串（幂等）
    expect(buildQueryString(back.filters, back.page, back.pageSize, defaults, { defaultPageSize: 50 })).toBe(qs);
  });

  it("接受带问号前缀，忽略未知参数与非法分页", () => {
    const r = parseQuery("?q=A&zzz=1&page=0&pageSize=abc", defaults, { defaultPageSize: 50 });
    expect(r.filters.q).toBe("A");
    expect(r.filters).not.toHaveProperty("zzz");
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(50);
  });

  it("URL 里的空串覆盖非空默认值（可显式清空）", () => {
    const r = parseQuery("status=", defaults);
    expect(r.filters.status).toBe("");
  });
});

describe("改筛选自动回到第 1 页", () => {
  // hook 内 setFilter 的行为：以当前 filters 为底 + patch，page 固定传 1
  const applyFilterPatch = (cur: { filters: F; page: number; pageSize: number }, patch: Partial<F>) =>
    buildQueryString({ ...cur.filters, ...patch }, 1, cur.pageSize, defaults, { defaultPageSize: 50 });

  it("从第 7 页改筛选后 page 消失（=第 1 页）", () => {
    const cur = parseQuery("q=A&page=7", defaults, { defaultPageSize: 50 });
    expect(cur.page).toBe(7);
    const next = applyFilterPatch(cur, { action: "禁售隔离" });
    expect(parseQuery(next, defaults, { defaultPageSize: 50 }).page).toBe(1);
    expect(next).not.toContain("page=");
  });

  it("改筛选保留 pageSize", () => {
    const cur = parseQuery("page=7&pageSize=100", defaults, { defaultPageSize: 50 });
    const next = applyFilterPatch(cur, { q: "X" });
    expect(parseQuery(next, defaults, { defaultPageSize: 50 }).pageSize).toBe(100);
  });

  it("重置：回到默认值 + 第 1 页", () => {
    const cur = parseQuery("q=A&action=B&page=9", defaults, { defaultPageSize: 50 });
    const next = buildQueryString(defaults, 1, cur.pageSize, defaults, { defaultPageSize: 50 });
    expect(next).toBe("");
  });
});

describe("buildFetchQuery（分页恒显式）", () => {
  it("空筛选也带上 page/pageSize", () => {
    expect(buildFetchQuery(defaults, 1, 50, defaults)).toBe("status=open&page=1&pageSize=50");
  });
  it("空值筛选省略", () => {
    expect(buildFetchQuery({ q: "", action: "X", status: "" }, 2, 20, defaults)).toBe("action=X&page=2&pageSize=20");
  });
});

describe("mergeSavedViews（同名覆盖 + 上限 20）", () => {
  it("追加新视图", () => {
    const r = mergeSavedViews([], "全部", "q=A");
    expect(r).toEqual([{ name: "全部", query: "q=A" }]);
  });

  it("同名覆盖且保留原位置，不新增条目", () => {
    const base: SavedView[] = [
      { name: "A", query: "q=1" },
      { name: "B", query: "q=2" },
      { name: "C", query: "q=3" },
    ];
    const r = mergeSavedViews(base, "B", "q=999");
    expect(r).toHaveLength(3);
    expect(r[1]).toEqual({ name: "B", query: "q=999" });
    expect(r.map((v) => v.name)).toEqual(["A", "B", "C"]);
  });

  it("名称首尾空白被裁剪后视为同名", () => {
    const r = mergeSavedViews([{ name: "A", query: "q=1" }], "  A  ", "q=2");
    expect(r).toEqual([{ name: "A", query: "q=2" }]);
  });

  it("空名称不产生视图", () => {
    expect(mergeSavedViews([], "   ", "q=1")).toEqual([]);
  });

  it("上限 20：超出时丢弃最旧的", () => {
    let views: SavedView[] = [];
    for (let i = 1; i <= 25; i++) views = mergeSavedViews(views, `V${i}`, `q=${i}`);
    expect(views).toHaveLength(MAX_SAVED_VIEWS);
    expect(views[0]?.name).toBe("V6");
    expect(views[MAX_SAVED_VIEWS - 1]?.name).toBe("V25");
  });

  it("已满时覆盖同名不挤掉别人", () => {
    let views: SavedView[] = [];
    for (let i = 1; i <= 20; i++) views = mergeSavedViews(views, `V${i}`, `q=${i}`);
    const after = mergeSavedViews(views, "V1", "q=new");
    expect(after).toHaveLength(20);
    expect(after[0]).toEqual({ name: "V1", query: "q=new" });
  });

  it("removeSavedView 按名删除", () => {
    const base: SavedView[] = [{ name: "A", query: "" }, { name: "B", query: "" }];
    expect(removeSavedView(base, "A")).toEqual([{ name: "B", query: "" }]);
    expect(removeSavedView(base, "无此项")).toHaveLength(2);
  });
});

describe("parseSavedViews（localStorage 容错）", () => {
  it("null / 脏数据一律当空", () => {
    expect(parseSavedViews(null)).toEqual([]);
    expect(parseSavedViews("not json")).toEqual([]);
    expect(parseSavedViews('{"a":1}')).toEqual([]);
    expect(parseSavedViews('[{"name":"A"},{"name":"B","query":"q=1"},3]')).toEqual([
      { name: "B", query: "q=1" },
    ]);
  });

  it("JSON 往返", () => {
    const views = mergeSavedViews([], "近效期", "action=%E6%8A%A5%E5%BA%9F&page=2");
    expect(parseSavedViews(JSON.stringify(views))).toEqual(views);
  });
});

describe("杂项", () => {
  it("密度 → AntD size 映射", () => {
    expect(DENSITY_TO_SIZE).toEqual({ default: "large", middle: "middle", small: "small" });
  });
  it("isDensity 守卫", () => {
    expect(isDensity("small")).toBe(true);
    expect(isDensity("large")).toBe(false);
    expect(isDensity(null)).toBe(false);
  });
  it("storageKeys 命名空间", () => {
    expect(storageKeys("risk")).toEqual({
      last: "listState:risk:last",
      density: "listState:risk:density",
      views: "listState:risk:views",
    });
  });
  it("joinPath 空 query 不留问号", () => {
    expect(joinPath("/report/risk", "")).toBe("/report/risk");
    expect(joinPath("/report/risk", "q=A")).toBe("/report/risk?q=A");
  });
});

/* ── 多列表页命名空间（paramPrefix）：同页多个独立列表互不干扰 ── */
describe("paramPrefix 命名空间", () => {
  const defaults = { q: "", status: "" };

  it("参数名加前缀，fetch 查询串不加前缀（后端参数名不变）", () => {
    const url = buildQueryString({ q: "abc", status: "open" }, 2, 50, defaults, { paramPrefix: "fg", defaultPageSize: 20 });
    expect(url).toContain("fg_q=abc");
    expect(url).toContain("fg_page=2");
    // 断言无「裸」参数：以 q= 开头或紧跟 & 的才算裸参数（fg_q=abc 含子串 q=abc 属误判）
    expect(/(^|&)q=/.test(url)).toBe(false);
    expect(/(^|&)page=/.test(url)).toBe(false);
    const fetchQ = buildFetchQuery({ q: "abc", status: "open" }, 2, 50, defaults);
    expect(fetchQ).toContain("q=abc");
    expect(fetchQ).not.toContain("fg_");
  });

  it("写入时保留兄弟实例的参数（不再互相清空）", () => {
    const base = "pkg_q=xyz&pkg_page=3";
    const url = buildQueryString({ q: "abc", status: "" }, 1, 20, defaults, { paramPrefix: "fg", defaultPageSize: 20, base });
    expect(url).toContain("pkg_q=xyz"); // 兄弟保留
    expect(url).toContain("pkg_page=3");
    expect(url).toContain("fg_q=abc");
  });

  it("清空本实例筛选只删自己的参数", () => {
    const base = "fg_q=old&pkg_q=keep";
    const url = buildQueryString({ q: "", status: "" }, 1, 20, defaults, { paramPrefix: "fg", defaultPageSize: 20, base });
    expect(url).not.toContain("fg_q");
    expect(url).toContain("pkg_q=keep");
  });

  it("parseQuery 按前缀读回，与 buildQueryString 往返一致", () => {
    const url = buildQueryString({ q: "abc", status: "open" }, 3, 100, defaults, { paramPrefix: "fg", defaultPageSize: 20 });
    const back = parseQuery(url, defaults, { paramPrefix: "fg", defaultPageSize: 20 });
    expect(back.filters).toEqual({ q: "abc", status: "open" });
    expect(back.page).toBe(3);
    expect(back.pageSize).toBe(100);
  });

  it("无前缀行为与既有一致（向后兼容）", () => {
    const url = buildQueryString({ q: "abc", status: "" }, 2, 50, defaults, { defaultPageSize: 20 });
    expect(url).toBe("q=abc&page=2&pageSize=50");
  });
});
