"use client";

import { useState } from "react";
import { Button, DatePicker, Drawer, Form, Input, Select, Tag, Typography } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import AttachmentPanel from "@/components/AttachmentPanel";
import CrudTable from "@/components/CrudTable";
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
}

export default function SupplierClient() {
  const me = useMe();
  const canWrite = hasAnyRole(me, "purchasing");
  const [attachSupplier, setAttachSupplier] = useState<SupplierRow | null>(null);
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        供应商
      </Typography.Title>
      <CrudTable<SupplierRow>
        rowActions={(r) => (
          <Button type="link" size="small" onClick={() => setAttachSupplier(r)}>
            资质证照
          </Button>
        )}
        canCreate={canWrite}
        canEdit={() => canWrite}
        entityName="供应商"
        apiPath="/api/master/supplier"
        searchPlaceholder="搜索编码/名称"
        columns={[
          { title: "编码", dataIndex: "code", width: 110 },
          { title: "名称", dataIndex: "name" },
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
            render: (v: string | null) => v ?? "—",
          },
          {
            title: "状态",
            dataIndex: "status",
            width: 100,
            render: (v: string) => <Tag color={SUPPLIER_STATUS_COLORS[v]}>{SUPPLIER_STATUS_LABELS[v] ?? v}</Tag>,
          },
        ]}
        toFormValues={(r) => ({
          ...r,
          licenseExpiry: r.licenseExpiry ? dayjs(r.licenseExpiry) : undefined,
        })}
        transformSubmit={(values) => ({
          ...values,
          licenseExpiry: values.licenseExpiry ? (values.licenseExpiry as Dayjs).format("YYYY-MM-DD") : null,
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
            <Form.Item name="status" label="状态" initialValue="pending" tooltip="暂停：观察期建议不下新单（软提示）；黑名单：禁新 PO/WO 硬门，存量 JG 可收尾">
              <Select options={toOptions(SUPPLIER_STATUS_LABELS)} />
            </Form.Item>
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
    </div>
  );
}
