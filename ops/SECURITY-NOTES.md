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
  - 前端 `src/app/login/login-form.tsx` 的 `ERROR_MESSAGES` 尚无 `rate_limited` 映射（该文件归 UI 侧），
    未加映射前用户看到兜底文案「登录失败，请重试」；建议补一行:
    `rate_limited: "尝试过于频繁，请稍后再试"`。

## 密码重置后的会话失效（v1.0 未实现——本轮裁决）
- 现状: 会话为 JWT 策略（`session: { strategy: "jwt", maxAge: 8h, updateAge: 1h }`），
  token 内含 userId/roles/isApprover。管理员重置密码**不会**使已签发的 JWT 失效——
  旧会话最长仍可用 8 小时。
- 为何不做: users 表无 tokenVersion/sessionVersion 列；`updatedAt` 在**任何**更新
  （角色调整、失败计数清零等）都会变化，用它作会话戳会把无关更新误伤为全员踢线。
  schema 本轮冻结，不新增列。
- 既有缓解:
  - `mustChangePassword`: 管理员重置密码即置位，且由 `/api/me` **回查 DB**（不信 token），
    前端据此强制改密——旧会话进入页面即被引导改密流程；
  - 写路径守卫 `getFreshSessionUser` 回查 DB：账号停用（`active=false`）即时生效，
    重置密码同时停用/再启用可立即踢掉写能力；
  - JWT `maxAge` 8h 上限，风险窗口有界。
- 风险陈述: 攻击者若已持有被盗会话，密码重置后其**读**能力可延续 ≤8h
  （写路径受 fresh 回查与 mustChangePassword 牵制）。
- 1.1 计划: users 增 `tokenVersion int not null default 0`；改密/重置/停用时 +1；
  jwt 回调把 tokenVersion 写入 token，session 回调（或中间件）比对 DB 当前值，
  不一致即判 401 强制重登。届时可顺带把「会话策略换 DB 会话」的规格偏差一并收口。
