import { feishuEnabled } from "@/server/auth/config";
import LoginForm from "./login-form";

// 登录页取运行时 OAuth 可用性且绝不能被 CDN/浏览器共享缓存。
export const dynamic = "force-dynamic";

/** 登录页（服务器组件：读取环境变量决定飞书按钮可用性） */
export default function LoginPage() {
  return <LoginForm feishuEnabled={feishuEnabled} />;
}
