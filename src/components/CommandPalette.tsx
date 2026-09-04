"use client";

/**
 * #7 ⌘K 命令面板：任意页面 ⌘K/Ctrl+K 唤起，键盘直达页面 + 搜索 SKU/供应商/单据/NPD。
 * 页面清单与角色可见性来自 `@/lib/route-access` 注册表（与侧栏同源），实体搜索复用全局搜索 /api/search（?q=）。
 *
 * 2026-09-04：此前指向已不存在的 /api/inbox/search 且吞掉错误——⌘K 的实体搜索在所有页面静默返回空，
 * 用户以为「没有这个 SKU」。现在指向真实路由，且请求失败在面板内显式提示，不再假装无结果。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AutoComplete, Modal, Typography } from "antd";
import { isRouteVisible, PALETTE_PAGES, type PalettePage } from "@/lib/route-access";

/** 全局搜索路由（GET ?q=，<2 字符返回空组）；与 src/app/api/search/route.ts 契约一致 */
export const ENTITY_SEARCH_API = "/api/search";

/** 页面清单派生自 `@/lib/route-access`（D62 单一注册表）：登记了 keywords 的条目按菜单顺序进入面板 */
const PAGES: readonly PalettePage[] = PALETTE_PAGES;

interface Group { title: string; items: { label: string; href: string; tag?: string }[] }

export default function CommandPalette({ roles = [] }: { roles?: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [entityOpts, setEntityOpts] = useState<{ value: string; label: React.ReactNode }[]>([]);
  /** 实体搜索失败态：显式提示而不是把「请求失败」伪装成「无结果」 */
  const [entityError, setEntityError] = useState<string | null>(null);
  const hrefByKey = useRef(new Map<string, string>());
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) { setQ(""); setEntityOpts([]); setEntityError(null); }
  }, [open]);

  // 实体搜索（≥2 字，300ms 防抖）
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 2) { setEntityOpts([]); setEntityError(null); return; }
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`${ENTITY_SEARCH_API}?q=${encodeURIComponent(q.trim())}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `搜索接口返回 ${res.status}`);
        }
        const d = (await res.json()) as { groups: Group[] };
        setEntityError(null);
        hrefByKey.current.clear();
        const opts: { value: string; label: React.ReactNode }[] = [];
        for (const g of d.groups ?? []) {
          for (const it of g.items) {
            const key = `e:${g.title}:${it.label}`;
            hrefByKey.current.set(key, it.href);
            opts.push({ value: key, label: <span>{it.label} <span style={{ color: "#999", fontSize: 12 }}>· {g.title}</span></span> });
          }
        }
        setEntityOpts(opts);
      } catch (e) {
        // 失败不吞：面板内显式提示（曾因路由改名后静默吞错，实体搜索在全站「看起来没有数据」）
        setEntityOpts([]);
        setEntityError(e instanceof Error ? e.message : "搜索失败");
      }
    }, 300);
  }, [q]);

  const allowed = useMemo(() => PAGES.filter((p) => isRouteVisible(p, roles)), [roles]);
  const pageOpts = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const matched = kw
      ? allowed.filter((p) => p.label.toLowerCase().includes(kw) || p.keywords.includes(kw))
      : allowed.slice(0, 8);
    for (const p of matched) hrefByKey.current.set(`p:${p.href}`, p.href);
    return matched.map((p) => ({ value: `p:${p.href}`, label: <span>{p.label}</span> }));
  }, [q, allowed]);

  const options = useMemo(() => {
    const groups: { label: React.ReactNode; options: { value: string; label: React.ReactNode }[] }[] = [];
    if (pageOpts.length) groups.push({ label: <span style={{ fontSize: 12 }}>页面</span>, options: pageOpts });
    if (entityOpts.length) groups.push({ label: <span style={{ fontSize: 12 }}>数据</span>, options: entityOpts });
    return groups;
  }, [pageOpts, entityOpts]);

  const onSelect = useCallback((value: string) => {
    const href = hrefByKey.current.get(value);
    if (href) { setOpen(false); router.push(href); }
  }, [router]);

  return (
    <Modal
      open={open}
      onCancel={() => setOpen(false)}
      footer={null}
      closable={false}
      styles={{ body: { padding: 12 } }}
      style={{ top: 100 }}
      width={560}
      destroyOnHidden
    >
      <AutoComplete
        autoFocus
        value={q}
        onChange={setQ}
        onSelect={onSelect}
        options={options}
        style={{ width: "100%" }}
        placeholder="跳转页面或搜索 SKU/供应商/单据/NPD…（Esc 关闭）"
        popupMatchSelectWidth
        defaultActiveFirstOption
      />
      {entityError ? (
        <div role="alert" style={{ marginTop: 8, fontSize: 12 }}>
          <Typography.Text type="danger">数据搜索失败：{entityError}（页面跳转仍可用；请稍后重试或检查登录状态）</Typography.Text>
        </div>
      ) : null}
      <div style={{ marginTop: 8, fontSize: 12, color: "#999" }}>提示：任意页面按 ⌘K / Ctrl+K 唤起</div>
    </Modal>
  );
}
