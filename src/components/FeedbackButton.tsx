"use client";

/** 页脚反馈（UAT 管道）：一键把当前页+描述录入复核清单（uat_feedback） */
import { useState } from "react";
import { App, Button, Input, Modal } from "antd";
import { CommentOutlined } from "@ant-design/icons";
import { usePathname } from "next/navigation";
import { postJson } from "@/components/fetchJson";

export default function FeedbackButton() {
  const { message } = App.useApp();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (content.trim().length < 2) {
      message.warning("请先描述问题或建议");
      return;
    }
    setSaving(true);
    try {
      await postJson("/api/review/feedback", { page: pathname, content: content.trim() });
      message.success("已提交——可在「在案复核清单」跟踪处理");
      setOpen(false);
      setContent("");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button size="small" icon={<CommentOutlined />} onClick={() => setOpen(true)}>
        反馈
      </Button>
      <Modal title={`提交反馈（${pathname}）`} open={open} onOk={() => void submit()} confirmLoading={saving} onCancel={() => setOpen(false)} okText="提交" cancelText="取消">
        <Input.TextArea rows={4} maxLength={1000} value={content} onChange={(e) => setContent(e.target.value)} placeholder="哪里不顺手？期望怎样？（自动附带当前页面路径）" />
      </Modal>
    </>
  );
}
