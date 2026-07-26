# 安全备忘（登录与会话）

## 登录限速（已实现，v1.0）
- 位置: `src/server/auth/config.ts`（authorize 回调内，内存滑动窗口）。
- 口径:
  - 每 IP（`x-forwarded-for` 首跳）**全部**登录尝试 20 次 / 5 分钟；
  - 每用户名**失败**尝试 10 次 / 5 分钟（成功登录即清零）——IP 不可得（直连/无反代头）时的兜底；
  - 超限抛 `rate_limited`，服务端消息「尝试过于频繁，请稍后再试」；
  - 既有 DB 级账号锁（连续失败 5 次锁 15 分钟，`lockedUntil`）保持不变，两层叠加。
- 限制:
  - 内存 Map，单实例口径；多实例部署（1.1 若水平扩容）须移 Redis/DB 计数；
  - 进程重启窗口清零（可接受——DB 级 lockedUntil 仍在）；
  - `x-forwarded-for` 首跳可被直连客户端伪造——生产必须经反代（Nginx/Caddy 覆写该头）才有 IP 维度意义；
  - 前端 `src/app/login/login-form.tsx` 已映射 `rate_limited` 为明确中文提示。

## 身份变化后的会话失效（已实现，迁移 0021）
- `users.session_version int not null default 0` 是唯一身份版本。
- 登录时把版本写入加密 JWT；服务端 `auth()` 每次刷新时回查用户，版本不一致、停用或删除均返回空会话。
- `getFreshSessionUser` 再次比对版本，确保任何业务写路径不接受陈旧 token。
- 管理员重置密码、停用/启用、修改角色/审批权，以及用户自助改密，均在业务更新与审计同一事务内 `+1`。
- 仅改姓名、登录失败计数或解除锁定不递增，避免无关更新误伤会话。
- 自助改密成功后立即登出并要求用新密码重登。
- 迁移上线时，没有 `sessionVersion` 的旧 token 会一次性失效；这是预期安全切换，不是故障。
- Edge middleware 仍只验证 token 签名/存在性，避免把数据库驱动带进 Edge；RSC、鉴权 API 与 fresh 写守卫
  执行版本校验。若未来出现真正的纯 Edge 敏感读接口，必须改走 Node 鉴权或数据库会话。
