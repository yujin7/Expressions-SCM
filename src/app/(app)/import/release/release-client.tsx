"use client";

/**
 * 放行工作台：staging → 正式主档/参考层/快照 的人工闸操作面。
 * 纪律（与引擎一致）：
 * - 每个数据集先「预演」（dry-run，零写入）再「执行」；
 * - SPU review 簇、BOM 歧义块必须显式勾选裁决——工作台把裁决做成可见选择，不是自动跳过；
 * - BOM 生效是审批动作（PMC 审批人，SoD：不能生效本人放行的批次）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Collapse,
  DatePicker,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import { CaretRightOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import { fetchJson } from "@/components/fetchJson";

interface StatusTable {
  targetTable: string;
  staged: number;
  committed: number;
  error: number;
  blockedReasons: { reason: string; count: number }[];
}

const TABLE_LABELS: Record<string, string> = {
  spu_suggestion: "SPU 归组建议",
  bom_block: "BOM 块",
  processing_fee_candidate: "加工费候选",
  batch_stock: "批次效期",
  sales_monthly: "月销量",
  stock_opening_candidate: "库存明细（期初/快照）",
  sku_leadtime: "交期参考（起订量已放行；周期 1.1）",
  transit_ref: "在途参考（成品/包材/备料/OEM）",
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `请求失败（${res.status}）`);
  return data;
}

/** 一个数据集的操作卡：预演 → 结果摘要 → 执行 */
function useAction() {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const run = useCallback(
    async (url: string, body: Record<string, unknown>, onDone?: (r: Record<string, unknown>) => void) => {
      setBusy(true);
      try {
        const r = await postJson<Record<string, unknown>>(url, body);
        setResult(r);
        onDone?.(r);
        message.success(body.dryRun ? "预演完成（零写入）" : "已执行");
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [message],
  );
  return { busy, result, run, setResult };
}

function ResultLine({ result, pick }: { result: Record<string, unknown> | null; pick: [string, string][] }) {
  if (!result) return null;
  return (
    <Space wrap size={6} style={{ marginTop: 8 }}>
      {result.dryRun != null && <Tag color={result.dryRun ? "blue" : "green"}>{result.dryRun ? "预演" : "已执行"}</Tag>}
      {pick.map(([key, label]) => {
        const v = result[key];
        if (v == null) return null;
        const n = Array.isArray(v) ? v.length : typeof v === "object" ? JSON.stringify(v) : String(v);
        return (
          <Tag key={key}>
            {label} {String(n)}
          </Tag>
        );
      })}
    </Space>
  );
}

export default function ReleaseClient() {
  const { message } = App.useApp();
  const [status, setStatus] = useState<StatusTable[]>([]);
  const [loading, setLoading] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchJson<{ tables: StatusTable[] }>("/api/release/status");
      setStatus(r.tables);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  /* SPU：预演出 review 簇 → 勾选接受 → 执行 */
  const spu = useAction();
  const [spuChecked, setSpuChecked] = useState<Set<string>>(new Set());
  const spuReview = useMemo(
    () => (spu.result?.needsReview as { spuKey: string; members: string[]; reason: string }[] | undefined) ?? [],
    [spu.result],
  );

  /* SKU / 费用 / 批次 / 月销：直接预演-执行 */
  const sku = useAction();
  const fee = useAction();
  const batch = useAction();
  const sales = useAction();

  /* BOM：预演出歧义块 → 勾选「按推荐裁决」 → 执行 → 生效 */
  const bom = useAction();
  const bomActivate = useAction();
  const [useRecommended, setUseRecommended] = useState(true);
  const bomAmbiguous = useMemo(() => {
    const blocked = (bom.result?.blocked as { stagingRowId: number; productCode: string | null; reason: string }[] | undefined) ?? [];
    return blocked.filter((b) => b.reason.includes("歧义"));
  }, [bom.result]);
  /** 推荐裁决：同产品按出现顺序，最后一块=现行，其余=退役（表内越靠后越新） */
  const recommendedResolutions = useMemo(() => {
    const byProduct = new Map<string, number[]>();
    for (const b of bomAmbiguous) {
      if (!b.productCode) continue;
      const l = byProduct.get(b.productCode) ?? [];
      l.push(b.stagingRowId);
      byProduct.set(b.productCode, l);
    }
    const res: Record<string, { decision: "active" | "retired" }> = {};
    for (const list of byProduct.values()) {
      list.forEach((id, i) => {
        res[String(id)] = { decision: i === list.length - 1 ? "active" : "retired" };
      });
    }
    return res;
  }, [bomAmbiguous]);
  const bomRunId = bom.result?.releaseRunId as number | null | undefined;

  /* 快照刷新 */
  const snap = useAction();
  const [bizDate, setBizDate] = useState<Dayjs>(dayjs());

  const statusCols: ColumnsType<StatusTable> = [
    { title: "数据集", dataIndex: "targetTable", render: (v: string) => TABLE_LABELS[v] ?? v },
    { title: "待放行", dataIndex: "staged", align: "right", render: (v: number) => (v > 0 ? <Tag color="orange">{v}</Tag> : v) },
    { title: "已放行", dataIndex: "committed", align: "right" },
    { title: "拒收", dataIndex: "error", align: "right", render: (v: number) => (v > 0 ? <Tag color="red">{v}</Tag> : v) },
    {
      title: "阻塞原因（TOP）",
      dataIndex: "blockedReasons",
      render: (v: StatusTable["blockedReasons"]) =>
        v.length === 0 ? "—" : (
          <Space direction="vertical" size={0}>
            {v.slice(0, 3).map((r, i) => (
              <Typography.Text key={i} type="secondary" style={{ fontSize: 12 }}>
                {r.reason}（{r.count}）
              </Typography.Text>
            ))}
            {v.length > 3 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                … 共 {v.length} 类
              </Typography.Text>
            )}
          </Space>
        ),
    },
  ];

  return (
    <div>
      <Space align="baseline" style={{ justifyContent: "space-between", width: "100%" }}>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          放行工作台
        </Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={() => void loadStatus()} loading={loading}>
          刷新状态
        </Button>
      </Space>
      <Alert
        type="info"
        showIcon
        style={{ margin: "8px 0 16px" }}
        message="每个数据集先「预演」（零写入，出裁决清单），再「执行」。SPU 歧义簇与 BOM 歧义块必须显式勾选裁决——引擎绝不代劳；执行后主档生效走红字/重导可改判。"
      />

      <Table<StatusTable>
        rowKey="targetTable"
        size="small"
        columns={statusCols}
        dataSource={status}
        loading={loading}
        pagination={false}
        style={{ marginBottom: 16 }}
      />

      <Collapse
        defaultActiveKey={["snapshot"]}
        expandIcon={({ isActive }) => <CaretRightOutlined rotate={isActive ? 90 : 0} />}
        items={[
          {
            key: "snapshot",
            label: "快照仓刷新（日常运营环：新一期库存明细 → 全仓视图）",
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Space wrap>
                  <Typography.Text>数据日期（盘点/导出日）：</Typography.Text>
                  <DatePicker value={bizDate} onChange={(d) => d && setBizDate(d)} allowClear={false} />
                  <Button loading={snap.busy} onClick={() => void snap.run("/api/release/snapshots", { bizDate: bizDate.format("YYYY-MM-DD"), dryRun: true })}>
                    预演
                  </Button>
                  <Popconfirm
                    title={`确认按数据日期 ${bizDate.format("YYYY-MM-DD")} 刷新快照？同键覆盖，重导幂等。`}
                    onConfirm={() => void snap.run("/api/release/snapshots", { bizDate: bizDate.format("YYYY-MM-DD"), dryRun: false }, () => void loadStatus())}
                  >
                    <Button type="primary" loading={snap.busy}>
                      执行刷新
                    </Button>
                  </Popconfirm>
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  只吃快照仓；自有仓行会被阻塞（日常出入必须走单据过账，防双套账）。
                </Typography.Text>
                <ResultLine result={snap.result} pick={[["upserts", "快照键"], ["rowsCommitted", "提交行"], ["zeroSkipped", "零量行"], ["blocked", "阻塞"]]} />
              </Space>
            ),
          },
          {
            key: "sales",
            label: "月销量（新月份销量表 → 同键覆盖更新）",
            children: (
              <Space direction="vertical">
                <Space>
                  <Button loading={sales.busy} onClick={() => void sales.run("/api/release/sales-monthly", { dryRun: true })}>
                    预演
                  </Button>
                  <Button type="primary" loading={sales.busy} onClick={() => void sales.run("/api/release/sales-monthly", { dryRun: false }, () => void loadStatus())}>
                    执行
                  </Button>
                </Space>
                <ResultLine result={sales.result} pick={[["created", "新增"], ["updated", "更新"], ["blocked", "阻塞"], ["unresolved", "未解析"]]} />
              </Space>
            ),
          },
          {
            key: "batch",
            label: "批次效期（效期文件 → 参考层）",
            children: (
              <Space direction="vertical">
                <Space>
                  <Button loading={batch.busy} onClick={() => void batch.run("/api/release/batch-stocks", { dryRun: true })}>
                    预演
                  </Button>
                  <Button type="primary" loading={batch.busy} onClick={() => void batch.run("/api/release/batch-stocks", { dryRun: false }, () => void loadStatus())}>
                    执行
                  </Button>
                </Space>
                <ResultLine result={batch.result} pick={[["created", "新增批次"], ["blocked", "阻塞"], ["unresolved", "未解析"]]} />
              </Space>
            ),
          },
          {
            key: "spu",
            label: "SPU 归组（新 BOM 工作簿后：先 SPU → 再 SKU → 再 BOM）",
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Space>
                  <Button loading={spu.busy} onClick={() => { setSpuChecked(new Set()); void spu.run("/api/release/spus", { dryRun: true }); }}>
                    预演（出待裁决簇）
                  </Button>
                  <Button
                    type="primary"
                    loading={spu.busy}
                    onClick={() => {
                      const overrides: Record<string, { action: "accept" }> = {};
                      for (const k of spuChecked) overrides[k] = { action: "accept" };
                      void spu.run("/api/release/spus", { overrides, dryRun: false }, () => void loadStatus());
                    }}
                  >
                    执行（自动簇 + 已勾选簇）
                  </Button>
                </Space>
                {spuReview.length > 0 && (
                  <Table
                    rowKey="spuKey"
                    size="small"
                    pagination={{ pageSize: 8 }}
                    rowSelection={{
                      selectedRowKeys: [...spuChecked],
                      onChange: (keys) => setSpuChecked(new Set(keys as string[])),
                    }}
                    columns={[
                      { title: "簇键", dataIndex: "spuKey", width: 140 },
                      { title: "成员", dataIndex: "members", render: (v: string[]) => v.join("、") },
                      { title: "待裁决原因", dataIndex: "reason", width: 260 },
                    ]}
                    dataSource={spuReview}
                  />
                )}
                <ResultLine result={spu.result} pick={[["created", "建 SPU"], ["existing", "已放行"], ["merged", "并入"], ["needsReview", "待裁决"]]} />
              </Space>
            ),
          },
          {
            key: "sku",
            label: "SKU 建档（BOM 块成品+物料）",
            children: (
              <Space direction="vertical">
                <Space>
                  <Button loading={sku.busy} onClick={() => void sku.run("/api/release/skus", { dryRun: true })}>
                    预演
                  </Button>
                  <Button type="primary" loading={sku.busy} onClick={() => void sku.run("/api/release/skus", { dryRun: false }, () => void loadStatus())}>
                    执行
                  </Button>
                </Space>
                <ResultLine result={sku.result} pick={[["createdFinished", "成品"], ["createdMaterials", "物料"], ["existing", "已存在"], ["blocked", "阻塞"], ["uncoded", "无编码"]]} />
              </Space>
            ),
          },
          {
            key: "bom",
            label: "BOM 放行与生效（歧义块须显式裁决；生效=PMC 审批，SoD）",
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Space wrap>
                  <Button loading={bom.busy} onClick={() => void bom.run("/api/release/boms", { dryRun: true })}>
                    预演（出歧义清单）
                  </Button>
                  <Checkbox checked={useRecommended} onChange={(e) => setUseRecommended(e.target.checked)}>
                    歧义块按推荐裁决（表内最后一块=现行，其余退役）
                  </Checkbox>
                  <Popconfirm
                    title={`执行 BOM 放行？歧义块 ${bomAmbiguous.length} 个${useRecommended ? "按推荐裁决" : "不带裁决（将保持阻塞）"}。`}
                    onConfirm={() =>
                      void bom.run(
                        "/api/release/boms",
                        { resolutions: useRecommended ? recommendedResolutions : {}, dryRun: false },
                        () => void loadStatus(),
                      )
                    }
                  >
                    <Button type="primary" loading={bom.busy}>
                      执行放行（出候选 draft）
                    </Button>
                  </Popconfirm>
                </Space>
                {bomAmbiguous.length > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    message={`歧义块 ${bomAmbiguous.length} 个（${new Set(bomAmbiguous.map((b) => b.productCode)).size} 个产品）——勾选上方「按推荐裁决」或到复核清单逐个人工定夺`}
                  />
                )}
                <ResultLine result={bom.result} pick={[["created", "落库"], ["candidates", "候选"], ["retired", "退役"], ["blocked", "阻塞"], ["lineSkips", "行跳过"], ["releaseRunId", "批次号"]]} />
                {bomRunId != null && (
                  <Space>
                    <Button loading={bomActivate.busy} onClick={() => void bomActivate.run("/api/release/boms/activate", { releaseRunId: bomRunId, dryRun: true })}>
                      生效预演（出 10% 抽检样本）
                    </Button>
                    <Popconfirm
                      title="批量生效本批候选 BOM？需 PMC 审批人身份；不能生效本人放行的批次（SoD）。"
                      onConfirm={() => void bomActivate.run("/api/release/boms/activate", { releaseRunId: bomRunId, dryRun: false })}
                    >
                      <Button danger loading={bomActivate.busy}>
                        批量生效（审批动作）
                      </Button>
                    </Popconfirm>
                  </Space>
                )}
                <ResultLine result={bomActivate.result} pick={[["activated", "生效"], ["alreadyActive", "已生效"], ["skippedRetired", "跳过退役"], ["sample", "抽检样本"]]} />
              </Space>
            ),
          },
          {
            key: "fee",
            label: "加工费参考价（BOM 费用行 → R5 结算基准）",
            children: (
              <Space direction="vertical">
                <Space>
                  <Button loading={fee.busy} onClick={() => void fee.run("/api/release/fee-refs", { dryRun: true })}>
                    预演
                  </Button>
                  <Button type="primary" loading={fee.busy} onClick={() => void fee.run("/api/release/fee-refs", { dryRun: false }, () => void loadStatus())}>
                    执行
                  </Button>
                </Space>
                <ResultLine result={fee.result} pick={[["created", "新增"], ["existing", "已存在"], ["blocked", "阻塞"]]} />
              </Space>
            ),
          },
        ]}
      />
    </div>
  );
}
