"use client";

import { useState } from "react";
import { Button, Drawer, Form, Input, Select, Switch, Tag, Typography } from "antd";
import AttachmentPanel from "@/components/AttachmentPanel";
import CrudTable from "@/components/CrudTable";
import { hasAnyRole, useMe } from "@/components/useMe";
import RemoteSelect from "@/components/RemoteSelect";
import { LOSS_CATEGORY_LABELS, SKU_TYPE_LABELS, toOptions } from "@/components/labels";
import { LIFECYCLE_LABELS } from "@/components/format";
import SkuPanoramaDrawer from "./sku-panorama-drawer";

interface SkuRow {
  id: number;
  code: string;
  name: string;
  spuId: number;
  spuCode: string;
  spuNameCn: string;
  skuType: string;
  baseUom: string;
  spec: string | null;
  version: string | null;
  prodMode: string | null;
  lossCategory: string | null;
  active: boolean;
}

const SKU_TYPE_COLORS: Record<string, string> = { finished: "blue", raw: "green", packaging: "orange" };

export default function SkuClient() {
  const me = useMe();
  const canWrite = hasAnyRole(me, "pmc");
  const [panoramaId, setPanoramaId] = useState<number | null>(null);
  const [attachSku, setAttachSku] = useState<SkuRow | null>(null);
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        SKU 货品
      </Typography.Title>
      <CrudTable<SkuRow>
        rowActions={(r) => (
          <>
            <Button type="link" size="small" onClick={() => setPanoramaId(r.id)}>
              全景
            </Button>
            <Button type="link" size="small" onClick={() => setAttachSku(r)}>
              附件
            </Button>
          </>
        )}
        canCreate={canWrite}
        canEdit={() => canWrite}
        entityName="SKU"
        apiPath="/api/master/sku"
        searchPlaceholder="搜索编码/产品名/规格"
        modalWidth={640}
        columns={[
          { title: "编码", dataIndex: "code", width: 110 },
          { title: "货品名称", dataIndex: "name", width: 160 },
          {
            title: "所属产品",
            dataIndex: "spuNameCn",
            render: (_, r) => `${r.spuCode} ${r.spuNameCn}`,
          },
          {
            title: "类型",
            dataIndex: "skuType",
            width: 90,
            render: (v: string) => <Tag color={SKU_TYPE_COLORS[v]}>{SKU_TYPE_LABELS[v] ?? v}</Tag>,
          },
          { title: "规格", dataIndex: "spec", width: 140 },
          { title: "基础单位", dataIndex: "baseUom", width: 90 },
          {
            title: "损耗品类",
            dataIndex: "lossCategory",
            width: 100,
            render: (v: string | null) => (v ? LOSS_CATEGORY_LABELS[v] ?? v : "—"),
          },
          {
            title: "生命周期",
            dataIndex: "lifecycle",
            width: 90,
            render: (v: string | null) => (v ? LIFECYCLE_LABELS[v] ?? v : "在售"),
          },
          {
            title: "状态",
            dataIndex: "active",
            width: 80,
            render: (v: boolean) => (v ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>),
          },
        ]}
        formItems={() => (
          <>
            <Form.Item name="code" label="编码" rules={[{ required: true, message: "编码必填" }]}>
              <Input maxLength={30} placeholder="如 CP00001（品类2位+5位流水）" />
            </Form.Item>
            <Form.Item name="name" label="货品名称" rules={[{ required: true, message: "货品名称必填" }]}>
              <Input maxLength={100} placeholder="如 胶原蛋白肽饮品 50ml×10" />
            </Form.Item>
            <Form.Item name="spuId" label="所属 SPU" rules={[{ required: true, message: "必须选择所属 SPU" }]}>
              <RemoteSelect
                api="/api/master/spu"
                getLabel={(r) => `${String(r.code)} ${String(r.nameCn)}`}
                placeholder="选择 SPU 产品"
              />
            </Form.Item>
            <Form.Item name="skuType" label="类型" rules={[{ required: true, message: "必须选择类型" }]}>
              <Select options={toOptions(SKU_TYPE_LABELS)} placeholder="成品/原料/包材" />
            </Form.Item>
            <Form.Item name="baseUom" label="基础单位" rules={[{ required: true, message: "基础单位必填" }]}>
              <Input maxLength={10} placeholder="如 盒 / kg / 个" />
            </Form.Item>
            <Form.Item name="spec" label="规格">
              <Input maxLength={100} placeholder="如 50ml×10" />
            </Form.Item>
            <Form.Item name="version" label="版本">
              <Input maxLength={30} />
            </Form.Item>
            <Form.Item name="prodMode" label="生产模式">
              <Input maxLength={30} placeholder="如 委外" />
            </Form.Item>
            <Form.Item name="lossCategory" label="损耗品类" tooltip="品类允许损耗率参数键（R2），原料/包材需选择">
              <Select allowClear options={toOptions(LOSS_CATEGORY_LABELS)} placeholder="原料/包材" />
            </Form.Item>
            <Form.Item name="brandId" label="品牌">
              <RemoteSelect api="/api/master/brand" getLabel={(r) => `${String(r.code)} ${String(r.nameCn)}`} placeholder="选择品牌" />
            </Form.Item>
            <Form.Item name="lifecycle" label="生命周期" initialValue="on_sale" tooltip="在售/试销/停售/淘汰（试销=新品观察期）">
              <Select options={toOptions(LIFECYCLE_LABELS)} />
            </Form.Item>
            <Form.Item name="active" label="启用" valuePropName="checked" initialValue={true}>
              <Switch checkedChildren="启用" unCheckedChildren="停用" />
            </Form.Item>
          </>
        )}
      />
      <SkuPanoramaDrawer skuId={panoramaId} onClose={() => setPanoramaId(null)} />
      <Drawer
        title={attachSku ? `图片与附件 — ${attachSku.code} ${attachSku.name}` : "图片与附件"}
        width={560}
        open={attachSku != null}
        onClose={() => setAttachSku(null)}
        destroyOnClose
      >
        {attachSku ? (
          <AttachmentPanel entity="sku" entityId={attachSku.id} canWrite={canWrite} title="图片与附件" />
        ) : null}
      </Drawer>
    </div>
  );
}
