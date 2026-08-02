"use client";

import { useState } from "react";
import {
  Alert,
  App,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";
import AttachmentPanel from "@/components/AttachmentPanel";
import CrudTable from "@/components/CrudTable";
import { hasAnyRole, useMe } from "@/components/useMe";
import RemoteSelect from "@/components/RemoteSelect";
import { COMMERCIAL_ROLE_LABELS, LOSS_CATEGORY_LABELS, SKU_TYPE_LABELS, toOptions } from "@/components/labels";
import { LIFECYCLE_LABELS } from "@/components/format";
import SkuPanoramaDrawer from "./sku-panorama-drawer";
import SkuIdentifiersDrawer from "./sku-identifiers-drawer";
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
  brand: string | null;
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
  const canHistoricalMigration = me?.roles.includes("admin") ?? false;
  const [panoramaId, setPanoramaId] = useState<number | null>(null);
  const [attachSku, setAttachSku] = useState<SkuRow | null>(null);
  const [identifierSku, setIdentifierSku] = useState<SkuRow | null>(null);
  const [commercialRole, setCommercialRole] = useState<string>();
  const [codeGuideOpen, setCodeGuideOpen] = useState(false);
  return (
    <div>
      <Space align="center" style={{ marginBottom: 16 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          SKU 货品
        </Typography.Title>
        <Button
          type="text"
          size="small"
          icon={<InfoCircleOutlined />}
          onClick={() => setCodeGuideOpen(true)}
        >
          编码标准
        </Button>
      </Space>
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
            <Button type="link" size="small" onClick={() => setIdentifierSku(r)}>
              标识
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
        searchPlaceholder="搜索主码/GTIN/外部码/产品名/规格"
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
            title: "品牌",
            dataIndex: "brand",
            width: 110,
            render: (v: string | null) => v ?? "共享/中性",
          },
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
        formItems={(editing, form) => (
          <>
            {editing == null ? (
              <>
                {canHistoricalMigration ? (
                  <Form.Item
                    name="creationMode"
                    label="建档模式"
                    initialValue="governed_s1"
                    tooltip="日常新建必须使用 S1；历史迁移只供管理员处理已经存在的真实旧码"
                  >
                    <Select
                      options={[
                        { value: "governed_s1", label: "新主档（系统自动生成 S1）" },
                        { value: "historical_migration", label: "历史迁移（管理员例外）" },
                      ]}
                    />
                  </Form.Item>
                ) : (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message="新主档由系统自动生成 S1 编码"
                    description="保存后才原子取号，不需要也不能手工占号。"
                  />
                )}
                <Form.Item noStyle shouldUpdate={(previous, current) => previous.creationMode !== current.creationMode}>
                  {() => form.getFieldValue("creationMode") === "historical_migration" ? (
                    <>
                      <Alert
                        type="warning"
                        showIcon
                        style={{ marginBottom: 16 }}
                        message="仅用于真实历史主档迁移"
                        description="不会生成 S1；编码和迁移原因会随建档事件一起进入审计。"
                      />
                      <Form.Item
                        name="code"
                        label="历史编码"
                        preserve={false}
                        rules={[{ required: true, message: "请填写真实历史编码" }]}
                      >
                        <Input maxLength={30} placeholder="输入已存在且需保留的历史主码" />
                      </Form.Item>
                      <Form.Item
                        name="historicalMigrationReason"
                        label="迁移原因"
                        preserve={false}
                        rules={[
                          { required: true, message: "请填写迁移原因" },
                          { min: 10, message: "迁移原因至少 10 个字" },
                          { max: 500, message: "迁移原因最多 500 个字" },
                        ]}
                      >
                        <Input.TextArea rows={3} showCount maxLength={500} placeholder="说明历史来源、保留旧码的必要性和可核对依据" />
                      </Form.Item>
                    </>
                  ) : (
                    <Form.Item label="编码" extra="保存后由服务端在同一事务中原子取号。">
                      <Input disabled value="系统将自动生成 S1 编码" />
                    </Form.Item>
                  )}
                </Form.Item>
              </>
            ) : (
              <Form.Item name="code" label="编码" tooltip="稳定主码已用于历史关联，不可修改">
                <Input disabled maxLength={30} />
              </Form.Item>
            )}
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
        title="SKU 编码标准 S1"
        width={620}
        open={codeGuideOpen}
        onClose={() => setCodeGuideOpen(false)}
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Alert
            type="info"
            showIcon
            message="日常新建由系统自动生成；真实历史迁移由管理员走审计例外"
            description="S1 只表达稳定身份。渠道、规格、供应商、生命周期和 BOM 关系会变化，必须保存在结构化字段中，不写进永久编码。"
          />
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="格式">
              <Typography.Text code>S1-来源-类型-六位流水-两位校验码</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="示例">
              <Typography.Text code>S1-EXP-F-000123-K7</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="来源">
              品牌主档短码（例如 EXP / NING / DEV），因此主码可直接区分品牌；
              共享或中性物料使用 <Typography.Text code>GEN</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="流水">
              企业全局原子取号，允许跳号，不按品牌重复计数
            </Descriptions.Item>
            <Descriptions.Item label="校验码">
              发现常见误录；不是权限或安全签名
            </Descriptions.Item>
            <Descriptions.Item label="外部标识">
              GTIN、包装层级条码、聚水潭/用友编码、供应商及客户料号独立登记，不写进 S1
            </Descriptions.Item>
          </Descriptions>
          <Table
            size="small"
            pagination={false}
            rowKey="code"
            columns={[
              { title: "类型码", dataIndex: "code", width: 90 },
              { title: "SKU 类型", dataIndex: "label" },
            ]}
            dataSource={[
              { code: "F", label: "成品 finished" },
              { code: "H", label: "半成品 semi" },
              { code: "R", label: "原料 raw" },
              { code: "P", label: "包材 packaging" },
              { code: "V", label: "服务 service" },
            ]}
          />
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            S1 命名空间只允许系统原子取号，不能手工输入或占号；日常新建无需填写编码。
            只有管理员处理已存在的真实旧主码时，才可选择“历史迁移”并填写可核对原因；
            外部系统编码优先通过独立标识与别名登记，不会被自动改写。
          </Typography.Paragraph>
        </Space>
      </Drawer>
      <SkuIdentifiersDrawer
        sku={identifierSku}
        canWrite={canWrite}
        onClose={() => setIdentifierSku(null)}
      />
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
