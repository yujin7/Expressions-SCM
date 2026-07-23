"use client";

import { Form, Input, Typography } from "antd";
import CrudTable from "@/components/CrudTable";
import RemoteSelect from "@/components/RemoteSelect";

interface SpuRow {
  id: number;
  code: string;
  nameCn: string;
  nameEn: string | null;
  categoryId: number | null;
  categoryName: string | null;
}

export default function SpuClient() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        SPU 产品
      </Typography.Title>
      <CrudTable<SpuRow>
        entityName="SPU"
        apiPath="/api/master/spu"
        searchPlaceholder="搜索编码/中英文名"
        columns={[
          { title: "编码", dataIndex: "code", width: 120 },
          { title: "中文名", dataIndex: "nameCn" },
          { title: "英文名", dataIndex: "nameEn" },
          { title: "分类", dataIndex: "categoryName", width: 160 },
        ]}
        formItems={() => (
          <>
            <Form.Item
              name="code"
              label="编码"
              tooltip="留空自动生成 P+5位流水"
              rules={[{ pattern: /^P\d{5}$/, message: "格式：P+5位数字，如 P00001" }]}
            >
              <Input placeholder="留空自动生成" maxLength={6} />
            </Form.Item>
            <Form.Item name="nameCn" label="中文名" rules={[{ required: true, message: "中文名必填" }]}>
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="nameEn" label="英文名">
              <Input maxLength={100} />
            </Form.Item>
            <Form.Item name="categoryId" label="分类">
              <RemoteSelect
                api="/api/master/category"
                getLabel={(r) => String(r.name)}
                allowClear
                placeholder="选择分类"
              />
            </Form.Item>
          </>
        )}
      />
    </div>
  );
}
