/** Allowlisted, actionable messages only; never echo a returned URL or server diagnostic. */
export function loginErrorMessage(result?: { code?: string; error?: string } | null): string {
  if (result?.code === "rate_limited") return "尝试过于频繁，请稍后再试；不要连续点击登录。";
  if (["invalid", "disabled"].includes(result?.code ?? "") || result?.error === "CredentialsSignin") {
    return "用户名或密码不正确，或账号暂不可用。请手动输入最新密码；重置前的密码不能再使用。";
  }
  if (result?.error === "MissingCSRF") return "登录校验未通过。请刷新页面；若仍失败，请使用管理员提供的 HTTPS 入口，并允许该站点使用 Cookie。此错误不能说明密码不正确。";
  return "未能确认登录结果。请检查网络后重试；若持续失败，请将当前入口和时间提供给管理员，不必反复重置密码。";
}
