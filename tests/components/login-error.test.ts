import { expect, it } from "vitest";
import { loginErrorMessage } from "@/lib/login-error";

it("distinguishes CSRF transport rejection from a bad password", () => {
  expect(loginErrorMessage({ error: "MissingCSRF" })).toContain("不能说明密码不正确");
  expect(loginErrorMessage({ error: "MissingCSRF" })).toContain("HTTPS");
});
it("credential failures work with or without the provider code and do not identify an existing user", () => {
  const msg = loginErrorMessage({ error: "CredentialsSignin" });
  expect(loginErrorMessage({ code: "invalid" })).toBe(msg);
  expect(loginErrorMessage({ code: "disabled" })).toBe(msg);
  expect(msg).toContain("最新密码");
});
it("rate limits tell users not to keep submitting", () => {
  expect(loginErrorMessage({ code: "rate_limited", error: "CredentialsSignin" })).toContain("不要连续点击");
});
it.each([undefined, null, {}, { error: "<script>secret</script>", code: "token" }])("unknown responses are not reflected %j", value => {
  const msg = loginErrorMessage(value); expect(msg).toContain("未能确认"); expect(msg).not.toContain("secret"); expect(msg).not.toContain("token");
});
