"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Form, Input, Modal, Space, Table } from "antd";
import type { FormInstance, TableProps } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { fetchJson, postJson, putJson } from "./fetchJson";

export interface ListResponse<T> {
  data: T[];
  total: number;
}

export interface CrudTableProps<T extends { id: number }> {
  /** 实体中文名（用于按钮/弹窗标题） */
  entityName: string;
  /** REST 前缀，如 /api/master/spu */
  apiPath: string;
  columns: ColumnsType<T>;
  /** 弹窗表单项（editing=null 表示新建） */
  formItems: (editing: T | null, form: FormInstance) => React.ReactNode;
  /** 编辑时：记录 → 表单值 */
  toFormValues?: (record: T) => Record<string, unknown>;
  /** 提交前：表单值 → 请求体 */
  transformSubmit?: (values: Record<string, unknown>, editing: T | null) => Record<string, unknown>;
  searchPlaceholder?: string;
  modalWidth?: number;
  /** 是否允许编辑该行（默认允许） */
  canEdit?: (record: T) => boolean;
  /** 额外行操作（如 BOM 生效） */
  rowActions?: (record: T, reload: () => void) => React.ReactNode;
  /** 透传 Table 属性（如 expandable） */
  tableProps?: Omit<TableProps<T>, "columns" | "dataSource" | "loading" | "pagination" | "rowKey">;
}

export default function CrudTable<T extends { id: number }>(props: CrudTableProps<T>) {
  const {
    entityName,
    apiPath,
    columns,
    formItems,
    toFormValues,
    transformSubmit,
    searchPlaceholder,
    modalWidth,
    canEdit,
    rowActions,
    tableProps,
  } = props;

  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [data, setData] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson<ListResponse<T>>(
        `${apiPath}?q=${encodeURIComponent(q)}&page=${page}&pageSize=${pageSize}`,
      );
      setData(res.data);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiPath, q, page, pageSize, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = useCallback(
    (record: T) => {
      setEditing(record);
      form.resetFields();
      form.setFieldsValue(toFormValues ? toFormValues(record) : (record as Record<string, unknown>));
      setModalOpen(true);
    },
    [form, toFormValues],
  );

  const handleSubmit = async () => {
    try {
      const values = (await form.validateFields()) as Record<string, unknown>;
      const body = transformSubmit ? transformSubmit(values, editing) : values;
      setSaving(true);
      if (editing) {
        await putJson(`${apiPath}/${editing.id}`, body);
        message.success("保存成功");
      } else {
        await postJson(apiPath, body);
        message.success("新建成功");
      }
      setModalOpen(false);
      void load();
    } catch (e) {
      // 表单校验失败时 antd 抛出的对象没有 message，忽略即可
      if (e instanceof Error && e.message) message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const mergedColumns = useMemo<ColumnsType<T>>(
    () => [
      ...columns,
      {
        title: "操作",
        key: "_actions",
        width: 160,
        render: (_: unknown, record: T) => (
          <Space size={0}>
            {(canEdit ? canEdit(record) : true) && (
              <Button type="link" size="small" onClick={() => openEdit(record)}>
                编辑
              </Button>
            )}
            {rowActions?.(record, () => void load())}
          </Space>
        ),
      },
    ],
    [columns, canEdit, rowActions, load, openEdit],
  );

  return (
    <div>
      <Space style={{ marginBottom: 16, display: "flex", justifyContent: "space-between" }} wrap>
        <Input.Search
          allowClear
          placeholder={searchPlaceholder ?? "搜索编码/名称"}
          style={{ width: 280 }}
          onSearch={(value) => {
            setQ(value.trim());
            setPage(1);
          }}
        />
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新建{entityName}
          </Button>
        </Space>
      </Space>
      <Table<T>
        rowKey="id"
        size="middle"
        columns={mergedColumns}
        dataSource={data}
        loading={loading}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
        {...tableProps}
      />
      <Modal
        title={editing ? `编辑${entityName}` : `新建${entityName}`}
        open={modalOpen}
        onOk={() => void handleSubmit()}
        onCancel={() => setModalOpen(false)}
        confirmLoading={saving}
        width={modalWidth ?? 560}
        forceRender
        maskClosable={false}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          {formItems(editing, form)}
        </Form>
      </Modal>
    </div>
  );
}
