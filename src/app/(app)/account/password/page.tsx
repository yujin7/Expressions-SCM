import PasswordClient from "./password-client";

export const metadata = { title: "修改密码" };

/** 登录校验由 (app)/layout.tsx 统一完成；本页任何登录用户可用 */
export default function Page() {
  return <PasswordClient />;
}
