"use client";

/** 全局搜索（编码/中文/拼音/首字母/单号直达）——数据源 /api/search */
import { useEffect, useRef, useState } from "react";
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
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    controller.current?.abort();
  }, []);

  const search = (q: string) => {
    if (timer.current) clearTimeout(timer.current);
    controller.current?.abort();
    if (q.trim().length < 2) {
      hrefByKey.current.clear();
      setOptions([]);
      return;
    }
    timer.current = setTimeout(async () => {
      const request = new AbortController();
      controller.current = request;
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, {
          signal: request.signal,
        });
        if (!res.ok) return;
        const d = (await res.json()) as { groups: Group[] };
        if (request.signal.aborted) return;
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
        if (request.signal.aborted) return;
        /* 忽略搜索失败 */
      }
    }, 300);
  };

  return (
    <AutoComplete
      className="global-search"
      style={{ width: "100%" }}
      options={options}
      onSearch={search}
      onSelect={(key: string) => {
        const href = hrefByKey.current.get(key);
        if (href) router.push(href);
      }}
    >
      <Input
        size="small"
        prefix={<SearchOutlined />}
        placeholder="搜编码 / 中文 / 拼音 / 首字母 / 单号"
        aria-label="全局搜索：编码、中文、拼音、首字母或单号"
        allowClear
      />
    </AutoComplete>
  );
}
