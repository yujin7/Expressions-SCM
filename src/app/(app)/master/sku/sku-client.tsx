"use client";

import { useState } from "react";
import { App, Button, Drawer, Form, Input, InputNumber, Select, Switch, Tag, Tooltip, Typography } from "antd";
import AttachmentPanel from "@/components/AttachmentPanel";
import CrudTable from "@/components/CrudTable";
import { hasAnyRole, useMe } from "@/components/useMe";
import RemoteSelect from "@/components/RemoteSelect";
import { COMMERCIAL_ROLE_LABELS, LOSS_CATEGORY_LABELS, SKU_TYPE_LABELS, toOptions } from "@/components/labels";
import { LIFECYCLE_LABELS } from "@/components/format";
import SkuPanoramaDrawer from "./sku-panorama-drawer";
import { postJson } from "@/components/fetchJson";

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
  brandId: number | null;
  channelId: number | null;
  shortName: string | null;
  commercialRole: string;
  logisticsLeadDays: number | null;
  shelfLifeDays: number | null;
  nearExpiryDays: number | null;
  standardName: string | null;
  namingStatus: "incomplete" | "ready" | "standard";
  lifecycle: string;
  active: boolean;
}

const SKU_TYPE_COLORS: Record<string, string> = {
  finished: "blue",
  semi: "geekblue",
  raw: "green",
  packaging: "orange",
  service: "cyan",
};

export default function SkuClient() {
  const { message, modal } = App.useApp();
  const me = useMe();
  const canWrite = hasAnyRole(me, "pmc");
  const [panoramaId, setPanoramaId] = useState<number | null>(null);
  const [attachSku, setAttachSku] = useState<SkuRow | null>(null);
  const [commercialRole, setCommercialRole] = useState<string>();
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        SKU 货品
      </Typography.Title>
      <CrudTable<SkuRow>
        rowActions={(r, reload) => (
          <>
            {canWrite && r.namingStatus === "ready" && r.standardName ? (
              <Tooltip title={`建议：${r.standardName}`}>
                <Button
                  type="link"
                  size="small"
                  onClick={() => modal.confirm({
                    title: "采用标准名称？",
                    content: <>仅更新展示名称为“{r.standardName}”；稳定 SKU 主码 {r.code} 不变。</>,
                    okText: "采用",
                    cancelText: "取消",
                    onOk: async () => {
                      await postJson(`/api/master/sku/${r.id}/standardize-name`, {});
                      message.success("已采用标准名称，SKU 主码未变");
                      reload();
                    },
                  })}
                >
                  采用标准名
                </Button>
              </Tooltip>
            ) : null}
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
        queryParams={{ commercialRole }}
        toolbarFilters={(
          <Select
            allowClear
            value={commercialRole}
            placeholder="全部业务用途"
            options={toOptions(COMMERCIAL_ROLE_LABELS)}
            style={{ width: 150 }}
            onChange={setCommercialRole}
          />
        )}
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
            title: "业务用途",
            dataIndex: "commercialRole",
            width: 105,
            render: (v: string) => (
              <Tag color={v === "sample" ? "purple" : v === "unclassified" ? "warning" : undefined}>
                {COMMERCIAL_ROLE_LABELS[v] ?? v}
              </Tag>
            ),
          },
          {
            title: "命名治理",
            dataIndex: "namingStatus",
            width: 105,
            render: (v: SkuRow["namingStatus"], r) => (
              <Tooltip title={r.standardName ? `建议：${r.standardName}` : "请先补齐品牌与产品简称"}>
                <Tag color={v === "standard" ? "success" : v === "ready" ? "processing" : "warning"}>
                  {v === "standard" ? "已标准" : v === "ready" ? "可采用" : "资料不足"}
                </Tag>
              </Tooltip>
            ),
          },
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
        formItems={(editing) => (
          <>
            <Form.Item name="code" label="编码" rules={[{ required: true, message: "编码必填" }]}>
              <Input
                disabled={editing != null}
                maxLength={30}
                placeholder="请输入现行商家编码，如 E02-088"
              />
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
              <Select options={toOptions(SKU_TYPE_LABELS)} placeholder="成品/半成品/原料/包材/服务" />
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
            <Form.Item
              name="shortName"
              label="产品简称"
              tooltip="最多 10 个字符；标准名称按 品牌 + 渠道 + 产品简称 + 版本 + 规格 生成"
              rules={[{ max: 10, message: "产品简称最多 10 个字符" }]}
            >
              <Input maxLength={10} placeholder="如 胶原蛋白肽饮" showCount />
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
            <Form.Item name="channelId" label="专属渠道" tooltip="空表示通用 SKU；仅渠道专属版本才选择">
              <RemoteSelect api="/api/master/channel" getLabel={(r) => `${String(r.code)} ${String(r.name)}`} placeholder="通用/选择渠道" />
            </Form.Item>
            <Form.Item
              name="commercialRole"
              label="业务用途"
              initialValue="retail"
              tooltip="样品/赠品/试用装仍计入库存真相，但从正常销售动销分析中分开"
            >
              <Select options={toOptions(COMMERCIAL_ROLE_LABELS)} />
            </Form.Item>
            <Form.Item
              name="logisticsLeadDays"
              label="物流/调拨周期（天）"
              tooltip="生产完成到可售仓的运输/调拨时间；补货总周期 = 生产周期 + 此字段"
            >
              <InputNumber min={0} max={365} precision={0} style={{ width: "100%" }} placeholder="未维护时暂按 0 天" />
            </Form.Item>
            <Form.Item name="shelfLifeDays" label="保质期（天）" tooltip="用于效期结构与渠道临期阈值核对">
              <InputNumber min={1} max={3650} precision={0} style={{ width: "100%" }} placeholder="如 1095" />
            </Form.Item>
            <Form.Item name="nearExpiryDays" label="临期预警阈值（天）" tooltip="维护后，管效期 SKU 收货将强制填写批次">
              <InputNumber min={1} max={3650} precision={0} style={{ width: "100%" }} placeholder="未维护时按系统兜底口径" />
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
        destroyOnHidden
      >
        {attachSku ? (
          <AttachmentPanel entity="sku" entityId={attachSku.id} canWrite={canWrite} title="图片与附件" />
        ) : null}
      </Drawer>
    </div>
  );
}
