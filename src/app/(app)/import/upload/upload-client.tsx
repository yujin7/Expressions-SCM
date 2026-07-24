"use client";

/**
 * 文件上传 → staging（运营环入口）：
 * 选模板 → 传 xlsx → 适配器解析入 staging → 提示去「放行工作台」走人工闸。
 * 上传不直接动主档/账本——这是管道第一站，不是捷径。
 */
import { useState } from "react";
import { Alert, App, Button, Card, Descriptions, Select, Space, Typography, Upload } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import type { RcFile } from "antd/es/upload";
import Link from "next/link";
import RemoteSelect from "@/components/RemoteSelect";

const TEMPLATE_OPTS = [
  { value: "inventory", label: "库存明细（电商部长表→快照/期初候选）" },
  { value: "sales", label: "产品销量汇总（品牌页签→月销）" },
  { value: "expiry", label: "效期占比（批次效期参考）" },
  { value: "bom", label: "产品 BOM 工作簿（须选品牌）" },
  { value: "leadtime", label: "在途/交期表（提前期参考，1.1 启用）" },
            { value: "transit", label: "在途进度表（成品/包材/备料/OEM 归属）" },
            { value: "demand", label: "需求&计划&达成统计表（月度需求/借调历史）" },
            { value: "pallet", label: "总货盘情况表-PMC（月度货盘/处置注记）" },
            { value: "stock_summary", label: "总库存明细（全公司口径核对）" },
            { value: "sku_cost", label: "SKU 成本导入（毛利视角基准）" },
];

interface UploadResult {
  file: string;
  template: string;
  summary: Record<string, unknown>;
}

export default function UploadClient() {
  const { message } = App.useApp();
  const [template, setTemplate] = useState("inventory");
  const [brand, setBrand] = useState<string | undefined>();
  const [file, setFile] = useState<RcFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);

  const submit = async () => {
    if (!file) return void message.warning("请先选择 .xlsx 文件");
    if (template === "bom" && !brand) return void message.warning("BOM 导入必须选择品牌");
    setBusy(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("template", template);
      if (brand) fd.append("brand", brand);
      const res = await fetch("/api/import/upload", { method: "POST", body: fd });
      const body = (await res.json()) as UploadResult & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `上传失败（${res.status}）`);
      setResult(body);
      message.success("已入 staging——请到放行工作台执行放行");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const summaryEntries = result ? Object.entries(result.summary).filter(([k]) => k !== "stats") : [];
  const stats = (result?.summary as { stats?: Record<string, number> } | null)?.stats;

  return (
    <div style={{ maxWidth: 860 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        文件上传（入 staging）
      </Typography.Title>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="上传只做解析与暂存：未识别的仓库/编码/渠道自动进「别名认领」队列；写入正式主档/快照须到「放行工作台」执行（人工闸不旁路）。"
      />
      <Card size="small">
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <Space wrap>
            <Select style={{ width: 360 }} options={TEMPLATE_OPTS} value={template} onChange={(v) => setTemplate(v)} />
            {template === "bom" && (
              <RemoteSelect
                api="/api/master/brand"
                getLabel={(r) => `${String(r.code)} ${String(r.nameCn ?? "")}`}
                getValue={(r) => String(r.code)}
                placeholder="选择品牌"
                style={{ width: 220 }}
                value={brand}
                onChange={(v) => setBrand(v as string | undefined)}
              />
            )}
          </Space>
          <Upload.Dragger
            accept=".xlsx"
            maxCount={1}
            beforeUpload={(f) => {
              setFile(f);
              return false; // 不自动上传——统一走提交按钮
            }}
            onRemove={() => setFile(null)}
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined />
            </p>
            <p className="ant-upload-text">点击或拖拽 .xlsx 到此处</p>
            <p className="ant-upload-hint">单文件 ≤30MB；损坏的工作簿会自动走 OOXML 兜底通道解析</p>
          </Upload.Dragger>
          <Button type="primary" loading={busy} onClick={() => void submit()} disabled={!file}>
            上传并解析入 staging
          </Button>
        </Space>
      </Card>

      {result && (
        <Card size="small" style={{ marginTop: 16 }} title={`解析结果：${result.file}`}>
          <Descriptions size="small" column={3} bordered>
            {summaryEntries.map(([k, v]) => (
              <Descriptions.Item key={k} label={k}>
                {typeof v === "object" ? JSON.stringify(v) : String(v)}
              </Descriptions.Item>
            ))}
            {stats &&
              Object.entries(stats).map(([k, v]) => (
                <Descriptions.Item key={`s-${k}`} label={k}>
                  {String(v)}
                </Descriptions.Item>
              ))}
          </Descriptions>
          <Space style={{ marginTop: 12 }}>
            <Link href="/import/release">→ 去放行工作台</Link>
            <Link href="/import/exceptions">→ 去别名认领</Link>
          </Space>
        </Card>
      )}
    </div>
  );
}
