"use client";

/** Global entity search; query identity and request cleanup are shared with the command palette. */
import { useState } from "react";
import { AutoComplete, Button, Input, Tag } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { useEntitySearch } from "@/components/useEntitySearch";

export default function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const search = useEntitySearch(q);
  const status = search.error ? "搜索失败：" + search.error : search.phase === "loading" ? "正在搜索…"
    : search.phase === "success" ? "未找到匹配数据" : "输入至少 2 个字符";
  const options = search.entries.length ? [{
    label: "数据",
    options: search.entries.map(item => ({ value: item.value, label: <span>
      {item.label} {item.tag ? <Tag style={{ marginLeft: 6 }}>{item.tag}</Tag> : null}
      {item.tag === item.group ? null : <span style={{ color: "#667085", fontSize: 12, whiteSpace: "nowrap", display: "inline-block" }}> · {item.group}</span>}
    </span> })),
  }] : [{ label: "数据", options: [{ value: "search-status", disabled: true,
    label: <span role={search.error ? "alert" : "status"}
      style={{ whiteSpace: "normal", color: search.error ? "#b42318" : "#667085" }}>{status}</span> }] }];

  return (
    <AutoComplete className="global-search" style={{ width: "100%" }} value={q} options={options}
      classNames={{ popup: { root: "scm-search-popup" } }}
      onChange={setQ}
      onSelect={(value: string) => {
        const href = search.entries.find(item => item.value === value)?.href;
        if (href) { setQ(""); router.push(href); }
      }}
      popupRender={menu => <>{menu}{search.error ? <Button size="small" type="link"
        onMouseDown={event => event.preventDefault()} onClick={search.retry}>重试搜索</Button> : null}</>}
    >
      <Input size="small" prefix={<SearchOutlined />}
        placeholder="搜编码 / 中文 / 拼音 / 首字母 / 单号"
        aria-label="全局搜索：编码、中文、拼音、首字母或单号" allowClear />
    </AutoComplete>
  );
}
