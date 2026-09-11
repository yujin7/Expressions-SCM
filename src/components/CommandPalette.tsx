"use client";

/** Page discovery shares the sidebar registry; entity results share the header request lifecycle. */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AutoComplete, Button, Modal, Typography } from "antd";
import type { RefSelectProps } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { isRouteVisible, PALETTE_PAGES } from "@/lib/route-access";
import { useEntitySearch } from "@/components/useEntitySearch";

export { ENTITY_SEARCH_API } from "@/components/useEntitySearch";

export default function CommandPalette({ roles = [], compact = false }: { roles?: string[]; compact?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const input = useRef<RefSelectProps>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const search = useEntitySearch(q, open);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!open && typeof document !== "undefined") returnFocus.current = document.activeElement as HTMLElement | null;
        setOpen(v => !v);
      }
      if (e.key === "Escape" && open) { e.preventDefault(); setOpen(false); }
    };
    // rc-select stops Escape bubbling while its popup is open; the palette owns that close action.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  useEffect(() => { if (!open) setQ(""); }, [open]);

  const keyword = q.trim().toLowerCase();
  const allowed = PALETTE_PAGES.filter(p => isRouteVisible(p, roles));
  const pages = keyword ? allowed.filter(p => (p.label + " " + p.keywords).toLowerCase().includes(keyword)) : allowed.slice(0, 8);
  const options = [
    ...(pages.length ? [{ label: "页面", options: pages.map(p => ({ value: "p:" + p.href, label: p.label })) }] : []),
    ...(search.entries.length ? [{ label: "数据", options: search.entries.map(item => ({
      value: item.value,
      label: <span>{item.label} <Typography.Text type="secondary">· {item.group}</Typography.Text></span>,
    })) }] : []),
  ];

  return (
    <>
    <Button ref={trigger} type="text" size="small" icon={<SearchOutlined />} aria-label="搜索页面与数据"
      aria-haspopup="dialog" aria-expanded={open} title="搜索页面与数据（⌘K / Ctrl+K）"
      onClick={() => { returnFocus.current = trigger.current; setOpen(true); }}>{compact ? null : "快捷跳转"}</Button>
    <Modal open={open} title="快捷跳转" onCancel={() => setOpen(false)} footer={null}
      afterOpenChange={visible => { if (visible) input.current?.focus(); }}
      focusTriggerAfterClose={false}
      afterClose={() => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); }}
      styles={{ body: { paddingTop: 4 } }} style={{ top: 80 }} width={560} destroyOnHidden>
      {search.error ? (
        <div role="alert" style={{ marginBottom: 8, fontSize: 12 }}>
          <Typography.Text type="danger">数据搜索失败：{search.error}；页面跳转仍可用。</Typography.Text>
          <Button size="small" type="link" onClick={search.retry}>重试搜索</Button>
        </div>
      ) : (
        <div role="status" style={{ marginBottom: 8, fontSize: 12, color: "#667085" }}>
          {search.phase === "loading" ? "正在搜索数据…页面可先跳转" : search.phase === "success" && !search.entries.length
            ? "未找到匹配数据；可修改关键词或选择页面" : "输入至少 2 个字符搜索数据；↑↓ 选择，Enter 打开，Esc 关闭"}
        </div>
      )}
      <AutoComplete ref={input} value={q} onChange={setQ}
        onSelect={(value: string) => {
          // Entity responses cannot erase independently derived page targets.
          const href = pages.find(p => "p:" + p.href === value)?.href ?? search.entries.find(item => item.value === value)?.href;
          if (open && href) { returnFocus.current = null; setOpen(false); router.push(href); }
        }}
        options={options} style={{ width: "100%" }}
        aria-label="快捷跳转：页面、SKU、供应商或单据"
        placeholder="搜索页面 / SKU / 供应商 / 单据…"
        listHeight={224} classNames={{ popup: { root: "scm-search-popup" } }} popupMatchSelectWidth defaultActiveFirstOption />
    </Modal>
    </>
  );
}
