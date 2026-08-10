"use client";

import SearchInput from "@/components/SearchInput";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Form, Modal, Space, Table } from "antd";
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
  /**
   * 编辑前从 `${apiPath}/${id}` 读取完整记录。
   * 列表 DTO 往往刻意省略敏感/低频字段，不能拿列表行覆盖完整主数据。
   */
  loadDetailOnEdit?: boolean;
  /** 提交前：表单值 → 请求体 */
  transformSubmit?: (values: Record<string, unknown>, editing: T | null) => Record<string, unknown>;
  searchPlaceholder?: string;
  /** 业务筛选器，展示在搜索框后、操作按钮前。 */
  toolbarFilters?: React.ReactNode;
  /** 除 q/page/pageSize 外传给列表 API 的筛选参数。 */
  queryParams?: Record<string, string | undefined>;
  modalWidth?: number;
  /** 是否允许编辑该行（默认允许） */
  canEdit?: (record: T) => boolean;
  /** 角色感知（UX Top-4）：false 时隐藏「新建」按钮（服务端权限仍是唯一权威） */
  canCreate?: boolean;
  /** 额外行操作（如 BOM 生效） */
  rowActions?: (record: T, reload: () => void) => React.ReactNode;
  /** 批量操作（如批量设置业务用途）；与 rowActions 一样把 reload 交出去，避免各页自己造刷新。 */
  toolbarActions?: (reload: () => void) => React.ReactNode;
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
    loadDetailOnEdit = false,
    transformSubmit,
    searchPlaceholder,
    toolbarFilters,
    queryParams,
    modalWidth,
    canEdit,
    canCreate = true,
    rowActions,
    toolbarActions,
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
  const [openingEditId, setOpeningEditId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const queryParamsKey = JSON.stringify(queryParams ?? {});
  const previousQueryParamsKey = useRef(queryParamsKey);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q,
        page: String(page),
        pageSize: String(pageSize),
      });
      for (const [key, value] of Object.entries(JSON.parse(queryParamsKey) as Record<string, string>)) {
        if (value) params.set(key, value);
      }
      const res = await fetchJson<ListResponse<T>>(
        `${apiPath}?${params.toString()}`,
      );
      setData(res.data);
      setTotal(res.total);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [apiPath, q, page, pageSize, message, queryParamsKey]);

  useEffect(() => {
    if (previousQueryParamsKey.current !== queryParamsKey) {
      previousQueryParamsKey.current = queryParamsKey;
      if (page !== 1) {
        setPage(1);
        return;
      }
    }
    void load();
  }, [load, page, queryParamsKey]);

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = useCallback(
    async (record: T) => {
      setOpeningEditId(record.id);
      try {
        const completeRecord = loadDetailOnEdit
          ? await fetchJson<T>(`${apiPath}/${record.id}`)
          : record;
        setEditing(completeRecord);
        form.resetFields();
        form.setFieldsValue(
          toFormValues ? toFormValues(completeRecord) : (completeRecord as Record<string, unknown>),
        );
        setModalOpen(true);
      } catch (e) {
        message.error((e as Error).message);
      } finally {
        setOpeningEditId(null);
      }
    },
    [apiPath, form, loadDetailOnEdit, message, toFormValues],
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
        width: rowActions ? 220 : 100,
        fixed: "right",
        render: (_: unknown, record: T) => (
          <Space size={0}>
            {(canEdit ? canEdit(record) : true) && (
              <Button
                type="link"
                size="small"
                loading={openingEditId === record.id}
                onClick={() => void openEdit(record)}
              >
                编辑
              </Button>
            )}
            {rowActions?.(record, () => void load())}
          </Space>
        ),
      },
    ],
    [columns, canEdit, rowActions, load, openEdit, openingEditId],
  );

  return (
    <div>
      <Space className="crud-table__toolbar" wrap>
        <SearchInput
          allowClear
          placeholder={searchPlaceholder ?? "搜索编码/名称"}
          style={{ width: 280 }}
          onSearch={(value) => {
            setQ(value.trim());
            setPage(1);
          }}
        />
        {toolbarFilters}
        <Space className="crud-table__toolbar-actions" wrap>
          {toolbarActions?.(() => void load())}
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建{entityName}
            </Button>
          )}
        </Space>
      </Space>
      <Table<T>
        {...tableProps}
        className={`crud-table${tableProps?.className ? ` ${tableProps.className}` : ""}`}
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
        scroll={tableProps?.scroll ?? { x: "max-content" }}
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
