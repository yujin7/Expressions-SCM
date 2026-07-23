import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";

/** 中文退出确认页（W5 修正：改普通 POST 表单——server-action 版在部分环境不触发） */
export default async function SignOutPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const jar = await cookies();
  const raw =
    jar.get("authjs.csrf-token")?.value ?? jar.get("__Host-authjs.csrf-token")?.value ?? "";
  const csrfToken = raw.split("|")[0] ?? "";
  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: 120 }}>
      <form
        method="post"
        action="/api/auth/signout"
        style={{ background: "#fff", padding: 32, borderRadius: 8, textAlign: "center", boxShadow: "0 2px 8px rgba(0,0,0,.08)" }}
      >
        <input type="hidden" name="csrfToken" value={csrfToken} />
        <input type="hidden" name="callbackUrl" value="/login" />
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
