"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Empty, Image, Popconfirm, Spin, Typography, Upload } from "antd";
import { DeleteOutlined, FilePdfOutlined, InboxOutlined } from "@ant-design/icons";
import { fetchJson } from "@/components/fetchJson";

/** 附件 DTO（GET /api/attachments 返回） */
interface AttachmentItem {
  id: number;
  filename: string;
  mime: string;
  uploadedByName: string | null;
  createdAt: string;
  url: string;
}

export interface AttachmentPanelProps {
  /** 业务实体：sku | supplier | qc | sh */
  entity: "sku" | "supplier" | "qc" | "sh";
  entityId: number;
  canWrite: boolean;
  /** 面板标题（默认「附件」） */
  title?: string;
  /** 列表为空且不可写时整体隐藏（用于 QC 提交后的 sh 兜底面板） */
  hideWhenEmpty?: boolean;
}

const IMAGE_ACCEPT = ".jpg,.jpeg,.png,.webp";

/**
 * 共享附件面板（F-011 多图上传）：拖拽/点击上传 → POST /api/attachments；
 * 图片走 Image.PreviewGroup 预览，pdf 新窗口打开；canWrite 时逐项可删。
 * supplier 额外允许 pdf（证照/检测报告 ≤20MB），其余实体仅图片 ≤10MB。
 */
export default function AttachmentPanel({
  entity,
  entityId,
  canWrite,
  title = "附件",
  hideWhenEmpty = false,
}: AttachmentPanelProps) {
  const { message } = App.useApp();
  const [items, setItems] = useState<AttachmentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const allowPdf = entity === "supplier";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await fetchJson<AttachmentItem[]>(`/api/attachments?entity=${entity}&entityId=${entityId}`));
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [entity, entityId, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("entity", entity);
      form.append("entityId", String(entityId));
      form.append("file", file);
      const res = await fetch("/api/attachments", { method: "POST", body: form });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string })?.error ?? `上传失败（${res.status}）`);
      message.success(`已上传：${file.name}`);
      await load();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const remove = async (id: number) => {
    try {
      const res = await fetch(`/api/attachments/${id}`, { method: "DELETE" });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((body as { error?: string })?.error ?? `删除失败（${res.status}）`);
      message.success("附件已删除");
      await load();
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  if (hideWhenEmpty && !canWrite && !loading && items.length === 0) return null;

  const images = items.filter((i) => i.mime.startsWith("image/"));
  const others = items.filter((i) => !i.mime.startsWith("image/"));

  return (
    <div style={{ marginBottom: 16 }}>
      <Typography.Title level={5}>{title}</Typography.Title>
      {canWrite ? (
        <Upload.Dragger
          multiple
          accept={allowPdf ? `${IMAGE_ACCEPT},.pdf` : IMAGE_ACCEPT}
          showUploadList={false}
          disabled={uploading}
          customRequest={({ file }) => void upload(file as File)}
          style={{ marginBottom: 12 }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽文件到此处上传（可多选）</p>
          <p className="ant-upload-hint">
            {allowPdf ? "支持 jpg/png/webp 图片（≤10MB）与 PDF（≤20MB）" : "支持 jpg/png/webp 图片（≤10MB）"}
          </p>
        </Upload.Dragger>
      ) : null}
      <Spin spinning={loading}>
        {items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无附件" />
        ) : (
          <>
            {images.length > 0 ? (
              <Image.PreviewGroup>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: others.length ? 8 : 0 }}>
                  {images.map((it) => (
                    <div key={it.id} style={{ width: 104, textAlign: "center" }}>
                      <Image
                        src={it.url}
                        alt={it.filename}
                        width={104}
                        height={104}
                        style={{ objectFit: "cover", borderRadius: 6, border: "1px solid #d9d9d9" }}
                      />
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
                        <Typography.Text
                          ellipsis={{ tooltip: `${it.filename}｜${it.uploadedByName ?? "—"}` }}
                          style={{ fontSize: 12, maxWidth: canWrite ? 76 : 100 }}
                        >
                          {it.filename}
                        </Typography.Text>
                        {canWrite ? (
                          <Popconfirm title="删除该附件？" okText="删除" cancelText="取消" onConfirm={() => void remove(it.id)}>
                            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                          </Popconfirm>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </Image.PreviewGroup>
            ) : null}
            {others.map((it) => (
              <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <FilePdfOutlined style={{ color: "#cf1322" }} />
                <Typography.Link href={it.url} target="_blank" rel="noreferrer">
                  {it.filename}
                </Typography.Link>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {it.uploadedByName ?? "—"}
                </Typography.Text>
                {canWrite ? (
                  <Popconfirm title="删除该附件？" okText="删除" cancelText="取消" onConfirm={() => void remove(it.id)}>
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                ) : null}
              </div>
            ))}
          </>
        )}
      </Spin>
    </div>
  );
}
