"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Drawer,
  Input,
  Modal,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { CameraOutlined, ReloadOutlined } from "@ant-design/icons";

import CaliberNote from "@/components/CaliberNote";
import { fetchJson, postJson } from "@/components/fetchJson";
import ListToolbar from "@/components/ListToolbar";
import SearchInput from "@/components/SearchInput";
import { useListState } from "@/components/useListState";

type DiffCategory = "new_alert" | "resolved" | "worsened" | "improved" | "mixed" | "stable";

interface PlanningVersion {
  id: number;
  name: string;
  weekStart: string;
  engineVersion: string;
  lineCount: number;
  suggestedCount: number;
  suppressedCount: number;
  digest: string;
  createdBy: number;
  createdByName: string | null;
  createdAt: string;
  parameters: unknown;
  sourceMeta: unknown;
}

interface SnapshotLine {
  skuId: number;
  skuCode: string;
  skuName: string;
  brand: string | null;
  baseUom: string;
  suggestedQty: string;
  suppressed: boolean;
  shortageDate: string | null;
  orderByDate: string | null;
  orderWindowMissed: boolean;
  coverFull: string | null;
}

interface DiffRow {
  key: string;
  skuId: number;
  skuCode: string;
  skuName: string;
  brand: string | null;
  baseUom: string;
  category: DiffCategory;
  signals: string[];
  base: SnapshotLine | null;
  current: SnapshotLine | null;
}

interface DiffData {
  current: PlanningVersion;
  base: PlanningVersion | null;
  rows: DiffRow[];
  summary: Record<DiffCategory, number> & { total: number };
}

interface PeggingRow {
  id: number;
  planningLineId: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  evidenceDigest: string;
  demandDate: string;
  demandQty: string;
  sourceType: string;
  sourceRef: string | null;
  supplyDate: string | null;
  availableQty: string;
  peggedQty: string;
  confidence: string;
  status: string;
  explanation: string;
}

interface PeggingData {
  version: PlanningVersion;
  mode: "demand_to_supply" | "supply_to_demand";
  query: { skuId: number | null; sourceType: string | null; sourceRef: string | null };
  summary: {
    demandQty: string;
    peggedQty: string;
    bookedQty: string;
    referenceQty: string;
    proposedQty: string;
    uncoveredQty: string;
    coveragePct: number;
    demandCount: number;
    linkCount: number;
  };
  rows: PeggingRow[];
}

const CATEGORY_META: Record<DiffCategory, { label: string; color: string }> = {
  new_alert: { label: "新增告急", color: "red" },
  resolved: { label: "已解除", color: "green" },
  worsened: { label: "恶化", color: "volcano" },
  improved: { label: "改善", color: "cyan" },
  mixed: { label: "混合变化", color: "gold" },
  stable: { label: "稳定", color: "default" },
};

const SOURCE_LABEL: Record<string, string> = {
  on_hand: "记账在库",
  po: "采购在途",
  wo: "委外在制",
  legacy_fg: "存量登记",
  recommended_replenishment: "拟补货",
  held_recommendation: "被抑制建议",
};

const CONFIDENCE_META: Record<string, { label: string; color: string }> = {
  booked: { label: "记账/确认", color: "blue" },
  reference: { label: "参考", color: "gold" },
  proposed: { label: "拟议", color: "purple" },
  suppressed: { label: "抑制", color: "default" },
};

const DATE_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function versionLabel(version: PlanningVersion): string {
  return `${version.name} · ${DATE_TIME.format(new Date(version.createdAt))} · ${version.lineCount} 项`;
}

function qty(line: SnapshotLine | null, uom: string): React.ReactNode {
  if (!line) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Space size={4}>
      <Typography.Text>{Number(line.suggestedQty).toLocaleString("zh-CN")}</Typography.Text>
      <Typography.Text type="secondary">{uom}</Typography.Text>
      {line.suppressed ? <Tag>抑制</Tag> : null}
    </Space>
  );
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

export default function PlanVersionsClient({ canCapture }: { canCapture: boolean }) {
  const { message } = App.useApp();
  const listState = useListState({
    key: "planning-versions",
    defaults: { currentId: "", baseId: "", category: "all", q: "" },
    defaultPageSize: 50,
  });
  const { filters, setFilter } = listState;
  const initialCurrentId = useRef(filters.currentId);
  const [versions, setVersions] = useState<PlanningVersion[]>([]);
  const [data, setData] = useState<DiffData | null>(null);
  const [loadingVersions, setLoadingVersions] = useState(true);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureName, setCaptureName] = useState("");
  const [captureKey, setCaptureKey] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [peggingOpen, setPeggingOpen] = useState(false);
  const [peggingLoading, setPeggingLoading] = useState(false);
  const [pegging, setPegging] = useState<PeggingData | null>(null);

  const refreshVersions = useCallback(async (signal?: AbortSignal): Promise<PlanningVersion[]> => {
    const result = await fetchJson<{ versions: PlanningVersion[] }>("/api/replenish/versions", { signal });
    setVersions(result.versions);
    return result.versions;
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoadingVersions(true);
    setLoadError(null);
    void refreshVersions(controller.signal)
      .then((items) => {
        if (!initialCurrentId.current && items[0]) {
          setFilter({
            currentId: String(items[0].id),
            baseId: items[1] ? String(items[1].id) : "",
          });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setVersions([]);
          setData(null);
          setLoadError(error instanceof Error ? error.message : "计划版本加载失败");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingVersions(false);
      });
    return () => controller.abort();
  }, [refreshVersions, reloadKey, setFilter]);

  useEffect(() => {
    const currentId = Number(filters.currentId);
    if (!Number.isInteger(currentId) || currentId <= 0) {
      setData(null);
      return;
    }
    const controller = new AbortController();
    setLoadingDiff(true);
    setLoadError(null);
    const params = new URLSearchParams({ currentId: String(currentId) });
    if (filters.baseId) params.set("baseId", filters.baseId);
    void fetchJson<DiffData>(`/api/replenish/versions/diff?${params}`, { signal: controller.signal })
      .then(setData)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setData(null);
          setLoadError(error instanceof Error ? error.message : "版本差异加载失败");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDiff(false);
      });
    return () => controller.abort();
  }, [filters.baseId, filters.currentId, reloadKey]);

  const visibleRows = useMemo(() => {
    const needle = filters.q.trim().toLocaleLowerCase("zh-CN");
    return (data?.rows ?? []).filter((row) => {
      if (filters.category !== "all" && row.category !== filters.category) return false;
      if (!needle) return true;
      return [row.skuCode, row.skuName, row.brand ?? "", ...row.signals]
        .some((value) => value.toLocaleLowerCase("zh-CN").includes(needle));
    });
  }, [data, filters.category, filters.q]);

  const loadPegging = useCallback(async (query: {
    versionId: number;
    skuId?: number;
    sourceType?: string;
    sourceRef?: string;
  }) => {
    setPeggingOpen(true);
    setPeggingLoading(true);
    try {
      const params = new URLSearchParams({ versionId: String(query.versionId) });
      if (query.skuId != null) params.set("skuId", String(query.skuId));
      if (query.sourceType && query.sourceRef) {
        params.set("sourceType", query.sourceType);
        params.set("sourceRef", query.sourceRef);
      }
      setPegging(await fetchJson<PeggingData>(`/api/replenish/versions/pegging?${params}`));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "供需追溯加载失败");
    } finally {
      setPeggingLoading(false);
    }
  }, [message]);

  const columns: ColumnsType<DiffRow> = useMemo(() => [
    {
      title: "变化",
      dataIndex: "category",
      width: 110,
      fixed: "left",
      sorter: (a, b) => CATEGORY_META[a.category].label.localeCompare(CATEGORY_META[b.category].label),
      render: (value: DiffCategory) => <Tag color={CATEGORY_META[value].color}>{CATEGORY_META[value].label}</Tag>,
    },
    { title: "SKU 编码", dataIndex: "skuCode", width: 130, fixed: "left", sorter: (a, b) => a.skuCode.localeCompare(b.skuCode) },
    { title: "名称", dataIndex: "skuName", width: 260, ellipsis: true, sorter: (a, b) => a.skuName.localeCompare(b.skuName) },
    { title: "品牌", dataIndex: "brand", width: 120, sorter: (a, b) => (a.brand ?? "").localeCompare(b.brand ?? ""), render: (value: string | null) => value ?? "—" },
    {
      title: "建议量",
      children: [
        { title: "基准", width: 145, render: (_, row) => qty(row.base, row.baseUom) },
        { title: "本版", width: 145, render: (_, row) => qty(row.current, row.baseUom) },
      ],
    },
    {
      title: "预计短缺日",
      children: [
        { title: "基准", width: 115, render: (_, row) => row.base?.shortageDate ?? "—" },
        { title: "本版", width: 115, render: (_, row) => row.current?.shortageDate ?? "—" },
      ],
    },
    {
      title: "变化证据",
      dataIndex: "signals",
      width: 280,
      render: (signals: string[]) => (
        <Space size={[4, 4]} wrap>
          {signals.length > 0
            ? signals.map((signal) => <Tag key={signal}>{signal}</Tag>)
            : <Typography.Text type="secondary">核心建议事实未变化</Typography.Text>}
        </Space>
      ),
    },
    {
      title: "供需",
      key: "pegging",
      width: 104,
      fixed: "right",
      render: (_, row) => {
        const versionId = row.current ? data?.current.id : data?.base?.id;
        return versionId ? (
          <Button type="link" size="small" onClick={() => void loadPegging({ versionId, skuId: row.skuId })}>
            双向追溯
          </Button>
        ) : "—";
      },
    },
  ], [data, loadPegging]);

  const openCapture = () => {
    setCaptureName("");
    setCaptureKey(globalThis.crypto.randomUUID());
    setCaptureOpen(true);
  };

  const capture = async () => {
    if (!captureKey) return;
    setCapturing(true);
    try {
      const created = await postJson<PlanningVersion>("/api/replenish/versions", {
        idempotencyKey: captureKey,
        name: captureName.trim() || undefined,
      });
      const items = await refreshVersions();
      const previous = items.find((item) => item.id !== created.id);
      setFilter({
        currentId: String(created.id),
        baseId: previous ? String(previous.id) : "",
      });
      setCaptureOpen(false);
      message.success(`已保存计划版本「${created.name}」`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存计划版本失败");
    } finally {
      setCapturing(false);
    }
  };

  const exportVisible = () => {
    const headers = ["变化", "SKU编码", "名称", "品牌", "基准建议量", "本版建议量", "单位", "基准短缺日", "本版短缺日", "变化证据"];
    const csv = [
      headers.map(csvCell).join(","),
      ...visibleRows.map((row) => [
        CATEGORY_META[row.category].label,
        row.skuCode,
        row.skuName,
        row.brand,
        row.base?.suggestedQty,
        row.current?.suggestedQty,
        row.baseUom,
        row.base?.shortageDate,
        row.current?.shortageDate,
        row.signals.join("；"),
      ].map(csvCell).join(",")),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `计划版本差异-${data?.current.weekStart ?? "export"}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const baseOptions = versions
    .filter((version) => String(version.id) !== filters.currentId)
    .map((version) => ({ value: String(version.id), label: versionLabel(version) }));

  return (
    <div className="plan-version-page">
      <div className="dashboard-header">
        <div className="dashboard-header__copy">
          <Typography.Title level={4} className="dashboard-header__title">计划版本与周差异</Typography.Title>
          <CaliberNote
            summary="把每次计划例会看到的补货建议冻结为不可回算的证据集，直接回答哪些 SKU 新增告急、已解除或恶化。"
            detail="版本捕获复用补货建议的全量权威口径；历史版本不按今天的库存和参数回算。变化以绝对短缺日、最晚下单日、建议量和抑制状态判断；周与周之间自然流逝的 7 天不会被误判为恶化。矛盾信号标为「混合变化」，由计划员复核。"
          />
        </div>
        {canCapture ? (
          <Button type="primary" icon={<CameraOutlined />} onClick={openCapture}>
            保存当前建议为版本
          </Button>
        ) : null}
      </div>

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="计划版本加载失败"
          description={loadError}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => setReloadKey((value) => value + 1)}>重试</Button>}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {!loadError && !loadingVersions && versions.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message="尚无计划版本"
          description={canCapture ? "保存一次当前建议，建立首个周度基线。" : "请由 PMC 保存首个计划版本。"}
          style={{ marginBottom: 12 }}
        />
      ) : null}
      {data && !data.base ? (
        <Alert
          type="info"
          showIcon
          message="当前版本是首个基线，全部建议显示为「新增告急」；保存下一版本后即可看到解除与恶化。"
          style={{ marginBottom: 12 }}
        />
      ) : null}

      <div className="plan-version-kpis">
        <Card size="small"><Statistic title="本版建议集" value={data ? data.current.lineCount : "—"} /></Card>
        <Card size="small"><Statistic title="新增告急" value={data ? data.summary.new_alert : "—"} valueStyle={{ color: data ? "#cf1322" : undefined }} /></Card>
        <Card size="small"><Statistic title="恶化" value={data ? data.summary.worsened : "—"} valueStyle={{ color: data ? "#d4380d" : undefined }} /></Card>
        <Card size="small"><Statistic title="已解除" value={data ? data.summary.resolved : "—"} valueStyle={{ color: data ? "#389e0d" : undefined }} /></Card>
        <Card size="small"><Statistic title="改善" value={data ? data.summary.improved : "—"} valueStyle={{ color: data ? "#08979c" : undefined }} /></Card>
        <Card size="small"><Statistic title="混合变化" value={data ? data.summary.mixed : "—"} valueStyle={{ color: data ? "#d48806" : undefined }} /></Card>
      </div>

      <ListToolbar
        state={listState}
        onExport={data ? exportVisible : undefined}
        exportText={`导出当前 ${visibleRows.length} 行`}
        extra={
          <>
            <Select
              loading={loadingVersions}
              value={filters.currentId || undefined}
              placeholder="选择当前版本"
              style={{ width: "min(100%, 300px)", minWidth: 0, flex: "1 1 220px" }}
              options={versions.map((version) => ({ value: String(version.id), label: versionLabel(version) }))}
              onChange={(value) => {
                const currentIndex = versions.findIndex((version) => String(version.id) === value);
                const fallbackBase = versions[currentIndex + 1];
                listState.setFilter({
                  currentId: value,
                  baseId: fallbackBase ? String(fallbackBase.id) : "",
                });
              }}
            />
            <Select
              allowClear
              value={filters.baseId || undefined}
              placeholder="自动选择上一版本"
              style={{ width: "min(100%, 300px)", minWidth: 0, flex: "1 1 220px" }}
              options={baseOptions}
              onChange={(value) => listState.setFilter({ baseId: value ?? "" })}
            />
            <Select
              value={filters.category}
              style={{ width: "min(100%, 150px)", minWidth: 0, flex: "0 1 130px" }}
              options={[
                { value: "all", label: "全部变化" },
                ...Object.entries(CATEGORY_META).map(([value, meta]) => ({ value, label: meta.label })),
              ]}
              onChange={(value) => listState.setFilter({ category: value })}
            />
            <SearchInput
              key={filters.q}
              allowClear
              defaultValue={filters.q}
              placeholder="搜索 SKU / 品牌 / 变化"
              style={{ width: "min(100%, 240px)", minWidth: 0, flex: "1 1 180px" }}
              onSearch={(value) => listState.setFilter({ q: value.trim() })}
            />
          </>
        }
      />

      <Table<DiffRow>
        rowKey="key"
        size={listState.tableSize}
        columns={columns}
        dataSource={visibleRows}
        loading={loadingVersions || loadingDiff}
        scroll={{ x: "max-content" }}
        pagination={listState.paginationProps({
          total: visibleRows.length,
          showTotal: (total) => `共 ${total} 个 SKU 变化`,
        })}
        locale={{ emptyText: loadError ? "数据未加载" : versions.length === 0 ? "尚无版本" : "当前筛选下没有差异" }}
      />

      <Modal
        title="保存当前补货建议为计划版本"
        open={captureOpen}
        onOk={() => void capture()}
        onCancel={() => setCaptureOpen(false)}
        confirmLoading={capturing}
        okText="保存版本"
        cancelText="取消"
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          message="系统将重新计算全部在售成品，并只保存已触发或被覆盖缺口抑制的建议。历史版本不可编辑。"
          style={{ marginBottom: 12 }}
        />
        <Typography.Text>版本名称（可选）</Typography.Text>
        <Input
          value={captureName}
          maxLength={80}
          placeholder="如：第 31 周计划例会"
          onChange={(event) => setCaptureName(event.target.value)}
          onPressEnter={() => void capture()}
          style={{ marginTop: 6 }}
        />
      </Modal>

      <Drawer
        title={pegging?.mode === "supply_to_demand" ? "供给反查需求" : "需求追溯供给"}
        width="min(1120px, 100vw)"
        open={peggingOpen}
        loading={peggingLoading}
        onClose={() => setPeggingOpen(false)}
        destroyOnHidden
      >
        {pegging ? (
          <>
            <Alert
              type="info"
              showIcon
              message={`不可变快照：${pegging.version.name}`}
              description="分配只使用保存版本当时的输入。无日期、晚到与被抑制供给显式保留但不计覆盖；拟补货仍须人工生成 BH 并审批。"
              style={{ marginBottom: 16 }}
            />
            <Descriptions
              size="small"
              bordered
              column={{ xs: 1, sm: 2, lg: 3 }}
              style={{ marginBottom: 16 }}
              items={[
                { key: "demand", label: "需求桶", children: Number(pegging.summary.demandQty).toLocaleString("zh-CN") },
                { key: "coverage", label: "总覆盖", children: `${Number(pegging.summary.peggedQty).toLocaleString("zh-CN")}（${pegging.summary.coveragePct}%）` },
                { key: "uncovered", label: "未覆盖", children: Number(pegging.summary.uncoveredQty).toLocaleString("zh-CN") },
                { key: "booked", label: "记账/确认覆盖", children: Number(pegging.summary.bookedQty).toLocaleString("zh-CN") },
                { key: "reference", label: "参考覆盖", children: Number(pegging.summary.referenceQty).toLocaleString("zh-CN") },
                { key: "proposed", label: "拟议覆盖", children: Number(pegging.summary.proposedQty).toLocaleString("zh-CN") },
              ]}
            />
            {pegging.mode === "supply_to_demand" ? (
              <Button
                size="small"
                style={{ marginBottom: 12 }}
                onClick={() => {
                  const skuId = pegging.rows[0]?.skuId;
                  if (skuId != null) void loadPegging({ versionId: pegging.version.id, skuId });
                }}
              >
                返回需求 → 供给
              </Button>
            ) : null}
            <Table<PeggingRow>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={pegging.rows}
              scroll={{ x: 1155 }}
              locale={{ emptyText: "该历史版本没有 pegging 证据；请保存一个新版本。" }}
              columns={[
                { title: "需求 SKU", dataIndex: "skuCode", width: 105, fixed: "left" },
                { title: "需求日", dataIndex: "demandDate", width: 105 },
                {
                  title: "来源",
                  dataIndex: "sourceType",
                  width: 100,
                  render: (value: string) => SOURCE_LABEL[value] ?? value,
                },
                {
                  title: "供给编号",
                  dataIndex: "sourceRef",
                  width: 120,
                  render: (value: string | null, row) => value ? (
                    <Button
                      type="link"
                      size="small"
                      style={{ paddingInline: 0 }}
                      onClick={() => void loadPegging({
                        versionId: pegging.version.id,
                        sourceType: row.sourceType,
                        sourceRef: value,
                      })}
                    >
                      {value}
                    </Button>
                  ) : "—",
                },
                { title: "到货日", dataIndex: "supplyDate", width: 105, render: (value: string | null) => value ?? "—" },
                {
                  title: "可用量",
                  dataIndex: "availableQty",
                  width: 90,
                  align: "right",
                  render: (value: string) => Number(value).toLocaleString("zh-CN"),
                },
                {
                  title: "分配量",
                  dataIndex: "peggedQty",
                  width: 90,
                  align: "right",
                  render: (value: string) => Number(value).toLocaleString("zh-CN"),
                },
                {
                  title: "证据级别",
                  dataIndex: "confidence",
                  width: 100,
                  render: (value: string) => {
                    const meta = CONFIDENCE_META[value] ?? { label: value, color: "default" };
                    return <Tag color={meta.color}>{meta.label}</Tag>;
                  },
                },
                {
                  title: "状态",
                  dataIndex: "status",
                  width: 100,
                  render: (value: string) => ({
                    pegged: "已分配",
                    partial: "部分分配",
                    excess: "超出需求",
                    excluded_undated: "缺到货日",
                    excluded_late: "晚于需求",
                    suppressed: "已抑制",
                  })[value] ?? value,
                },
                { title: "解释", dataIndex: "explanation", width: 240 },
              ]}
            />
          </>
        ) : null}
      </Drawer>
    </div>
  );
}
