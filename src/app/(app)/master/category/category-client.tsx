"use client";

import { Form, Input, Tag, Typography } from "antd";
import CrudTable from "@/components/CrudTable";
import RemoteSelect from "@/components/RemoteSelect";

interface CategoryRow {
  id: number;
  name: string;
  parentId: number | null;
  parentName: string | null;
  level: number;
}

export default function CategoryClient() {
  return (
    <div>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        分类
      </Typography.Title>
      <CrudTable<CategoryRow>
        entityName="分类"
        apiPath="/api/master/category"
        searchPlaceholder="搜索分类名称"
        columns={[
          { title: "名称", dataIndex: "name" },
          { title: "上级分类", dataIndex: "parentName", render: (v: string | null) => v ?? "—" },
          {
            title: "层级",
            dataIndex: "level",
            width: 100,
            render: (v: number) => <Tag>{v} 级</Tag>,
          },
        ]}
        formItems={(editing) => (
          <>
            <Form.Item name="name" label="名称" rules={[{ required: true, message: "分类名称必填" }]}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="parentId" label="上级分类" tooltip="最多 3 级；留空为一级分类">
              <RemoteSelect
                api="/api/master/category"
                getLabel={(r) => `${String(r.name)}（${String(r.level)}级）`}
                filterRow={(r) => (r.level as number) < 3 && r.id !== editing?.id}
                allowClear
                placeholder="留空为一级分类"
              />
            </Form.Item>
          </>
        )}
      />
    </div>
  );
}
