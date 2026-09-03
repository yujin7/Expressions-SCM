"use client";

/**
 * SKU 外部销量排名（BI-R4）：天猫+拼多多观察口径按系统 SKU 排名，品牌/平台筛选、CSV、身份覆盖率随表显示。
 * 件数为主；组合装按 D47 拆到组件（在外部销速读模型里完成，本卡只消费）。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Col, Row, Select, Space, Statistic, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";
import SearchInput from "@/components/SearchInput";
import { exportCsv } from "@/components/exportCsv";
import { formatQty } from "@/components/format";
import SkuHoverCard from "@/components/SkuHoverCard";
import type { ExternalSkuRanking, ExternalSkuRankRow } from "@/server/modules/report/external-sku-ranking";

type Data = ExternalSkuRanking & { totalRows: number };

export default function ExternalSkuRankingCard({ active }: { active: boolean }) {
  const { message } = App.useApp();
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [brand, setBrand] = useState<string>("");
  const [platform, setPlatform] = useState<"all" | "tmall" | "pdd">("all");
  const [q, setQ] = useState("");
  const [limit, setLimit] = useState(100);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ platform, limit: String(limit) });
      if (brand) params.set("brand", brand);
      if (q) params.set("q", q);
      setData(await fetchJson<Data>(`/api/report/external-sku-ranking?${params.toString()}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [brand, platform, q, limit, message]);
  useEffect(() => { if (active) void load(); }, [active, load]);

  const doExport = async () => {
    try {
      const params = new URLSearchParams({ platform, limit: "5000" });
      if (brand) params.set("brand", brand);
      if (q) params.set("q", q);
      const all = await fetchJson<Data>(`/api/report/external-sku-ranking?${params.toString()}`);
      exportCsv(
        `SKU外部销量排名-${all.anchorDate ?? ""}`,
        ["排名", "SKU编码", "名称", "品牌", "近30天净件数", "近90天净件数", "天猫30天", "拼多多30天", "天猫90天", "拼多多90天", "最近售出", "近90天动销天数", "平台SKU数", `内部近3月(${all.internalMonths.join("~") || "无"})`],
        all.rows.map((r) => [r.rank, r.code, r.name, r.brand, r.net30, r.net90, r.tmallNet30, r.pddNet30, r.tmallNet90, r.pddNet90, r.lastSoldDate, r.activeDays90, r.platformSkus, r.internal3m]),
        all.rows.length < all.totalRows ? `……仅导出前 ${all.rows.length} 行，共 ${all.totalRows} 行` : undefined,
      );
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const cols: ColumnsType<ExternalSkuRankRow> = [
    { title: "#", dataIndex: "rank", width: 56, align: "right", fixed: "left" },
    { title: "SKU", dataIndex: "code", width: 130, fixed: "left", render: (v: string) => <SkuHoverCard code={v} /> },
    { title: "名称", dataIndex: "name", ellipsis: true, width: 220 },
    { title: "品牌", dataIndex: "brand", width: 90, render: (v: string | null) => v ?? <Typography.Text type="secondary">—</Typography.Text> },
    { title: "近30天净件数", dataIndex: "net30", width: 120, align: "right", sorter: (a, b) => a.net30 - b.net30, render: (v: number) => <Typography.Text strong>{formatQty(v)}</Typography.Text> },
    { title: "近90天", dataIndex: "net90", width: 100, align: "right", sorter: (a, b) => a.net90 - b.net90, render: (v: number) => formatQty(v) },
    { title: "天猫30天", dataIndex: "tmallNet30", width: 100, align: "right", render: (v: number) => formatQty(v) },
    { title: "拼多多30天", dataIndex: "pddNet30", width: 110, align: "right", render: (v: number) => formatQty(v) },
    { title: "最近售出", dataIndex: "lastSoldDate", width: 110, render: (v: string | null) => v ?? "—" },
    { title: "90天动销天数", dataIndex: "activeDays90", width: 110, align: "right" },
    { title: "平台SKU数", dataIndex: "platformSkus", width: 100, align: "right" },
    {
      title: `内部近3月${data?.internalMonths.length ? `（${data.internalMonths[0]}~${data.internalMonths[data.internalMonths.length - 1]}）` : ""}`,
      dataIndex: "internal3m", width: 170, align: "right",
      render: (v: number | null) => v == null ? <Typography.Text type="secondary">无内部事实</Typography.Text> : formatQty(v),
    },
  ];
  const cov = data?.coverage;
  const covPct = cov && cov.platformSkus > 0 ? Math.round((cov.mappedPlatformSkus / cov.platformSkus) * 1000) / 10 : null;
  return (
    <Card
      size="small"
      title="SKU 外部销量排名 · 天猫+拼多多（观察口径）"
      extra={<Space><Tag color="warning">observation_only</Tag><Button size="small" onClick={() => void doExport()} disabled={!data || data.state !== "ready"}>导出 CSV</Button><Button size="small" onClick={() => void load()} loading={loading}>刷新</Button></Space>}
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Row gutter={[10, 10]} className="compact-kpi-row">
          <Col xs={12} lg={6}><Card size="small"><Statistic title="进入排名的系统 SKU" value={data?.state === "ready" ? data.totalRows : "—"} /><Typography.Text type="secondary">锚点 {data?.anchorDate ?? "—"}</Typography.Text></Card></Col>
          <Col xs={12} lg={6}><Card size="small"><Statistic title="平台 SKU 身份覆盖" value={covPct == null ? "—" : covPct} suffix={covPct == null ? undefined : "%"} /><Typography.Text type="secondary">{cov ? `${cov.mappedPlatformSkus}/${cov.platformSkus}，组合装拆解 ${cov.bundlePlatformSkus}` : "—"}</Typography.Text></Card></Col>
          <Col xs={12} lg={6}><Card size="small"><Statistic title="天猫日销截止" value={data?.sourceAsOf ?? "—"} /><Typography.Text type="secondary">拼多多 {data?.pddSourceAsOf ?? "未同步"}</Typography.Text></Card></Col>
          <Col xs={12} lg={6}><Card size="small"><Statistic title="拼多多 30 天观测日" value={cov ? cov.pddObservedDays30 : "—"} suffix={cov ? "/ 30" : undefined} /><Typography.Text type="secondary">{cov?.pddWindowComplete30 ? "窗口完整" : "窗口不完整（件数偏低）"}</Typography.Text></Card></Col>
        </Row>
        <Space wrap>
          <Select
            allowClear
            showSearch
            placeholder="全部品牌"
            style={{ width: 160 }}
            value={brand || undefined}
            options={(data?.brands ?? []).map((b) => ({ value: b, label: b }))}
            onChange={(v) => setBrand(v ?? "")}
          />
          <Select
            style={{ width: 150 }}
            value={platform}
            options={[{ value: "all", label: "天猫+拼多多" }, { value: "tmall", label: "只看天猫有售" }, { value: "pdd", label: "只看拼多多有售" }]}
            onChange={(v) => setPlatform(v)}
          />
          <SearchInput allowClear placeholder="搜索 SKU 编码/名称" style={{ width: 240 }} onSearch={(v) => setQ(v.trim())} />
          <Select style={{ width: 120 }} value={limit} options={[50, 100, 300, 1000].map((n) => ({ value: n, label: `前 ${n} 名` }))} onChange={(v) => setLimit(v)} />
        </Space>
        <Table<ExternalSkuRankRow>
          rowKey="skuId"
          size="small"
          loading={loading}
          columns={cols}
          dataSource={data?.rows ?? []}
          pagination={{ pageSize: 50, showSizeChanger: false }}
          scroll={{ x: 1500 }}
        />
        <Alert type={data?.state === "ready" ? "info" : "warning"} showIcon message={data?.gate ?? "正在读取外部销速读模型。"} />
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {(data?.limitations ?? []).map((l) => <div key={l}>· {l}</div>)}
        </Typography.Paragraph>
      </Space>
    </Card>
  );
}
