import { redirect } from "next/navigation";
import { auth, signOut } from "@/server/auth";

/** 中文退出确认页（UX 走查 Top-9：替换 NextAuth 默认英文页） */
export default async function SignOutPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: 120 }}>
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
        style={{ background: "#fff", padding: 32, borderRadius: 8, textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,.08)" }}
      >
        <p style={{ fontSize: 16, marginBottom: 24 }}>确定要退出登录吗？</p>
        <button
          type="submit"
          style={{ background: "#1677ff", color: "#fff", border: 0, borderRadius: 6, padding: "8px 32px", fontSize: 14, cursor: "pointer" }}
        >
          退出登录
        </button>
      </form>
    </div>
  );
}
