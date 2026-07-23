import { feishuEnabled } from "@/server/auth/config";
import LoginForm from "./login-form";

/** 登录页（服务器组件：读取环境变量决定飞书按钮可用性） */
export default function LoginPage() {
  return <LoginForm feishuEnabled={feishuEnabled} />;
}
