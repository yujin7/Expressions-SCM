"use client";

import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Flex,
  Input,
  Modal,
  Progress,
  Row,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { useCallback, useEffect, useState } from "react";
import { fetchJson, postJson } from "@/components/fetchJson";
import { useMe } from "@/components/useMe";

type AutoState = "pass" | "attention" | "blocked";
type ManualState = "pending" | "completed" | "waived";

interface CloseCheck {
  key: string;
  title: string;
  owner: string;
  href: string;
  autoState: AutoState;
  summary: string;
  evidence: Record<string, unknown>;
  status: ManualState;
  note: string | null;
  completedByName: string | null;
  completedAt: string | null;
  version: number;
  evidenceChanged: boolean;
  current: boolean;
}

interface Checklist {
  month: string;
  generatedAt: string;
  /** W2-1：真实期间锁（period_locks），不再是「月份小于当前月」的日历推断 */
  periodClosed: boolean;
  closedByName: string | null;
  closedAt: string | null;
  closeNote: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  closable: boolean;
  pastMonth: boolean;
  checks: CloseCheck[];
  progress: { current: number; total: 6; percent: number };
  limitations: string[];
}

const AUTO_META: Record<AutoState, { label: string; color: string; icon: React.ReactNode }> = {
  pass: { label: "自动控制通过", color: "success", icon: <CheckCircleOutlined /> },
  attention: { label: "需人工确认", color: "warning", icon: <ClockCircleOutlined /> },
  blocked: { label: "存在阻塞", color: "error", icon: <ExclamationCircleOutlined /> },
};

const MANUAL_META: Record<ManualState, { label: string; color: string }> = {
  pending: { label: "待签认", color: "default" },
  completed: { label: "已完成", color: "success" },
  waived: { label: "例外关闭", color: "warning" },
};

export default function MonthCloseClient() {
  const { message } = App.useApp();
  const me = useMe();
  const canWrite = !!me && (me.roles.includes("finance") || me.roles.includes("admin"));
  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [data, setData] = useState<Checklist | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [waiver, setWaiver] = useState<CloseCheck | null>(null);
  const [waiverNote, setWaiverNote] = useState("");
  const isAdmin = !!me && me.roles.includes("admin");
  const [lockAction, setLockAction] = useState<"close" | "reopen" | null>(null);
  const [lockText, setLockText] = useState("");
  const [lockSaving, setLockSaving] = useState(false);

  const monthKey = month.format("YYYY-MM");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchJson<Checklist>(`/api/settlement/month-close?month=${monthKey}`));
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [message, monthKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = async (check: CloseCheck, status: ManualState, note?: string) => {
    setSavingKey(check.key);
    try {
      const next = await postJson<Checklist>("/api/settlement/month-close", {
        month: monthKey,
        checkKey: check.key,
        status,
        note: note ?? null,
        version: check.version,
      });
      setData(next);
      message.success(status === "pending" ? "已重新打开检查项" : status === "waived" ? "已例外关闭并留痕" : "已完成并固化证据");
      return true;
    } catch (error) {
      message.error((error as Error).message);
      return false;
    } finally {
      setSavingKey(null);
    }
  };

  const submitLock = async () => {
    if (!lockAction) return;
    setLockSaving(true);
    try {
      await postJson("/api/settlement/period-lock", lockAction === "close"
        ? { intent: "close", period: monthKey, note: lockText.trim() || null }
        : { intent: "reopen", period: monthKey, reason: lockText.trim() });
      message.success(lockAction === "close" ? "已关账：该月过账入口已锁死" : "已重开期间（已留痕）");
      setLockAction(null);
      setLockText("");
      await load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLockSaving(false);
    }
  };

  const progressStatus = data?.checks.some((check) => check.autoState === "blocked")
    ? "exception"
    : "normal";

  return (
    <div style={{ maxWidth: 1440, margin: "0 auto" }}>
      <Flex justify="space-between" align="flex-start" gap={16} wrap="wrap" style={{ marginBottom: 20 }}>
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>月结控制台</Typography.Title>
          <Typography.Paragraph type="secondary" style={{ margin: "8px 0 0", maxWidth: 760 }}>
            六项真实业务控制按月编排：自动证据负责发现缺口，财务签认负责确认处置。证据变化会自动要求复核。
          </Typography.Paragraph>
        </div>
        <Space wrap>
          <DatePicker
            picker="month"
            allowClear={false}
            value={month}
            onChange={(value) => value && setMonth(value)}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>刷新证据</Button>
          {canWrite && data && !data.periodClosed ? (
            <Button
              type="primary"
              disabled={!data.closable}
              title={data.closable ? undefined : "六项检查全部收口、且该月已过完，才可关账"}
              onClick={() => { setLockText(""); setLockAction("close"); }}
            >
              关账并锁定期间
            </Button>
          ) : null}
          {isAdmin && data?.periodClosed ? (
            <Button danger onClick={() => { setLockText(""); setLockAction("reopen"); }}>
              重开期间
            </Button>
          ) : null}
        </Space>
      </Flex>

      <Card
        loading={loading && !data}
        style={{ marginBottom: 20 }}
        styles={{ body: { padding: 20 } }}
      >
        <Row gutter={[24, 16]} align="middle">
          <Col xs={24} md={7}>
            <Flex align="center" gap={16}>
              <Progress
                type="circle"
                size={92}
                percent={data?.progress.percent ?? 0}
                status={progressStatus}
                format={() => `${data?.progress.current ?? 0}/6`}
              />
              <div>
                <Typography.Title level={4} style={{ margin: 0 }}>{monthKey} 月结进度</Typography.Title>
                <Space style={{ marginTop: 8 }}>
                  <Tag color={data?.periodClosed ? "red" : data?.pastMonth ? "blue" : "gold"}>
                    {data?.periodClosed ? "已关账（锁定）" : data?.pastMonth ? "历史月份·未关账" : "预关账中"}
                  </Tag>
                  <Typography.Text type="secondary">
                    {data ? dayjs(data.generatedAt).format("MM-DD HH:mm") : "—"} 更新
                  </Typography.Text>
                </Space>
              </div>
            </Flex>
          </Col>
          <Col xs={24} md={17}>
            <Alert
              type={data?.checks.some((check) => check.evidenceChanged) ? "warning" : "info"}
              showIcon
              message={
                data?.checks.some((check) => check.evidenceChanged)
                  ? "已签认项目的底层证据发生变化，必须重新复核"
                  : "正常完成仅在自动控制通过时开放；其他情况须说明原因后例外关闭"
              }
              description={
                data?.periodClosed
                  ? `已由 ${data.closedByName ?? "—"} 于 ${data.closedAt ? dayjs(data.closedAt).format("YYYY-MM-DD HH:mm") : "—"} 关账；该月的任何过账（含红字冲销）都会被过账引擎拒绝，纠错请按当前开放期间冲销，或由管理员重开期间。`
                  : "本页是供应链预关账与运营签认，不替代法定会计或 ERP 总账关账。关账后该月过账入口即被锁死。"
              }
            />
          </Col>
        </Row>
      </Card>

      <Row gutter={[16, 16]}>
        {(data?.checks ?? []).map((check, index) => {
          const auto = AUTO_META[check.autoState];
          const manual = MANUAL_META[check.status];
          return (
            <Col xs={24} xl={12} key={check.key}>
              <Card
                style={{
                  height: "100%",
                  borderColor: check.evidenceChanged
                    ? "#faad14"
                    : check.autoState === "blocked"
                      ? "#ffccc7"
                      : undefined,
                }}
                styles={{ body: { padding: 20 } }}
              >
                <Flex justify="space-between" align="flex-start" gap={12}>
                  <Flex gap={12} align="flex-start">
                    <Flex
                      align="center"
                      justify="center"
                      style={{
                        flex: "0 0 32px",
                        height: 32,
                        borderRadius: 10,
                        color: "#315bce",
                        background: "#edf3ff",
                        fontWeight: 700,
                      }}
                    >
                      {index + 1}
                    </Flex>
                    <div>
                      <Typography.Title level={5} style={{ margin: 0 }}>{check.title}</Typography.Title>
                      <Typography.Text type="secondary">责任：{check.owner}</Typography.Text>
                    </div>
                  </Flex>
                  <Space size={[4, 6]} wrap style={{ justifyContent: "flex-end" }}>
                    <Tag color={auto.color} icon={auto.icon}>{auto.label}</Tag>
                    <Tag color={manual.color}>{manual.label}</Tag>
                    {check.evidenceChanged ? <Tag color="warning">证据已变化</Tag> : null}
                  </Space>
                </Flex>

                <Alert
                  type={check.autoState === "blocked" ? "error" : check.autoState === "attention" ? "warning" : "success"}
                  showIcon
                  message={check.summary}
                  style={{ margin: "16px 0" }}
                />

                {check.status !== "pending" ? (
                  <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                    {check.completedByName ?? "—"} · {check.completedAt ? dayjs(check.completedAt).format("YYYY-MM-DD HH:mm") : "—"}
                    {check.note ? ` · ${check.note}` : ""}
                  </Typography.Paragraph>
                ) : null}

                <Flex justify="space-between" align="center" gap={12} wrap="wrap">
                  <Button type="link" href={`${check.href}${check.href.includes("?") ? "&" : "?"}month=${monthKey}`} style={{ paddingInline: 0 }}>
                    查看业务证据
                  </Button>
                  <Space wrap>
                    {check.status !== "pending" ? (
                      <Button
                        disabled={!canWrite}
                        loading={savingKey === check.key}
                        onClick={() => void update(check, "pending")}
                      >
                        重新打开
                      </Button>
                    ) : check.autoState === "pass" ? (
                      <Button
                        type="primary"
                        icon={<CheckCircleOutlined />}
                        disabled={!canWrite}
                        loading={savingKey === check.key}
                        onClick={() => void update(check, "completed")}
                      >
                        标记完成
                      </Button>
                    ) : (
                      <Button
                        icon={<SafetyCertificateOutlined />}
                        disabled={!canWrite}
                        onClick={() => {
                          setWaiver(check);
                          setWaiverNote("");
                        }}
                      >
                        例外关闭
                      </Button>
                    )}
                  </Space>
                </Flex>
              </Card>
            </Col>
          );
        })}
      </Row>

      <Alert
        type="info"
        showIcon
        message="口径限制"
        description={
          <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
            {(data?.limitations ?? []).map((item) => <li key={item}>{item}</li>)}
          </ul>
        }
        style={{ marginTop: 20 }}
      />

      <Modal
        title={`例外关闭：${waiver?.title ?? ""}`}
        open={waiver != null}
        okText="确认例外关闭"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: waiverNote.trim().length < 5 }}
        confirmLoading={waiver ? savingKey === waiver.key : false}
        onCancel={() => setWaiver(null)}
        onOk={() => {
          if (!waiver) return;
          void update(waiver, "waived", waiverNote).then((ok) => {
            if (ok) setWaiver(null);
          });
        }}
      >
        <Alert
          type="warning"
          showIcon
          message={waiver?.summary}
          description="例外关闭不表示自动控制已通过；原因与当前证据会永久写入审计日志。"
          style={{ marginBottom: 16 }}
        />
        <Input.TextArea
          rows={4}
          maxLength={500}
          showCount
          value={waiverNote}
          onChange={(event) => setWaiverNote(event.target.value)}
          placeholder="填写未处理原因、责任人和后续动作（至少 5 个字符）"
        />
      </Modal>

      <Modal
        title={lockAction === "close" ? `关账并锁定期间 ${monthKey}` : `重开期间 ${monthKey}`}
        open={lockAction != null}
        okText={lockAction === "close" ? "确认关账" : "确认重开"}
        cancelText="取消"
        okButtonProps={{
          danger: true,
          disabled: lockAction === "reopen" && lockText.trim().length < 5,
        }}
        confirmLoading={lockSaving}
        onCancel={() => setLockAction(null)}
        onOk={() => void submitLock()}
      >
        <Alert
          type="warning"
          showIcon
          message={lockAction === "close"
            ? "关账后，业务时间落在该月的任何过账都会被过账引擎拒绝——包括红字冲销。"
            : "重开会解除该月的过账封锁，仅管理员可执行，原因写入审计日志。"}
          description={lockAction === "close"
            ? "纠错的正确做法是按当前开放期间做红字冲销；确需回到该月，请由管理员重开期间。"
            : undefined}
          style={{ marginBottom: 16 }}
        />
        <Input.TextArea
          rows={3}
          maxLength={500}
          showCount
          value={lockText}
          onChange={(event) => setLockText(event.target.value)}
          placeholder={lockAction === "close" ? "关账说明（可选）" : "重开原因（必填，至少 5 个字符）"}
        />
      </Modal>
    </div>
  );
}
