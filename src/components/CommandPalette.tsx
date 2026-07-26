"use client";

/**
 * #7 ⌘K 命令面板：任意页面 ⌘K/Ctrl+K 唤起，键盘直达页面 + 搜索 SKU/供应商/单据/NPD。
 * 页面清单静态内置（与菜单同步），实体搜索复用 /api/inbox/search。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AutoComplete, Modal } from "antd";

interface PageEntry { label: string; href: string; keywords: string; roles?: string[] }
const PAGES: PageEntry[] = [
  { label: "工作台", href: "/workbench", keywords: "workbench home shouye" },
  { label: "我的待办", href: "/inbox", keywords: "inbox daiban todo" },
  { label: "经营驾驶舱", href: "/report/dashboard", keywords: "dashboard jiashicang bi" },
  { label: "补货建议", href: "/replenish", keywords: "replenish buhuo" },
  { label: "需求达成与货盘", href: "/report/demand", keywords: "demand xuqiu huopan" },
  { label: "风险库存处置", href: "/report/risk", keywords: "risk fengxian chuzhi" },
  { label: "库存分层 ABC/XYZ", href: "/report/segmentation", keywords: "abc xyz fenceng segmentation" },
  { label: "SKU 360", href: "/report/sku-360", keywords: "sku360 timeline shijianzhou" },
  { label: "主数据健康度", href: "/report/data-health", keywords: "health jiankang zhiliang quality" , roles: ["pmc","purchasing"] },
  { label: "自动链预演", href: "/outsource/auto-chain", keywords: "auto chain zidonglian" },
  { label: "备货申请", href: "/outsource/bh", keywords: "bh beihuo" },
  { label: "委外工单", href: "/outsource/wo", keywords: "wo weiwai gongdan" },
  { label: "采购订单", href: "/outsource/po", keywords: "po caigou" },
  { label: "加工通知单", href: "/outsource/jg", keywords: "jg jiagong" },
  { label: "库存余额", href: "/inventory/balance", keywords: "balance yue kucun" },
  { label: "库存流水", href: "/inventory/ledger", keywords: "ledger liushui" },
  { label: "效期批次", href: "/inventory/expiry", keywords: "expiry xiaoqi pici" },
  { label: "盘点任务", href: "/inventory/count", keywords: "count pandian" },
  { label: "NPD 项目跟踪", href: "/npd", keywords: "npd xinpin project" },
  { label: "NPD 节点参考", href: "/report/npd", keywords: "npd jiedian node" },
  { label: "SPU 产品", href: "/master/spu", keywords: "spu chanpin" },
  { label: "SKU 货品", href: "/master/sku", keywords: "sku huopin" },
  { label: "供应商", href: "/master/supplier", keywords: "supplier gongyingshang" },
  { label: "仓库", href: "/master/warehouse", keywords: "warehouse cangku" },
  { label: "BOM", href: "/master/bom", keywords: "bom wuliaoqingdan" },
  { label: "文件上传", href: "/import/upload", keywords: "upload import shangchuan" , roles: ["pmc"] },
  { label: "复核清单与提醒", href: "/review/checklist", keywords: "review fuhe checklist tixing" },
  { label: "用户管理", href: "/admin/users", keywords: "users yonghu admin" , roles: [] },
  { label: "运行参数", href: "/admin/params", keywords: "params canshu" , roles: ["pmc","purchasing","finance"] },
  { label: "运维面板", href: "/admin/health", keywords: "health yunwei ops" , roles: [] },
];

interface Group { title: string; items: { label: string; href: string; tag?: string }[] }

export default function CommandPalette({ roles = [] }: { roles?: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [entityOpts, setEntityOpts] = useState<{ value: string; label: React.ReactNode }[]>([]);
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
    if (!open) { setQ(""); setEntityOpts([]); }
  }, [open]);

  // 实体搜索（≥2 字，300ms 防抖）
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 2) { setEntityOpts([]); return; }
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/inbox/search?q=${encodeURIComponent(q.trim())}`);
        const d = (await res.json()) as { groups: Group[] };
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
      } catch { /* ignore */ }
    }, 300);
  }, [q]);

  const isAdmin = roles.includes("admin");
  const allowed = useMemo(() => PAGES.filter((p) => isAdmin || p.roles === undefined || p.roles.some((r) => roles.includes(r))), [isAdmin, roles]);
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
      <div style={{ marginTop: 8, fontSize: 12, color: "#999" }}>提示：任意页面按 ⌘K / Ctrl+K 唤起</div>
    </Modal>
  );
}
