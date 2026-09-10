"use client";

import SearchInput from "@/components/SearchInput";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Form, Modal, Space, Table } from "antd";
import type { FormInstance, TableProps } from "antd";
import type { ColumnsType } from "antd/es/table";
import { PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import { fetchJson, postJson, putJson } from "./fetchJson";
import { useDocumentRead } from "./useDocumentRead";
import LoadErrorAlert from "./LoadErrorAlert";
import ListToolbar from "./ListToolbar";
import type { ListState } from "./useListState";

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
  /** Initial deep-link search. Caller keys the table by this value when navigation changes it. */
  initialQuery?: string;
  /** Optional shared URL state. Owns search, sort/filter query, pagination and density together. */
  listState?: ListState<Record<string, string | undefined>>;
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
    initialQuery = "",
    listState,
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
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [q, setQ] = useState(initialQuery);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<T | null>(null);
  const [openingEditId, setOpeningEditId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const queryParamsKey = JSON.stringify(queryParams ?? {});
  const previousQueryParamsKey = useRef(queryParamsKey);
  const content = useRef<HTMLDivElement>(null);
  const editRequest = useRef<AbortController | null>(null);
  const effectivePage = listState?.page ?? (previousQueryParamsKey.current !== queryParamsKey ? 1 : page);
  const params = new URLSearchParams(listState ? listState.queryString() : { q, page: String(effectivePage), pageSize: String(pageSize) });
  for (const [key, value] of Object.entries(JSON.parse(queryParamsKey) as Record<string, string>)) {
    if (value) params.set(key, value);
  }
  const read = useDocumentRead<ListResponse<T>>(`${apiPath}?${params.toString()}`);
  const valid = read.data !== null && Array.isArray(read.data.data) && Number.isSafeInteger(read.data.total) && read.data.total >= 0;
  const data = valid ? read.data!.data : [];
  const total = valid ? read.data!.total : 0;
  const loading = read.phase === "loading";
  const loadError = read.error ?? (read.phase === "success" && !valid ? "列表响应格式异常，未显示为有效结果" : null);
  const retryRead = read.retry;
  const load = useCallback(() => { content.current?.focus({ preventScroll: true }); retryRead(); }, [retryRead]);

  useEffect(() => {
    if (previousQueryParamsKey.current !== queryParamsKey) {
      previousQueryParamsKey.current = queryParamsKey;
      if (page !== 1) {
        setPage(1);
      }
    }
  }, [page, queryParamsKey]);
  useEffect(() => () => editRequest.current?.abort(), []);

  const openCreate = () => {
    editRequest.current?.abort();
    setOpeningEditId(null);
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = useCallback(
    async (record: T) => {
      editRequest.current?.abort();
      const request = new AbortController();
      editRequest.current = request;
      setOpeningEditId(record.id);
      const timeout = setTimeout(() => {
        if (request.signal.aborted) return;
        request.abort();
        setOpeningEditId(null);
        message.error("读取详情超时，请重新点击编辑");
      }, 15_000);
      try {
        const completeRecord = loadDetailOnEdit
          ? await fetchJson<T>(`${apiPath}/${record.id}`, { signal: request.signal })
          : record;
        if (request.signal.aborted) return;
        setEditing(completeRecord);
        form.resetFields();
        form.setFieldsValue(
          toFormValues ? toFormValues(completeRecord) : (completeRecord as Record<string, unknown>),
        );
        setModalOpen(true);
      } catch (e) {
        if (!request.signal.aborted) message.error((e as Error).message);
      } finally {
        clearTimeout(timeout);
        if (!request.signal.aborted) setOpeningEditId(null);
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

  const searchControls = <>
        <SearchInput
          key={listState ? listState.filters.q ?? "" : undefined}
          defaultValue={listState ? listState.filters.q ?? "" : initialQuery}
          allowClear
          placeholder={searchPlaceholder ?? "搜索编码/名称"}
          style={{ width: 280 }}
          onSearch={(value) => {
            if (listState) { listState.setFilter({ q: value.trim() }); return; }
            setQ(value.trim());
            setPage(1);
          }}
        />
        {toolbarFilters}
      </>;
  const actions = <Space className="crud-table__toolbar-actions" wrap>
          {toolbarActions?.(() => void load())}
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          {canCreate && (
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新建{entityName}
            </Button>
          )}
        </Space>;

  return (
    <div ref={content} tabIndex={-1}>
      {listState ? <ListToolbar state={listState} extra={searchControls} primaryActions={actions} /> :
        <Space className="crud-table__toolbar" wrap>{searchControls}{actions}</Space>}
      <LoadErrorAlert error={loadError} subject={entityName} onRetry={load} retrying={loading} />
      <Table<T>
        {...tableProps}
        className={`crud-table${tableProps?.className ? ` ${tableProps.className}` : ""}`}
        rowKey="id"
        size={listState?.tableSize ?? "middle"}
        columns={mergedColumns}
        dataSource={data}
        loading={loading}
        locale={{ ...tableProps?.locale, emptyText: loading ? "正在读取…" : loadError ? "本次数据未能读取，请重试" : tableProps?.locale?.emptyText ?? "暂无符合条件的记录" }}
        pagination={valid ? listState ? listState.paginationProps({ total }) : {
          current: effectivePage,
          pageSize,
          total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        } : false}
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
