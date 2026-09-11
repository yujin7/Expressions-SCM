/** Delivery is not reading, and neither is completion of the source business task. */
export function notificationDelivery(channel: string, status: string): { label: string; color: string } {
  if (channel === "in_app") {
    return status === "failed" || status === "skipped"
      ? { label: `站内可读 · ${status === "failed" ? "登记失败" : "登记跳过"}`, color: "gold" }
      : { label: "站内可读", color: "default" };
  }
  const labels: Record<string, { label: string; color: string }> = {
    pending: { label: "飞书待发送", color: "gold" },
    sending: { label: "飞书发送中（未确认）", color: "processing" },
    sent: { label: "飞书已发送", color: "default" },
    failed: { label: "飞书发送失败或未确认", color: "red" },
    skipped: { label: "飞书已跳过", color: "gold" },
  };
  return channel === "feishu" && labels[status] ? labels[status] : { label: "投递状态待核对", color: "gold" };
}
