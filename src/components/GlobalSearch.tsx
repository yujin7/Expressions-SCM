"use client";

/** 全局搜索（编码/单号/供应商直达）——数据源 /api/search */
import { useRef, useState } from "react";
import { AutoComplete, Input, Tag } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";

interface Item { label: string; href: string; tag?: string }
interface Group { title: string; items: Item[] }

export default function GlobalSearch() {
  const router = useRouter();
  const [options, setOptions] = useState<{ label: React.ReactNode; options: { value: string; label: React.ReactNode }[] }[]>([]);
  const hrefByKey = useRef(new Map<string, string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = (q: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setOptions([]);
      return;
    }
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
        if (!res.ok) return;
        const d = (await res.json()) as { groups: Group[] };
        hrefByKey.current.clear();
        setOptions(
          (d.groups ?? [])
            .filter((g) => g.items.length > 0)
            .map((g) => ({
              label: <span style={{ fontSize: 12 }}>{g.title}</span>,
              options: g.items.map((it, i) => {
                const key = `${g.title}:${i}:${it.label}`;
                hrefByKey.current.set(key, it.href);
                return {
                  value: key,
                  label: (
                    <span>
                      {it.label} {it.tag ? <Tag style={{ marginLeft: 6 }}>{it.tag}</Tag> : null}
                    </span>
                  ),
                };
              }),
            })),
        );
      } catch {
        /* 忽略搜索失败 */
      }
    }, 300);
  };

  return (
    <AutoComplete
      style={{ width: 260 }}
      options={options}
      onSearch={search}
      onSelect={(key: string) => {
        const href = hrefByKey.current.get(key);
        if (href) router.push(href);
      }}
    >
      <Input size="small" prefix={<SearchOutlined />} placeholder="搜编码 / 单号 / 供应商" allowClear />
    </AutoComplete>
  );
}
