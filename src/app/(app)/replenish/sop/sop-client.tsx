"use client";

import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Flex,
  Input,
  Modal,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Steps,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import CaliberNote from "@/components/CaliberNote";
import { fetchJson, postJson } from "@/components/fetchJson";
import { useMe } from "@/components/useMe";

type SopRole = "ops" | "pmc" | "finance";
type SopStatus = "consensus" | "frozen" | "executing" | "closed";

interface PlanVersion {
  id: number;
  name: string;
  weekStart: string;
  digest: string;
  lineCount: number;
  suggestedCount: number;
  suppressedCount: number;
  createdAt: string;
}

interface Decision {
  id: number;
  cycleVersion: number;
  role: SopRole;
  decision: "agree" | "reject";
  note: string | null;
  decidedByName: string | null;
  decidedAt: string;
  current: boolean;
}

interface Cycle {
  id: number;
  month: string;
  name: string;
  status: SopStatus;
  planningVersionId: number;
  planDigest: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  frozenAt: string | null;
  executingAt: string | null;
  closedAt: string | null;
  plan: PlanVersion;
  decisions: Decision[];
  currentDecisions: Partial<Record<SopRole, Decision>>;
  consensusReady: boolean;
}

interface Workspace {
  cycles: Cycle[];
  versions: PlanVersion[];
  limitations: string[];
}

/** W2-#4 冻结版本的执行通道：冻结让实时建议只读，执行必须从这里走，而不是挪到系统外。 */
interface FrozenLine {
  skuId: number;
  skuCode: string;
  skuName: string;
  baseUom: string;
  suggestedQty: string;
  suppressed: boolean;
  shortageDate: string | null;
  orderByDate: string | null;
  orderWindowMissed: boolean;
  drafted: boolean;
}

interface FrozenExecution {
  cycle: { id: number; month: string; name: string; status: SopStatus; planningVersionId: number; planDigest: string };
  lines: FrozenLine[];
  drafts: { docNo: string; bhId: number; lineCount: number; at: string; by: string | null }[];
}

const ROLE_META: Record<SopRole, { label: string; color: string }> = {
  ops: { label: "运营", color: "cyan" },
  pmc: { label: "PMC", color: "blue" },
  finance: { label: "财务", color: "purple" },
};

const STATUS_META: Record<SopStatus, { label: string; color: string; step: number }> = {
  consensus: { label: "共识中", color: "processing", step: 0 },
  frozen: { label: "已冻结", color: "warning", step: 1 },
  executing: { label: "执行中", color: "success", step: 2 },
  closed: { label: "已关闭", color: "default", step: 3 },
};

function formatTime(value: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "—";
}

export default function SopClient() {
  const { message } = App.useApp();
  const me = useMe();
  const canManage = Boolean(me?.roles.some((role) => role === "admin" || role === "pmc"));
  const signRoles = (["ops", "pmc", "finance"] as SopRole[]).filter((role) => me?.roles.includes(role));
  const [data, setData] = useState<Workspace | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [name, setName] = useState(`${dayjs().format("YYYY年MM月")} 数量供需计划`);
  const [planId, setPlanId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await fetchJson<Workspace>("/api/replenish/sop");
      setData(next);
      setSelectedId((current) =>
        current && next.cycles.some((cycle) => cycle.id === current)
          ? current
          : next.cycles[0]?.id ?? null);
      setPlanId((current) => current ?? next.versions[0]?.id ?? null);
    } catch (error) {
      const text = error instanceof Error ? error.message : "S&OP 工作区加载失败";
      setData(null);
      setSelectedId(null);
      setLoadError(text);
      message.error(text);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  const cycle = data?.cycles.find((item) => item.id === selectedId) ?? null;
  const currentAgreements = cycle
    ? (["ops", "pmc", "finance"] as SopRole[]).filter(
        (role) => cycle.currentDecisions[role]?.decision === "agree",
      ).length
    : 0;

  const mutate = async (payload: Record<string, unknown>, success: string) => {
    setSaving(true);
    try {
      const next = await postJson<Workspace>("/api/replenish/sop", payload);
      setData(next);
      message.success(success);
      return true;
    } catch (error) {
      message.error((error as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const createCycle = async () => {
    if (!planId || name.trim().length < 2) return;
    const ok = await mutate({
      action: "create",
      month: month.format("YYYY-MM"),
      name: name.trim(),
      planningVersionId: planId,
      idempotencyKey: crypto.randomUUID(),
    }, "S&OP 周期已创建，进入三方共识");
    if (ok) setCreateOpen(false);
  };

  const decide = (role: SopRole, decision: "agree" | "reject") => {
    if (!cycle) return;
    if (decision === "agree") {
      void mutate({
        action: "decide",
        cycleId: cycle.id,
        version: cycle.version,
        role,
        decision,
      }, `${ROLE_META[role].label}已同意第 ${cycle.version} 轮计划`);
      return;
    }
    let note = "";
    Modal.confirm({
      title: `${ROLE_META[role].label}拒绝共识`,
      content: <Input.TextArea rows={3} placeholder="说明差距、责任人或需要调整的事实（至少 5 个字符）" onChange={(event) => { note = event.target.value; }} />,
      okText: "确认拒绝",
      okButtonProps: { danger: true },
      onOk: async () => {
        if (note.trim().length < 5) {
          message.error("拒绝原因至少 5 个字符");
          return Promise.reject();
        }
        await mutate({
          action: "decide",
          cycleId: cycle.id,
          version: cycle.version,
          role,
          decision,
          note: note.trim(),
        }, `${ROLE_META[role].label}已拒绝并留痕`);
      },
    });
  };

  const changePlan = (nextPlanId: number) => {
    if (!cycle || nextPlanId === cycle.planningVersionId) return;
    Modal.confirm({
      title: "开启新一轮共识？",
      content: "更换不可变源计划会把共识轮次加一；旧签认完整保留，但不再满足本轮冻结条件。",
      okText: "更换并重开共识",
      onOk: () => mutate({
        action: "change_plan",
        cycleId: cycle.id,
        version: cycle.version,
        planningVersionId: nextPlanId,
      }, "源计划已更换，三方需重新签认"),
    });
  };

  const transition = (target: "frozen" | "executing" | "closed") => {
    if (!cycle) return;
    const labels = { frozen: "冻结计划", executing: "开始执行", closed: "关闭周期" };
    Modal.confirm({
      title: labels[target],
      content: target === "frozen"
        ? "冻结后，当月实时补货建议只能查看，不能据此生成草稿；执行依据保持为当前不可变计划版本。"
        : target === "executing"
          ? "进入执行不会自动下单，所有 BH、采购与审批仍由人完成。"
          : "关闭代表本周期执行治理结束；历史计划和签认不会删除。",
      okText: labels[target],
      onOk: () => mutate({
        action: "transition",
        cycleId: cycle.id,
        version: cycle.version,
        target,
      }, `${labels[target]}成功`),
    });
  };

  /* ── W2-#4 按冻结计划开单 ──
     此前冻结只有闸门没有出口：实时建议 409，冻结的那批需求却没有任何地方能提出来，
     于是执行整体挪到系统外。这里是唯一的执行通道，数量取冻结版本的行，绝不回算实时建议。 */
  const [execution, setExecution] = useState<FrozenExecution | null>(null);
  const [execLoading, setExecLoading] = useState(false);
  const [pickedSkus, setPickedSkus] = useState<number[]>([]);
  /** 本次「按冻结计划开单」的幂等键（成功后清空；失败重试沿用同一个键） */
  const executeKey = useRef<string | null>(null);
  const [includeSuppressed, setIncludeSuppressed] = useState(false);

  const loadExecution = useCallback(async (cycleId: number) => {
    setExecLoading(true);
    try {
      setExecution(await fetchJson<FrozenExecution>(`/api/replenish/sop?cycleId=${cycleId}`));
    } catch {
      setExecution(null);
    } finally {
      setExecLoading(false);
    }
  }, []);

  const executable = cycle?.status === "frozen" || cycle?.status === "executing";
  useEffect(() => {
    if (cycle && executable) void loadExecution(cycle.id);
    else setExecution(null);
    setPickedSkus([]);
  }, [cycle, executable, loadExecution]);

  const draftFromFrozen = async () => {
    if (!cycle) return;
    setSaving(true);
    try {
      /* 幂等键在本次点击内固定：重试/双击落到同一个键 → 服务端返回同一张草稿，
         不会有两张内容相同的 BH 一起进审批链。成功后清空，下一次开单是新的一笔。 */
      executeKey.current ??= crypto.randomUUID();
      const res = await postJson<{ draft: { docNo: string; lineCount: number } }>("/api/replenish/sop", {
        action: "execute_draft",
        cycleId: cycle.id,
        idempotencyKey: executeKey.current,
        skuIds: pickedSkus.length ? pickedSkus : undefined,
        includeSuppressed,
      });
      message.success(`已按冻结计划生成 BH 草稿 ${res.draft.docNo}（${res.draft.lineCount} 项），请走正常审批`);
      executeKey.current = null;
      setPickedSkus([]);
      await load();
      await loadExecution(cycle.id);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const frozenColumns = useMemo<ColumnsType<FrozenLine>>(() => [
    { title: "SKU", dataIndex: "skuCode", width: 140 },
    { title: "名称", dataIndex: "skuName", width: 200, ellipsis: true },
    {
      title: "冻结建议量", dataIndex: "suggestedQty", width: 130, align: "right",
      render: (v: string, r) => (
        <Space size={4}>
          <span>{Number(v).toLocaleString("zh-CN")} {r.baseUom}</span>
          {r.suppressed ? <Tag color="orange">抑制</Tag> : null}
        </Space>
      ),
    },
    {
      title: "最晚下单日", dataIndex: "orderByDate", width: 130,
      render: (v: string | null, r) => v
        ? <Typography.Text type={r.orderWindowMissed ? "danger" : undefined}>{v}{r.orderWindowMissed ? "（已过）" : ""}</Typography.Text>
        : "—",
    },
    { title: "短缺日", dataIndex: "shortageDate", width: 120, render: (v: string | null) => v ?? "—" },
    { title: "已开单", dataIndex: "drafted", width: 90, render: (v: boolean) => (v ? <Tag color="blue">已开</Tag> : "—") },
  ], []);

  const decisionColumns = useMemo<ColumnsType<Decision>>(() => [
    {
      title: "轮次",
      dataIndex: "cycleVersion",
      width: 80,
      sorter: (a, b) => a.cycleVersion - b.cycleVersion,
      render: (value: number, row) => <Space><span>第 {value} 轮</span>{row.current ? <Tag color="blue">当前</Tag> : null}</Space>,
    },
    {
      title: "职能",
      dataIndex: "role",
      width: 100,
      filters: Object.entries(ROLE_META).map(([value, meta]) => ({ value, text: meta.label })),
      onFilter: (value, row) => row.role === value,
      render: (value: SopRole) => <Tag color={ROLE_META[value].color}>{ROLE_META[value].label}</Tag>,
    },
    {
      title: "决定",
      dataIndex: "decision",
      width: 100,
      filters: [{ text: "同意", value: "agree" }, { text: "拒绝", value: "reject" }],
      onFilter: (value, row) => row.decision === value,
      render: (value: Decision["decision"]) => <Tag color={value === "agree" ? "success" : "error"}>{value === "agree" ? "同意" : "拒绝"}</Tag>,
    },
    { title: "签认人", dataIndex: "decidedByName", width: 130, render: (value) => value ?? "未知用户" },
    { title: "时间", dataIndex: "decidedAt", width: 160, sorter: (a, b) => dayjs(a.decidedAt).valueOf() - dayjs(b.decidedAt).valueOf(), render: formatTime },
    { title: "说明", dataIndex: "note", ellipsis: true, render: (value) => value || "—" },
  ], []);

  return (
    <div style={{ maxWidth: 1500, margin: "0 auto" }}>
      <Flex justify="space-between" align="flex-start" gap={16} wrap="wrap" style={{ marginBottom: 18 }}>
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>S&OP 数量计划周期</Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: "8px 0 0", maxWidth: 820 }}>
            以不可变计划版本组织运营、PMC、财务三方共识，再冻结为单一数量执行基线。任何自动化都不替人批准或下单。
          </Typography.Paragraph>
        </div>
        <Space wrap>
          <Select
            style={{ width: "min(100%, 320px)", minWidth: 0, flex: "1 1 230px" }}
            value={selectedId}
            placeholder="选择周期"
            options={data?.cycles.map((item) => ({
              value: item.id,
              label: `${item.month} · ${item.name}`,
            }))}
            onChange={setSelectedId}
          />
          <Button loading={loading} onClick={() => void load()}>刷新</Button>
          {canManage ? <Button type="primary" disabled={!data?.versions.length} onClick={() => setCreateOpen(true)}>新建周期</Button> : null}
        </Space>
      </Flex>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 18 }}
        message="边界：这是数量供需共识，不是完整财务 IBP"
        description="成本、资金占用和销售订单事实尚未完成裁决，因此本页不展示虚假的金额共识或 ATP。"
      />

      {loadError ? (
        <Alert
          type="error"
          showIcon
          message="S&OP 工作区加载失败"
          description={loadError}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>重试</Button>}
          style={{ marginBottom: 16 }}
        />
      ) : null}

      {!cycle && !loadError ? (
        <Card loading={loading}>
          {!loading && data ? (
            <Empty description={data.versions.length ? "尚无 S&OP 周期，请由 PMC 建立首个月度周期" : "请先在「计划版本与周差异」保存一个不可变计划版本"} />
          ) : null}
        </Card>
      ) : (
        cycle ? <>
          <Card style={{ marginBottom: 16 }}>
            <Flex justify="space-between" align="flex-start" gap={16} wrap="wrap">
              <div>
                <Space wrap>
                  <Typography.Title level={4} style={{ margin: 0 }}>{cycle.name}</Typography.Title>
                  <Tag color={STATUS_META[cycle.status].color}>{STATUS_META[cycle.status].label}</Tag>
                  <Tag>第 {cycle.version} 轮共识</Tag>
                </Space>
                <Typography.Paragraph type="secondary" style={{ margin: "8px 0 0" }}>
                  {cycle.month} · 创建于 {formatTime(cycle.createdAt)}
                </Typography.Paragraph>
              </div>
              {cycle.status === "consensus" && canManage ? (
                <Select
                  style={{ width: "min(100%, 420px)", minWidth: 0, flex: "1 1 260px" }}
                  value={cycle.planningVersionId}
                  options={data?.versions.map((version) => ({
                    value: version.id,
                    label: `${version.name} · ${version.weekStart} · ${version.suggestedCount} 项建议`,
                  }))}
                  onChange={changePlan}
                />
              ) : null}
            </Flex>
            <Steps
              style={{ marginTop: 24 }}
              current={STATUS_META[cycle.status].step}
              items={[
                { title: "三方共识", description: "运营 / PMC / 财务" },
                { title: "冻结", description: "实时建议转只读" },
                { title: "执行", description: "人工单据与审批" },
                { title: "关闭", description: "保留完整证据" },
              ]}
            />
          </Card>

          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={24} xl={9}>
              <Card title="冻结计划证据" style={{ height: "100%" }}>
                <Typography.Title level={4} style={{ marginTop: 0 }}>{cycle.plan.name}</Typography.Title>
                <Typography.Text type="secondary">计划周起点 {cycle.plan.weekStart}</Typography.Text>
                <Row gutter={[10, 10]} className="compact-kpi-row" style={{ marginTop: 16 }}>
                  <Col span={8}><Statistic title="全量行" value={cycle.plan.lineCount} /></Col>
                  <Col span={8}><Statistic title="建议" value={cycle.plan.suggestedCount} /></Col>
                  <Col span={8}><Statistic title="抑制" value={cycle.plan.suppressedCount} /></Col>
                </Row>
                <Typography.Text code ellipsis style={{ display: "block" }}>摘要 {cycle.planDigest}</Typography.Text>
                <Button href={`/replenish/versions?current=${cycle.planningVersionId}`} style={{ marginTop: 16 }}>查看不可变计划</Button>
              </Card>
            </Col>
            <Col xs={24} xl={15}>
              <Card title="当前轮次共识" style={{ height: "100%" }}>
                <Progress
                  percent={Math.round((currentAgreements / 3) * 100)}
                  format={() => `${currentAgreements}/3 职能同意`}
                  status={Object.values(cycle.currentDecisions).some((item) => item?.decision === "reject") ? "exception" : "active"}
                />
                <Row gutter={[12, 12]} style={{ marginTop: 18 }}>
                  {(["ops", "pmc", "finance"] as SopRole[]).map((role) => {
                    const decision = cycle.currentDecisions[role];
                    const canSign = cycle.status === "consensus" && signRoles.includes(role);
                    return (
                      <Col xs={24} md={8} key={role}>
                        <Card size="small">
                          <Flex justify="space-between" align="center">
                            <Tag color={ROLE_META[role].color}>{ROLE_META[role].label}</Tag>
                            <Tag color={decision?.decision === "agree" ? "success" : decision?.decision === "reject" ? "error" : "default"}>
                              {decision?.decision === "agree" ? "已同意" : decision?.decision === "reject" ? "已拒绝" : "待签认"}
                            </Tag>
                          </Flex>
                          <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ minHeight: 44, margin: "12px 0" }}>
                            {decision ? `${decision.decidedByName ?? "未知用户"} · ${formatTime(decision.decidedAt)}${decision.note ? ` · ${decision.note}` : ""}` : "必须由持有该角色的本人签认；管理员不能代签。"}
                          </Typography.Paragraph>
                          {canSign ? (
                            <Space>
                              <Button size="small" type="primary" loading={saving} onClick={() => decide(role, "agree")}>同意</Button>
                              <Button size="small" danger loading={saving} onClick={() => decide(role, "reject")}>拒绝</Button>
                            </Space>
                          ) : null}
                        </Card>
                      </Col>
                    );
                  })}
                </Row>
                {canManage ? (
                  <Space wrap style={{ marginTop: 18 }}>
                    {cycle.status === "consensus" ? <Button type="primary" disabled={!cycle.consensusReady} loading={saving} onClick={() => transition("frozen")}>冻结共识计划</Button> : null}
                    {cycle.status === "frozen" ? <Button type="primary" loading={saving} onClick={() => transition("executing")}>开始执行</Button> : null}
                    {cycle.status === "executing" ? <Button loading={saving} onClick={() => transition("closed")}>关闭周期</Button> : null}
                  </Space>
                ) : null}
              </Card>
            </Col>
          </Row>

          {executable ? (
            <Card
              title="按冻结计划开单（唯一执行通道）"
              extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => void loadExecution(cycle.id)}>刷新</Button>}
              style={{ marginBottom: 16 }}
            >
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="冻结后当月实时补货建议只读——需要下单就从这里走。数量取自冻结版本的行（不回算实时建议），仍是人工勾选生成 BH 草稿并走正常审批链。"
              />
              <Table<FrozenLine>
                rowKey="skuId"
                size="small"
                loading={execLoading}
                columns={frozenColumns}
                dataSource={(execution?.lines ?? []).filter((l) => includeSuppressed || !l.suppressed)}
                pagination={{ pageSize: 10, hideOnSinglePage: true }}
                scroll={{ x: 820 }}
                rowSelection={canManage ? {
                  selectedRowKeys: pickedSkus,
                  onChange: (keys) => setPickedSkus(keys as number[]),
                } : undefined}
                locale={{ emptyText: "冻结版本里没有可开单的行" }}
              />
              <Flex wrap gap={12} align="center" style={{ marginTop: 12 }}>
                {canManage ? (
                  <>
                    <Button
                      type="primary"
                      loading={saving}
                      disabled={(execution?.lines.length ?? 0) === 0}
                      onClick={() => void draftFromFrozen()}
                    >
                      {pickedSkus.length ? `按冻结计划开单（${pickedSkus.length} 项）` : "按冻结计划开单（全部未抑制行）"}
                    </Button>
                    <Button size="small" onClick={() => setIncludeSuppressed((v) => !v)}>
                      {includeSuppressed ? "隐藏被抑制行" : "显示并允许放行被抑制行"}
                    </Button>
                  </>
                ) : (
                  <Typography.Text type="secondary">仅 PMC/管理员可据此开单。</Typography.Text>
                )}
                <Typography.Text type="secondary">
                  已开草稿：{execution?.drafts.length
                    ? execution.drafts.map((d) => `${d.docNo}（${d.lineCount} 项，${d.by ?? "未知"}）`).join("；")
                    : "无"}
                </Typography.Text>
              </Flex>
            </Card>
          ) : null}

          <Card title="签认历史">
            <Table<Decision>
              rowKey="id"
              size="small"
              columns={decisionColumns}
              dataSource={cycle.decisions}
              pagination={{ pageSize: 10, hideOnSinglePage: true }}
              scroll={{ x: 820 }}
              locale={{ emptyText: "本周期尚无签认" }}
            />
          </Card>
        </> : null
      )}

      {data?.limitations.length ? (
        <CaliberNote
          summary="口径与能力边界"
          detail={<ul style={{ margin: 0, paddingLeft: 20 }}>{data.limitations.map((item) => <li key={item}>{item}</li>)}</ul>}
        />
      ) : null}

      <Modal
        title="新建月度 S&OP 周期"
        open={createOpen}
        okText="创建并进入共识"
        confirmLoading={saving}
        okButtonProps={{ disabled: !planId || name.trim().length < 2 }}
        onOk={() => void createCycle()}
        onCancel={() => setCreateOpen(false)}
      >
        <Space direction="vertical" size={14} style={{ width: "100%" }}>
          <DatePicker picker="month" allowClear={false} value={month} onChange={(value) => value && setMonth(value)} style={{ width: "100%" }} />
          <Input value={name} maxLength={100} placeholder="周期名称" onChange={(event) => setName(event.target.value)} />
          <Select
            value={planId}
            style={{ width: "100%" }}
            placeholder="选择不可变计划版本"
            options={data?.versions.map((version) => ({
              value: version.id,
              label: `${version.name} · ${version.weekStart} · ${version.suggestedCount} 项建议`,
            }))}
            onChange={setPlanId}
          />
        </Space>
      </Modal>
    </div>
  );
}
