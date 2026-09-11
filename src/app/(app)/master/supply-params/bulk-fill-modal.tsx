"use client";

/**
 * 批量补录周期（#1）：先预演、再执行。
 *
 * 两种口径共用一个弹窗与同一条 `POST /api/master/supply-params/bulk`：
 *  - 「批量填写」：作用域 = 表格里勾选的行（scope.kind=ids）；
 *  - 「按分层/品牌套用默认」：作用域 = 当前筛选条件（scope.kind=filter），
 *    值预填运行参数里的缺省周期（服务端下发的 defaults，页面不另写字面量）。
 *
 * 执行前必须先看到预演结果——「会改多少行」是这类批量唯一能自证安全的东西。
 */
import { useEffect, useRef, useState } from "react";
import { Alert, App, Checkbox, Descriptions, InputNumber, Modal, Space, Typography } from "antd";
import { fetchJson } from "@/components/fetchJson";

export type BulkScope =
  | { kind: "ids"; ids: number[] }
  | { kind: "filter"; tier?: string; brandId?: number; skuType?: string; blockedOnly?: boolean; onlyMissing?: boolean; q?: string; missing?: "" | "any" | "production" | "logistics" | "purchase" | "moq" | "cost" };

export interface BulkPreview {
  previewKey: string;
  dryRun: boolean;
  matched: number;
  filled: number;
  overridden: number;
  changedSkus: number;
  unchangedSkus: number;
  notApplicableSkus: number;
  sampleCodes: string[];
}

export default function BulkFillModal({
  open,
  scope,
  scopeLabel,
  defaults,
  canOverride,
  onClose,
  onDone,
}: {
  open: boolean;
  scope: BulkScope | null;
  scopeLabel: string;
  defaults: { production: number; logistics: number } | null;
  canOverride: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const [production, setProduction] = useState<number | null>(defaults?.production ?? null);
  const [logistics, setLogistics] = useState<number | null>(defaults?.logistics ?? null);
  const [purchase, setPurchase] = useState<number | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const confirmLabel = preview ? `确认写入 ${preview.changedSkus} 个 SKU` : "先预演";

  // 每次打开都从「运行参数缺省」重新起步；改完一批不该把上一批的数字留给下一批
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const values = () => {
    const v: Record<string, number> = {};
    if (production != null) v.normalLeadDays = production;
    if (logistics != null) v.logisticsLeadDays = logistics;
    if (purchase != null) v.purchaseLeadDays = purchase;
    return v;
  };

  const run = async (dryRun: boolean) => {
    if (!scope || inFlight.current) return;
    const v = values();
    if (Object.keys(v).length === 0) return void message.warning("至少填一个周期字段");
    if (!dryRun && !preview?.previewKey) return;
    inFlight.current = true; setBusy(true); setError(null);
    const request = new AbortController();
    const timeout = setTimeout(() => request.abort(), 20_000);
    try {
      const res = await fetchJson<BulkPreview>("/api/master/supply-params/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, signal: request.signal, body: JSON.stringify({
        scope,
        values: v,
        overwrite,
        dryRun,
        expectedPreview: dryRun ? undefined : preview?.previewKey,
      }) });
      if (!mounted.current) return;
      if (!res || typeof res.previewKey !== "string" || !Number.isSafeInteger(res.changedSkus)) throw new Error("预演/写入回执格式异常，请先核对服务器结果");
      if (dryRun) {
        setPreview(res);
      } else {
        message.success(
          `已写入 ${res.changedSkus} 个 SKU：补空 ${res.filled} 项`
          + (res.overridden > 0 ? `，覆盖 ${res.overridden} 项` : ""),
        );
        onDone();
        onClose();
      }
    } catch (e) {
      if (mounted.current) {
        setError(request.signal.aborted ? (dryRun ? "预演超时，可重新预演" : "等待写入回执超时；操作可能已完成，请关闭弹窗并刷新核对，勿直接重复写入") : (e as Error).message);
        setPreview(null);
      }
    } finally {
      clearTimeout(timeout); inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`批量补录周期 · ${scopeLabel}`}
      onCancel={() => { if (!inFlight.current) onClose(); }}
      closable={!busy}
      keyboard={!busy}
      cancelButtonProps={{ disabled: busy }}
      confirmLoading={busy}
      okText={confirmLabel}
      okButtonProps={{ "aria-label": confirmLabel, "aria-busy": busy, disabled: busy || (preview != null && preview.changedSkus === 0) }}
      onOk={() => void run(preview == null)}
      cancelText="取消"
      width={640}
      maskClosable={false}
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        {error && <Alert type="error" showIcon message={error} />}
        <Alert
          type="info"
          showIcon
          message="只写该 SKU 类型适用的字段：成品/半成品写加工+在途，原料/包材写采购；不适用的自动跳过，不会整批失败。"
        />
        <Space wrap>
          <span>
            加工周期{" "}
            <InputNumber aria-label="批量加工周期（天）" disabled={busy} min={0} max={365} precision={0} value={production} style={{ width: 100 }}
              onChange={(v) => { setProduction(v == null ? null : Number(v)); setPreview(null); }} />
          </span>
          <span>
            在途周期{" "}
            <InputNumber aria-label="批量在途周期（天）" disabled={busy} min={0} max={365} precision={0} value={logistics} style={{ width: 100 }}
              onChange={(v) => { setLogistics(v == null ? null : Number(v)); setPreview(null); }} />
          </span>
          <span>
            采购周期{" "}
            <InputNumber aria-label="批量采购周期（天）" disabled={busy} min={0} max={365} precision={0} value={purchase} style={{ width: 100 }}
              onChange={(v) => { setPurchase(v == null ? null : Number(v)); setPreview(null); }} />
          </span>
        </Space>
        <Checkbox
          checked={overwrite}
          disabled={!canOverride || busy}
          onChange={(e) => { setOverwrite(e.target.checked); setPreview(null); }}
        >
          连同已有值一起覆盖（默认只补空值{canOverride ? "" : "；采购角色只能补空值"}）
        </Checkbox>
        {preview ? (
          <Descriptions size="small" column={2} bordered title="预演结果（尚未写入）">
            <Descriptions.Item label="命中 SKU">{preview.matched}</Descriptions.Item>
            <Descriptions.Item label="将写入 SKU">{preview.changedSkus}</Descriptions.Item>
            <Descriptions.Item label="补空字段">{preview.filled}</Descriptions.Item>
            <Descriptions.Item label="覆盖字段">{preview.overridden}</Descriptions.Item>
            <Descriptions.Item label="本就相同">{preview.unchangedSkus}</Descriptions.Item>
            <Descriptions.Item label="类型不适用">{preview.notApplicableSkus}</Descriptions.Item>
            <Descriptions.Item label="示例" span={2}>
              <Typography.Text type="secondary">
                {preview.sampleCodes.length ? preview.sampleCodes.join("、") : "无"}
              </Typography.Text>
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Typography.Text type="secondary">先「预演」看会改多少行，再确认写入；每个 SKU 各留一条审计。</Typography.Text>
        )}
      </Space>
    </Modal>
  );
}
