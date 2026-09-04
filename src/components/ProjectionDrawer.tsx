"use client";

/** #1 库存未来曲线抽屉：projected on-hand 逐日曲线 + 断货日/建议下单日标注（对标 Kinaxis projected on-hand）。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, App, Button, Card, DatePicker, Drawer, Empty, Input, InputNumber, Select, Space, Spin, Statistic, Table, Tag, Typography } from "antd";
import type { Dayjs } from "dayjs";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fetchJson, postJson } from "@/components/fetchJson";
import DecisionVisual from "@/components/DecisionVisual";
import { VISUAL_COLOR } from "@/components/decision-visuals";

interface Point { date: string; onHand: number; arrival: number }
interface ProjectionBase {
  skuId: number; code: string; name: string;
  undatedInbound: number; today: string;
  points: Point[];
}
/**
 * 补货引擎未覆盖本 SKU（停用 / 非成品 / 未入选）：引擎口径的数**一个都没有**。
 * 用一个联合类型而不是「全 0」来表达这件事——0 会被读成「算过，结果是 0」，
 * 于是抽屉给一个从未被计算的 SKU 画出平线并宣布「视野内不会跌破安全库存」。
 */
interface ProjectionUncovered extends ProjectionBase {
  engineCovered: false;
  engineCoverageNote: string | null;
}
interface ProjectionCovered extends ProjectionBase {
  engineCovered?: true;
  engineCoverageNote?: null;
  startOnHand: number; bookOnHand: number; expiringUnsellable: number;
  daily: number; leadDays: number | null; safetyQty: number;
  stockoutDate: string | null; daysToStockout: number | null;
  /** 首次跌破安全库存（唯一权威 rules/timephased，与补货行同源同值） */
  shortageDate: string | null; daysToShortage: number | null;
  orderByDate: string | null; orderWindowMissed: boolean;
}
type Projection = ProjectionCovered | ProjectionUncovered;

interface ScenarioInputs {
  extraInboundQty?: number;
  extraInboundDate?: string;
  dailyOverride?: number;
}

interface SavedScenario {
  id: number;
  name: string;
  inputs: ScenarioInputs;
  /* 已保存的情景快照只可能来自**引擎覆盖**的 SKU（沙盘入口本身在覆盖分支里），
     故按 ProjectionCovered 读取——未覆盖的 SKU 根本走不到保存情景那一步。 */
  baseline: ProjectionCovered;
  scenario: ProjectionCovered;
  sourceDate: string;
  createdByName: string | null;
  createdAt: string;
}

function describeInputs(inputs: ScenarioInputs): string {
  const parts: string[] = [];
  if (inputs.extraInboundQty != null && inputs.extraInboundDate) {
    parts.push(`${inputs.extraInboundDate} 到货 ${inputs.extraInboundQty.toLocaleString("zh-CN")}`);
  }
  if (inputs.dailyOverride != null) parts.push(`日均 ${inputs.dailyOverride.toLocaleString("zh-CN")}`);
  return parts.join("；") || "无有效变量";
}

export default function ProjectionDrawer({
  skuCode,
  open,
  onClose,
}: {
  skuCode: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const [data, setData] = useState<(Projection & { scenarioApplied?: boolean }) | null>(null);
  const [loading, setLoading] = useState(false);
  // #4 沙盘参数
  const [extraQty, setExtraQty] = useState<number | null>(null);
  const [extraDate, setExtraDate] = useState<Dayjs | null>(null);
  const [dailyOverride, setDailyOverride] = useState<number | null>(null);
  const [appliedInputs, setAppliedInputs] = useState<ScenarioInputs | null>(null);
  const [scenarioName, setScenarioName] = useState("");
  const [saved, setSaved] = useState<SavedScenario[]>([]);
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const projectionRequest = useRef<AbortController | null>(null);
  const savedRequest = useRef<AbortController | null>(null);

  const loadSaved = useCallback(async (): Promise<SavedScenario[]> => {
    if (!skuCode) return [];
    savedRequest.current?.abort();
    const request = new AbortController();
    savedRequest.current = request;
    setSavedLoading(true);
    try {
      const rows = await fetchJson<SavedScenario[]>(
        `/api/replenish/scenarios?sku=${encodeURIComponent(skuCode)}`,
        { signal: request.signal },
      );
      if (request.signal.aborted) return [];
      setSaved(rows);
      setCompareIds((current) => current.filter((id) => rows.some((row) => row.id === id)));
      return rows;
    } catch (error) {
      if (!request.signal.aborted) message.error((error as Error).message);
      return [];
    } finally {
      if (savedRequest.current === request) setSavedLoading(false);
    }
  }, [skuCode, message]);

  const fetchProj = useCallback(
    async (scenario?: { extraQty?: number | null; extraDate?: Dayjs | null; dailyOverride?: number | null }) => {
      if (!skuCode) return;
      projectionRequest.current?.abort();
      const request = new AbortController();
      projectionRequest.current = request;
      setLoading(true);
      const p = new URLSearchParams({ sku: skuCode, horizon: "120" });
      if (scenario?.extraQty && scenario.extraDate) {
        p.set("extraQty", String(scenario.extraQty));
        p.set("extraDate", scenario.extraDate.format("YYYY-MM-DD"));
      }
      if (scenario?.dailyOverride != null) p.set("dailyOverride", String(scenario.dailyOverride));
      const inputs: ScenarioInputs | null = scenario
        ? {
            extraInboundQty: scenario.extraQty ?? undefined,
            extraInboundDate: scenario.extraDate?.format("YYYY-MM-DD"),
            dailyOverride: scenario.dailyOverride ?? undefined,
          }
        : null;
      try {
        const result = await fetchJson<Projection & { scenarioApplied?: boolean }>(
          `/api/replenish/projection?${p.toString()}`,
          { signal: request.signal },
        );
        if (request.signal.aborted) return;
        setData(result);
        setAppliedInputs(result.scenarioApplied ? inputs : null);
      } catch (error) {
        if (!request.signal.aborted) message.error((error as Error).message);
      } finally {
        if (projectionRequest.current === request) setLoading(false);
      }
    },
    [skuCode, message],
  );

  useEffect(() => {
    if (!open || !skuCode) return;
    setData(null);
    setExtraQty(null);
    setExtraDate(null);
    setDailyOverride(null);
    setAppliedInputs(null);
    setScenarioName("");
    setCompareIds([]);
    void fetchProj();
    void loadSaved();
  }, [open, skuCode, fetchProj, loadSaved]);

  useEffect(() => () => {
    projectionRequest.current?.abort();
    savedRequest.current?.abort();
  }, []);

  const saveCurrent = async () => {
    if (!skuCode || !appliedInputs || !scenarioName.trim()) return;
    setSaving(true);
    try {
      const created = await postJson<SavedScenario>("/api/replenish/scenarios", {
        sku: skuCode,
        name: scenarioName.trim(),
        horizonDays: 120,
        ...appliedInputs,
        idempotencyKey: globalThis.crypto.randomUUID(),
      });
      message.success("情景已保存，可与历史方案并排比较");
      setScenarioName("");
      await loadSaved();
      setCompareIds((current) => [created.id, ...current.filter((id) => id !== created.id)].slice(0, 2));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const compared = compareIds
    .map((id) => saved.find((row) => row.id === id))
    .filter((row): row is SavedScenario => row != null);

  return (
    <Drawer
      title={data ? `库存未来曲线 · ${data.code} ${data.name}` : "库存未来曲线"}
      open={open}
      onClose={onClose}
      width="min(920px, 100vw)"
    >
      {loading ? (
        <div style={{ textAlign: "center", padding: 60 }}><Spin /></div>
      ) : !data ? (
        <Empty description="无数据" />
      ) : data.engineCovered === false ? (
        /* 引擎没算过这个 SKU：不画曲线、不给结论。此前这里落到 0/0/0 并显示绿色的
           「视野内水位始终不低于安全库存」——对一个从未被计算的 SKU，那是编出来的安心。 */
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Alert
            type="info"
            showIcon
            message="本 SKU 不在补货引擎覆盖范围内，没有可展示的库存曲线"
            description={
              <>
                <div>{data.engineCoverageNote ?? "补货引擎当前没有该 SKU 的行。"}</div>
                <div style={{ marginTop: 6 }}>
                  因此这里<b>不显示</b>在库/日均/安全库存/跌破日：这些数字系统从未为该 SKU 算过，
                  显示 0 会被读成「有算过，结果是 0」。
                  {data.undatedInbound > 0 ? `（另有 ${data.undatedInbound.toLocaleString("zh-CN")} 无确认到货日的在途量。）` : ""}
                </div>
              </>
            }
          />
        </Space>
      ) : (
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <Space size="large" wrap>
            <Statistic
              title="可用在库（曲线起点）"
              value={data.startOnHand}
              suffix={data.expiringUnsellable > 0 ? `／账面 ${data.bookOnHand.toLocaleString("zh-CN")}` : ""}
            />
            <Statistic title="日均消耗" value={data.daily} />
            <Statistic title="安全库存" value={data.safetyQty} />
            <Statistic
              title="跌破安全库存"
              value={data.shortageDate ?? "视野内不跌破"}
              valueStyle={{ color: data.shortageDate ? "#cf1322" : "#3f8600", fontSize: 18 }}
              suffix={data.daysToShortage != null ? `（${data.daysToShortage}天后）` : ""}
            />
            <Statistic
              title="最晚下单日"
              value={data.orderByDate ?? "—"}
              valueStyle={{ color: data.orderWindowMissed ? "#cf1322" : undefined, fontSize: 18 }}
            />
          </Space>
          {data.expiringUnsellable > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`账面在库 ${data.bookOnHand.toLocaleString("zh-CN")} 中有 ${data.expiringUnsellable.toLocaleString("zh-CN")} 在效期内卖不掉（临期净额），曲线起点按可用在库 ${data.startOnHand.toLocaleString("zh-CN")} 计——把临期货算成可用，就是"账上有货、货架断货"。`}
            />
          ) : null}
          {data.orderWindowMissed ? (
            <Alert type="error" showIcon message={`已错过下单窗口：总供应周期（生产+物流）${data.leadDays} 天，现在下单也赶不上 ${data.shortageDate} 跌破安全库存——建议紧急插单或调货。`} />
          ) : data.shortageDate && data.orderByDate ? (
            <Alert type="warning" showIcon message={`须在 ${data.orderByDate} 前下单（跌破安全库存日 ${data.shortageDate} 倒推总供应周期 ${data.leadDays} 天）。与补货建议行同源同值。`} />
          ) : data.shortageDate ? (
            <Alert type="warning" showIcon message={`预计 ${data.shortageDate} 跌破安全库存${data.daysToShortage != null ? `（${data.daysToShortage} 天后）` : ""}；该 SKU 无生产周期记录，无法倒推下单日——建议补录供应参数。`} />
          ) : (
            <Alert type="success" showIcon message="视野内水位始终不低于安全库存。" />
          )}
          {data.undatedInbound > 0 ? (
            <Alert
              type="info"
              showIcon
              message={`另有 ${data.undatedInbound.toLocaleString("zh-CN")} 在途量无确认到货日，未计入曲线（补录 PO 预计到货日后可纳入推演）。`}
            />
          ) : null}
          <DecisionVisual
            title="120 天投影在库"
            question="按当前销速与已确认供给，何时会断货，最晚何时必须下单？"
            metricId="coverFull"
            grain="SKU × 日"
            unit="基础单位数量"
            source={{
              tier: "derived",
              source: "当前库存 + 有日期未结供给 − 日均消耗",
              asOf: data.today,
            }}
            coverage={{ covered: data.points.length, total: 120, label: "投影视野天数" }}
            activeFilters={[data.scenarioApplied ? "What-if 沙盘" : "基准情景"]}
            summary={`${data.code} 可用在库 ${data.startOnHand.toLocaleString("zh-CN")}${data.expiringUnsellable > 0 ? `（账面 ${data.bookOnHand.toLocaleString("zh-CN")}，临期净额 ${data.expiringUnsellable.toLocaleString("zh-CN")}）` : ""}，日均消耗 ${data.daily.toLocaleString("zh-CN")}；${data.shortageDate ? `预计 ${data.shortageDate} 跌破安全库存` : "视野内不跌破安全库存"}；${data.orderByDate ? `最晚下单日 ${data.orderByDate}` : "暂无可计算下单日"}。`}
            caveat={`无日期在途 ${data.undatedInbound.toLocaleString("zh-CN")} 未计入；下单日与补货建议行同源（rules/timephased）；沙盘只推演、不落库、不自动下单。`}
            height={320}
            dataView={
              <Table<Point>
                rowKey="date"
                size="small"
                pagination={{ pageSize: 20, showSizeChanger: false }}
                dataSource={data.points}
                columns={[
                  { title: "日期", dataIndex: "date" },
                  { title: "投影在库", dataIndex: "onHand", align: "right" },
                  { title: "当日到货", dataIndex: "arrival", align: "right" },
                ]}
                scroll={{ y: 230 }}
              />
            }
          >
            <ResponsiveContainer>
              <AreaChart data={data.points} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="ohFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={VISUAL_COLOR.primary} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={VISUAL_COLOR.primary} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={40} />
                <YAxis tick={{ fontSize: 11 }} width={56} />
                <RTooltip
                  formatter={(v) => [Number(v).toLocaleString("zh-CN"), "投影在库"]}
                  labelFormatter={(l) => `日期 ${l}`}
                />
                <ReferenceLine y={0} stroke={VISUAL_COLOR.critical} strokeDasharray="4 2" />
                {data.safetyQty > 0 ? <ReferenceLine y={data.safetyQty} stroke={VISUAL_COLOR.warning} strokeDasharray="4 2" label={{ value: "安全库存", fontSize: 11, fill: VISUAL_COLOR.warning }} /> : null}
                {data.shortageDate ? <ReferenceLine x={data.shortageDate} stroke={VISUAL_COLOR.critical} label={{ value: "跌破安全线", fontSize: 11, fill: VISUAL_COLOR.critical }} /> : null}
                {data.orderByDate && !data.orderWindowMissed ? <ReferenceLine x={data.orderByDate} stroke={VISUAL_COLOR.warning} label={{ value: "下单", fontSize: 11, fill: VISUAL_COLOR.warning }} /> : null}
                <Area type="monotone" dataKey="onHand" stroke={VISUAL_COLOR.primary} fill="url(#ohFill)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </DecisionVisual>
          <Card size="small" title="What-if 沙盘（先推演，再保存证据）" style={{ background: "#fafafa" }}>
            <Space wrap align="end">
              <div>
                <div style={{ fontSize: 12, color: "#888" }}>假设到货量</div>
                <InputNumber min={0} value={extraQty} onChange={setExtraQty} style={{ width: 120 }} placeholder="件数" />
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#888" }}>到货日</div>
                <DatePicker value={extraDate} onChange={setExtraDate} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: "#888" }}>覆盖日均（如大促）</div>
                <InputNumber min={0} value={dailyOverride} onChange={setDailyOverride} style={{ width: 120 }} placeholder={String(data.daily)} />
              </div>
              <Button type="primary" onClick={() => void fetchProj({ extraQty, extraDate, dailyOverride })}>
                推演
              </Button>
              <Button
                onClick={() => { setExtraQty(null); setExtraDate(null); setDailyOverride(null); void fetchProj(); }}
              >
                重置
              </Button>
              {data.scenarioApplied ? <Tag color="purple">沙盘结果</Tag> : null}
            </Space>
            {data.scenarioApplied && appliedInputs ? (
              <Space wrap style={{ marginTop: 14 }}>
                <Input
                  value={scenarioName}
                  onChange={(event) => setScenarioName(event.target.value)}
                  maxLength={80}
                  placeholder="为当前结果命名，如：大促高销速 + 加急到货"
                  style={{ width: "min(360px, 100%)" }}
                  onPressEnter={() => void saveCurrent()}
                />
                <Button
                  onClick={() => void saveCurrent()}
                  loading={saving}
                  disabled={!scenarioName.trim()}
                >
                  保存当前情景
                </Button>
                <Typography.Text type="secondary">
                  保存的是当前已显示结果：{describeInputs(appliedInputs)}
                </Typography.Text>
              </Space>
            ) : null}
          </Card>
          <Card
            size="small"
            title={`已保存情景（${saved.length}）`}
            extra={<Button size="small" onClick={() => void loadSaved()} loading={savedLoading}>刷新</Button>}
          >
            {saved.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="运行并命名一个沙盘后，可在这里并排比较" />
            ) : (
              <Space direction="vertical" style={{ width: "100%" }} size="middle">
                <Select
                  mode="multiple"
                  value={compareIds}
                  onChange={(ids) => setCompareIds(ids.slice(-2))}
                  options={saved.map((row) => ({
                    value: row.id,
                    label: `${row.name} · ${row.sourceDate}`,
                  }))}
                  placeholder="选择最多两个情景并排比较"
                  maxTagCount={2}
                  style={{ width: "min(620px, 100%)" }}
                />
                {compared.length === 0 ? (
                  <Typography.Text type="secondary">请选择一至两个已保存情景。</Typography.Text>
                ) : (
                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(min(300px, 100%), 1fr))",
                    gap: 12,
                  }}>
                    {compared.map((row) => (
                      <Card key={row.id} size="small" title={row.name}>
                        <Space direction="vertical" style={{ width: "100%" }}>
                          <Typography.Text>{describeInputs(row.inputs)}</Typography.Text>
                          <Space size="large" wrap>
                            <Statistic
                              title="基准断货日"
                              value={row.baseline.stockoutDate ?? "视野内不断货"}
                              valueStyle={{ fontSize: 16 }}
                            />
                            <Statistic
                              title="情景断货日"
                              value={row.scenario.stockoutDate ?? "视野内不断货"}
                              valueStyle={{
                                fontSize: 16,
                                color: row.scenario.stockoutDate ? "#cf1322" : "#3f8600",
                              }}
                            />
                          </Space>
                          <Typography.Text type="secondary">
                            证据日 {row.sourceDate} · {row.createdByName ?? "未知用户"} · {new Date(row.createdAt).toLocaleString("zh-CN")}
                          </Typography.Text>
                        </Space>
                      </Card>
                    ))}
                  </div>
                )}
              </Space>
            )}
          </Card>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            口径：投影在库 = 当前在库 + 各日到货（有确认到货日的 PO/存量在途）− 日均消耗；曲线可为负（真实缺口，不夹到 0）。基准日 {data.today}。
          </Typography.Text>
        </Space>
      )}
    </Drawer>
  );
}
