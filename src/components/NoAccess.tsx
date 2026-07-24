/**
 * 页面级角色门（RT4 UX-P0：杜绝"点了才 403"）——服务端判定后渲染，无闪烁。
 * 纯静态标记，不引 antd（服务端组件直接可用）。
 */
export default function NoAccess({ need }: { need: string }) {
  return (
    <div
      style={{
        margin: "48px auto",
        maxWidth: 520,
        padding: "24px 32px",
        border: "1px solid #ffe58f",
        background: "#fffbe6",
        borderRadius: 8,
        color: "rgba(0,0,0,0.88)",
        fontSize: 14,
        lineHeight: 1.8,
      }}
    >
      <strong>本页需要{need}权限</strong>
      <div style={{ color: "rgba(0,0,0,0.55)" }}>
        当前账号无权访问此功能。如需开通，请联系系统管理员在「系统管理 → 用户管理」调整角色。
      </div>
    </div>
  );
}
