"use client";

const FEE_TYPE_OPTIONS = ["OEM填充", "保税加工", "保税仓操作费", "其他"].map((v) => ({ value: v, label: v }));

import { DatePicker, Form, Input, InputNumber, Tag, Tooltip, Typography, Select } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import CrudTable from "@/components/CrudTable";
import RemoteSelect from "@/components/RemoteSelect";
import { hasAnyRole, useMe } from "@/components/useMe";

interface FeeRefRow {
  id: number;
  skuId: number;
  skuCode: string;
  skuName: string;
  supplierId: number;
  supplierName: string;
  feeRate?: string | null; // R9 敏感：无权限角色的响应中该键被剥离
  effectiveDate: string;
  source: string | null;
  note: string | null;
}

const SOURCE_LABELS: Record<string, string> = { bom_import: "BOM 导入", manual: "手工维护" };

export default function FeerefClient() {
  const me = useMe();
  const canWrite = hasAnyRole(me, "purchasing");
  const canSeeFee = hasAnyRole(me, "purchasing", "pmc", "finance");

  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        加工费参考价
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        R1 比价基准来源：委外工单加工费计划单价（feeRatePlan）以此为基准比对。BOM 导入行常缺价，由采购在此补录；
        换厂/调价请按新生效日期新建行，保留价格历史。
      </Typography.Paragraph>
      <CrudTable<FeeRefRow>
        entityName="参考价"
        apiPath="/api/master/feeref"
        searchPlaceholder="搜索 SKU 编码/名称/加工厂"
        canCreate={canWrite}
        canEdit={() => canWrite}
        columns={[
          {
            title: "SKU",
            dataIndex: "skuCode",
            render: (_, r) => `${r.skuCode} ${r.skuName}`,
          },
          { title: "加工厂", dataIndex: "supplierName", width: 200 },
          {
            title: "加工费单价",
            dataIndex: "feeRate",
            width: 130,
            render: (v: string | null | undefined) =>
              !canSeeFee ? (
                <Tooltip title="需要采购/生产计划/财务角色">
                  <Typography.Text type="secondary">无权查看</Typography.Text>
                </Tooltip>
              ) : v == null ? (
                <Tag color="warning">待补录</Tag>
              ) : (
                `¥${v}`
              ),
          },
          { title: "生效日期", dataIndex: "effectiveDate", width: 120 },
          {
            title: "来源",
            dataIndex: "source",
            width: 100,
            render: (v: string | null) => (v ? SOURCE_LABELS[v] ?? v : "—"),
          },
          { title: "备注", dataIndex: "note", ellipsis: true, render: (v: string | null) => v ?? "—" },
        ]}
        toFormValues={(r) => ({
          skuId: r.skuId,
          supplierId: r.supplierId,
          feeRate: r.feeRate != null ? Number(r.feeRate) : undefined,
          effectiveDate: dayjs(r.effectiveDate),
          note: r.note ?? undefined,
        })}
        transformSubmit={(values, editing) => {
          const body: Record<string, unknown> = {
            feeRate: values.feeRate ?? null,
            effectiveDate: (values.effectiveDate as Dayjs).format("YYYY-MM-DD"),
            note: (values.note as string | undefined) ?? "",
          };
          if (!editing) {
            body.skuId = values.skuId;
            body.supplierId = values.supplierId;
          }
          return body;
        }}
        formItems={(editing) => (
          <>
            <Form.Item name="skuId" label="SKU" rules={[{ required: true, message: "必须选择 SKU" }]}>
              <RemoteSelect
                api="/api/master/sku"
                getLabel={(r) => `${String(r.code)} ${r.name ? String(r.name) : String(r.spuNameCn)}`}
                placeholder="选择 SKU"
                disabled={!!editing}
              />
            </Form.Item>
            <Form.Item name="supplierId" label="加工厂" rules={[{ required: true, message: "必须选择加工厂" }]}>
              <RemoteSelect
                api="/api/master/supplier"
                getLabel={(r) => `${String(r.code)} ${String(r.name)}`}
                filterRow={(r) => Array.isArray(r.kinds) && (r.kinds as string[]).includes("processor")}
                placeholder="选择加工厂（processor）"
                disabled={!!editing}
              />
            </Form.Item>
            <Form.Item name="feeRate" label="加工费单价（元）" tooltip="可留空待补录；R9 敏感字段，仅采购/生产计划/财务可见">
              <InputNumber min={0} step={0.01} precision={2} style={{ width: 200 }} placeholder="留空=待补录" />
            </Form.Item>
          <Form.Item name="feeType" label="费用类型" initialValue="OEM填充">
            <Select options={FEE_TYPE_OPTIONS} />
          </Form.Item>
            <Form.Item name="effectiveDate" label="生效日期" rules={[{ required: true, message: "生效日期必填" }]}>
              <DatePicker style={{ width: 200 }} />
            </Form.Item>
            <Form.Item name="note" label="备注">
              <Input maxLength={200} />
            </Form.Item>
          </>
        )}
      />
    </div>
  );
}
