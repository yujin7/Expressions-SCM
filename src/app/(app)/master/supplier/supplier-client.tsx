"use client";

import { useState } from "react";
import { Button, DatePicker, Drawer, Form, Input, InputNumber, Select, Tag, Typography } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import AttachmentPanel from "@/components/AttachmentPanel";
import CrudTable from "@/components/CrudTable";
import Supplier360Drawer from "./supplier-360-drawer";
import { hasAnyRole, useMe } from "@/components/useMe";
import {
  SUPPLIER_KIND_LABELS,
  SUPPLIER_STATUS_COLORS,
  SUPPLIER_STATUS_LABELS,
  toOptions,
} from "@/components/labels";

interface SupplierRow {
  id: number;
  code: string;
  name: string;
  kinds: string[];
  contact: string | null;
  licenseExpiry: string | null;
  status: string;
  capacityValidFrom?: string | null;
  capacityValidUntil?: string | null;
}

export default function SupplierClient({ initialQuery = "" }: { initialQuery?: string }) {
  const me = useMe();
  const canWrite = hasAnyRole(me, "purchasing");
  const [attachSupplier, setAttachSupplier] = useState<SupplierRow | null>(null);
  // 供应商 360：主数据页原本是纯 CRUD，采购在这里维护档案却看不到 OTIF/交期/质检/账期任何一项
  const [view360, setView360] = useState<number | null>(null);
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        供应商
      </Typography.Title>
      <CrudTable<SupplierRow>
        key={initialQuery}
        initialQuery={initialQuery}
        loadDetailOnEdit
        rowActions={(r) => (
          <>
            <Button type="link" size="small" onClick={() => setView360(r.id)}>
              供应商 360
            </Button>
            <Button type="link" size="small" href={`/master/supplier/lifecycle?supplierId=${r.id}`}>
              生命周期
            </Button>
            <Button type="link" size="small" onClick={() => setAttachSupplier(r)}>
              资质证照
            </Button>
          </>
        )}
        canCreate={canWrite}
        canEdit={() => canWrite}
        entityName="供应商"
        apiPath="/api/master/supplier"
        searchPlaceholder="搜索编码/名称"
        columns={[
          { title: "编码", dataIndex: "code", width: 110, sorter: (a, b) => a.code.localeCompare(b.code) },
          { title: "名称", dataIndex: "name", sorter: (a, b) => a.name.localeCompare(b.name) },
          {
            title: "类型",
            dataIndex: "kinds",
            width: 180,
            render: (kinds: string[]) => kinds.map((k) => <Tag key={k}>{SUPPLIER_KIND_LABELS[k] ?? k}</Tag>),
          },
          { title: "联系人", dataIndex: "contact", width: 120 },
          {
            title: "营业执照到期日",
            dataIndex: "licenseExpiry",
            width: 140,
            sorter: (a, b) => (a.licenseExpiry ?? "").localeCompare(b.licenseExpiry ?? ""),
            render: (v: string | null) => v ?? "—",
          },
          {
            title: "状态",
            dataIndex: "status",
            width: 100,
            filters: Object.entries(SUPPLIER_STATUS_LABELS).map(([value, text]) => ({ value, text })),
            onFilter: (value, row) => row.status === value,
            render: (v: string) => <Tag color={SUPPLIER_STATUS_COLORS[v]}>{SUPPLIER_STATUS_LABELS[v] ?? v}</Tag>,
          },
        ]}
        toFormValues={(r) => ({
          ...r,
          licenseExpiry: r.licenseExpiry ? dayjs(r.licenseExpiry) : undefined,
          capacityValidFrom: r.capacityValidFrom ? dayjs(r.capacityValidFrom) : undefined,
          capacityValidUntil: r.capacityValidUntil ? dayjs(r.capacityValidUntil) : undefined,
          paymentTermEffectiveFrom: (r as SupplierRow & { paymentTermEffectiveFrom?: string | null }).paymentTermEffectiveFrom
            ? dayjs((r as SupplierRow & { paymentTermEffectiveFrom?: string | null }).paymentTermEffectiveFrom)
            : undefined,
        })}
        transformSubmit={(values) => ({
          ...values,
          licenseExpiry: values.licenseExpiry ? (values.licenseExpiry as Dayjs).format("YYYY-MM-DD") : null,
          paymentTermEffectiveFrom: values.paymentTermEffectiveFrom ? (values.paymentTermEffectiveFrom as Dayjs).format("YYYY-MM-DD") : null,
          creditDays: values.paymentTermType === "monthly_credit" ? values.creditDays ?? null : null,
          declaredMonthlyCapacity: values.declaredMonthlyCapacity == null || values.declaredMonthlyCapacity === "" ? null : String(values.declaredMonthlyCapacity),
          capacityValidFrom: values.declaredMonthlyCapacity == null ? null : values.capacityValidFrom ? (values.capacityValidFrom as Dayjs).format("YYYY-MM-DD") : null,
          capacityValidUntil: values.declaredMonthlyCapacity == null ? null : values.capacityValidUntil ? (values.capacityValidUntil as Dayjs).format("YYYY-MM-DD") : null,
          capacityEvidence: values.declaredMonthlyCapacity == null ? null : values.capacityEvidence ?? null,
        })}
        formItems={() => (
          <>
            <Form.Item name="code" label="编码" rules={[{ required: true, message: "编码必填" }]}>
              <Input maxLength={30} placeholder="如 SUP001" />
            </Form.Item>
            <Form.Item name="name" label="名称" rules={[{ required: true, message: "名称必填" }]}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="kinds" label="类型" rules={[{ required: true, message: "至少选择一种类型" }]}>
              <Select mode="multiple" options={toOptions(SUPPLIER_KIND_LABELS)} placeholder="原料/包材/加工厂（可多选）" />
            </Form.Item>
            <Form.Item name="contact" label="联系人">
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="phone" label="电话">
              <Input maxLength={30} />
            </Form.Item>
            <Form.Item name="email" label="邮箱">
              <Input maxLength={100} type="email" />
            </Form.Item>
            <Form.Item name="address" label="地址">
              <Input maxLength={200} />
            </Form.Item>
            <Form.Item name="paymentTerm" label="结算方式">
              <Select
                allowClear
                options={[
                  { value: "款到发货", label: "款到发货" },
                  { value: "月结30", label: "月结 30 天" },
                  { value: "月结60", label: "月结 60 天" },
                ]}
              />
            </Form.Item>
            <Form.Item name="bankAccount" label="银行账户" tooltip="敏感字段：仅采购/PMC/财务/管理员可见（R9 脱敏）">
              <Input maxLength={60} placeholder="开户行+账号" />
            </Form.Item>
            <Form.Item name="level" label="供应商分级" tooltip="S–D 人工评级；D7 评分体系 P1 参数化联动">
              <Select allowClear options={["S", "A", "B", "C", "D"].map((v) => ({ value: v, label: v }))} />
            </Form.Item>
            <Form.Item name="licenseExpiry" label="营业执照到期日" tooltip="资质预警数据源（1.1 启用预警）">
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            {/* D64 账期结构化：口径以三列为准，「结算方式」文本保留作原文 */}
            <Form.Item name="paymentTermType" label="账期类型" tooltip="D64：预付 / 款到发货 / 月结；月结须填天数与生效日（账期候选看板据此判达标）">
              <Select
                allowClear
                options={[
                  { value: "prepay", label: "预付" },
                  { value: "on_delivery", label: "款到发货" },
                  { value: "monthly_credit", label: "月结" },
                ]}
              />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(a, b) => a.paymentTermType !== b.paymentTermType}>
              {({ getFieldValue }) => (
                <>
                  {getFieldValue("paymentTermType") === "monthly_credit" ? (
                    <Form.Item name="creditDays" label="账期天数（天）" rules={[{ required: true, message: "月结必须填写账期天数" }]}>
                      <InputNumber aria-label="账期天数" min={0} max={180} style={{ width: "100%" }} />
                    </Form.Item>
                  ) : null}
                  {getFieldValue("paymentTermType") ? (
                    <Form.Item name="paymentTermEffectiveFrom" label="账期生效日" rules={[{ required: true, message: "登记账期必须填写生效日" }]}>
                      <DatePicker style={{ width: "100%" }} />
                    </Form.Item>
                  ) : null}
                </>
              )}
            </Form.Item>
            <Typography.Title level={5}>申报产能</Typography.Title>
            <Typography.Paragraph type="secondary">供应商总体月度情景，不是向我司承诺的余量。填写完整有效期与依据、且单位一致后，才可在加工单比较。</Typography.Paragraph>
            <div className="supplier-capacity-fields" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))", columnGap: 12 }}>
            <Form.Item name="declaredMonthlyCapacity" label="申报月产能" tooltip="供应商申报值，按申报单位原样记录，不做换算">
              <InputNumber aria-label="申报月产能" stringMode min="0" max="9999999999.9999" precision={4} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="capacityUom" label="产能单位">
              <Input maxLength={20} placeholder="如 万支 / 吨 / 万套" />
            </Form.Item>
            <Form.Item name="capacityValidFrom" label="有效开始日">
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="capacityValidUntil" label="有效结束日">
              <DatePicker style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="surgeCapacityPct" label="加班增幅（%）" tooltip="相对正常申报月产能的增加比例（0–300%）；未填表示未知，不是0%">
              <InputNumber aria-label="加班增幅" min={0} max={300} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="capacityEvidence" label="产能申报依据" style={{ gridColumn: "1 / -1" }} tooltip="填写供应商确认记录/协议编号或受控文件位置；系统不会自动访问链接">
              <Input.TextArea aria-label="产能申报依据" rows={2} maxLength={1000} />
            </Form.Item>
            </div>
          </>
        )}
      />
      <Drawer
        title={attachSupplier ? `资质证照 — ${attachSupplier.code} ${attachSupplier.name}` : "资质证照"}
        width={560}
        open={attachSupplier != null}
        onClose={() => setAttachSupplier(null)}
        destroyOnHidden
      >
        {attachSupplier ? (
          <AttachmentPanel entity="supplier" entityId={attachSupplier.id} canWrite={canWrite} title="资质证照" />
        ) : null}
      </Drawer>
      <Supplier360Drawer supplierId={view360} onClose={() => setView360(null)} />
    </div>
  );
}
