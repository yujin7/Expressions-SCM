"use client";

/**
 * 选源决策辅助面板（W2 审计 6）——挂在「生成采购订单 / 加工通知单」弹窗里，
 * 也就是这套系统里**唯一一个真的在选供应商**的地方。
 *
 * 在此之前那里只有一个光秃秃的下拉框：基准价、学习交期 P90、历史观察 P50、OTIF、记分卡等级、
 * 是否已暂停/拉黑，系统里全都有，一样都没端到人眼前。
 *
 * 本面板**只读**：不排名次、不给「推荐」标记、不自动改表单——把事实摆出来，选谁仍由采购判断。
 * 金额由服务端按角色剥离（moneyVisible=false 时显示「无权限」，不是 0 也不是空）。
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, Card, Empty, Select, Space, Table, Tag, Tooltip, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { fetchJson } from "@/components/fetchJson";

interface Row {
  supplierId: number;
  code: string;
  name: string;
  statusLabel: string;
  blocked: boolean;
  price: string | null;
  priceCurrency: string | null;
  priceEffectiveDate: string | null;
  learnedLeadP50: number | null;
  learnedLeadP90: number | null;
  learnedSamples: number;
  observedLeadP50: number | null;
  observedSamples: number;
  observedLabel: string;
  otifRate: number | null;
  otifEvaluable: number;
  score: number | null;
  grade: string | null;
  currentLevel: string | null;
  openQualityCases: number | null;
}

interface Data {
  skuCode: string;
  skuName: string;
  baseUom: string;
  moneyVisible: boolean;
  otifBasisLabel: string;
  otifYear: number;
  rows: Row[];
  limitations: string[];
}

export interface SourcingSkuOption {
  value: number;
  label: string;
}

const dash = <Typography.Text type="secondary">—</Typography.Text>;

export default function SourcingAidPanel({ skuOptions }: { skuOptions: SourcingSkuOption[] }) {
  const [skuId, setSkuId] = useState<number | undefined>(skuOptions[0]?.value);
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // 物料行变了就跟着换默认项；用户手选过的值若仍在候选里则保留
    if (skuId == null || !skuOptions.some((o) => o.value === skuId)) setSkuId(skuOptions[0]?.value);
  }, [skuOptions, skuId]);

  const load = useCallback(async () => {
    if (skuId == null) { setData(null); return; }
    setLoading(true);
    setError(null);
    try {
      setData(await fetchJson<Data>(`/api/outsource/sourcing-aid?skuId=${skuId}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [skuId]);
  useEffect(() => { void load(); }, [load]);

  const columns: ColumnsType<Row> = [
    {
      title: "供应商", dataIndex: "code", width: 200,
      render: (v: string, r) => (
        <Space size={4}>
          <span>{v} {r.name}</span>
          {r.blocked ? <Tag color="red">{r.statusLabel}</Tag> : null}
        </Space>
      ),
    },
    {
      title: "基准价", dataIndex: "price", width: 140, align: "right",
      render: (v: string | null, r) => {
        if (!data?.moneyVisible) return <Typography.Text type="secondary">无权限</Typography.Text>;
        if (v == null) return <Tooltip title="采购价目表里没有该「物料 × 供应商」当前生效的基准价">{dash}</Tooltip>;
        return (
          <Tooltip title={`生效日 ${r.priceEffectiveDate ?? "—"}`}>
            <span>{Number(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {r.priceCurrency ?? ""}</span>
          </Tooltip>
        );
      },
    },
    {
      title: "学习交期 P90", dataIndex: "learnedLeadP90", width: 130, align: "right",
      render: (v: number | null, r) => (v == null
        ? <Tooltip title="系统内 PO→SH 履约样本不足">{dash}</Tooltip>
        : <Tooltip title={`P50 ${r.learnedLeadP50 ?? "—"} 天 · 样本 ${r.learnedSamples}`}><span>{v} 天</span></Tooltip>),
    },
    {
      title: <Tooltip title="来自简道云的外部观察，authority=observation_only：只观察不定量，不与系统事实混排">历史观察 P50</Tooltip>,
      dataIndex: "observedLeadP50", width: 130, align: "right",
      render: (v: number | null, r) => (v == null
        ? dash
        : (
          <Tooltip title={`${r.observedLabel} · 样本 ${r.observedSamples}`}>
            <Space size={4}><span>{v} 天</span><Tag>观察</Tag></Space>
          </Tooltip>
        )),
    },
    {
      title: `OTIF（${data?.otifBasisLabel ?? "原始承诺"}）`, dataIndex: "otifRate", width: 140, align: "right",
      render: (v: number | null, r) => (v == null
        ? <Tooltip title="该供应商本年度没有可评 PO">{dash}</Tooltip>
        : (
          <Tooltip title={`可评 ${r.otifEvaluable} 单（${data?.otifYear ?? ""} 年累计，供应商改期不抬高该值）`}>
            <Typography.Text style={{ color: v < 0.8 ? "#cf1322" : "#52c41a" }}>{(v * 100).toFixed(1)}%</Typography.Text>
          </Tooltip>
        )),
    },
    {
      title: "记分卡", dataIndex: "grade", width: 140,
      render: (v: string | null, r) => (v == null
        ? <Tooltip title="窗口内收货样本不足，不予评级（不是低分）">{dash}</Tooltip>
        : (
          <Space size={4}>
            <Tag color={v === "S" || v === "A" ? "green" : v === "B" ? "gold" : "red"}>{v}</Tag>
            <Typography.Text type="secondary">{r.score} 分</Typography.Text>
            {r.currentLevel && r.currentLevel !== v
              ? <Tooltip title={`档案等级 ${r.currentLevel} 与建议等级不一致`}><Tag>档案 {r.currentLevel}</Tag></Tooltip>
              : null}
          </Space>
        )),
    },
    {
      title: "在办质量案件", dataIndex: "openQualityCases", width: 120, align: "right",
      render: (v: number | null) => (v == null ? dash : <Typography.Text style={{ color: "#fa8c16" }}>{v} 件</Typography.Text>),
    },
  ];

  return (
    <Card size="small" title="选源参考（只读，不排名次）" style={{ marginBottom: 16 }}>
      <Space style={{ marginBottom: 8 }} wrap>
        <Typography.Text type="secondary">物料</Typography.Text>
        <Select
          value={skuId}
          onChange={setSkuId}
          options={skuOptions}
          style={{ width: 320 }}
          placeholder="选择要比对的物料"
          showSearch
          optionFilterProp="label"
        />
      </Space>
      {error ? <Alert type="error" showIcon message="选源参考加载失败" description={error} style={{ marginBottom: 8 }} /> : null}
      {skuOptions.length === 0 ? (
        <Empty description="先在下方添加物料行，再看该物料的候选供应商事实" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <>
          <Table<Row>
            rowKey="supplierId"
            size="small"
            loading={loading}
            columns={columns}
            dataSource={data?.rows ?? []}
            pagination={false}
            scroll={{ x: 1000, y: 220 }}
            locale={{ emptyText: "该物料在系统内既无价目表基准价、也无历史采购行——这是首次寻源，没有可比事实" }}
          />
          {data?.limitations.length ? (
            <details style={{ marginTop: 8 }}>
              <summary><Typography.Text type="secondary">口径与限制</Typography.Text></summary>
              <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                {data.limitations.map((l) => (
                  <li key={l}><Typography.Text type="secondary">{l}</Typography.Text></li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </Card>
  );
}
