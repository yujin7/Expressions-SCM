/**
 * 由业务实体推导的确定性幂等键（2026-09-04 安全审计 S5）。
 *
 * 事故形态：几处服务端调用把 `randomUUID()` 当幂等键传给下游
 * （`quality/case-quarantine` → `createQualityAction`、`quality/qc-outcome` → `createQualityCase`）。
 * 那些下游helper 各自实现了「advisory lock + 按幂等键查重放」的防重机制——
 * 而每次调用都换一个新键，等于**每次都告诉它「这是一次全新的请求」**：
 * 防重逻辑仍在跑，只是永远命中不了。重复点一次「隔离」就多出 N 条质量行动
 * （每个批次×仓库一条，各自带责任人和截止日，喂给逾期看门狗）；
 * 并发两次「登记不合格后果」就开出两个 QI 案件、吃掉两个单号、在供应商记分卡里双计。
 *
 * 幂等键必须**由这次操作涉及的实体推导**，而不是由调用时刻推导：
 * 同样的实体组合 = 同一次操作，无论点几次。
 *
 * 形状：RFC 4122 v5（name-based）UUID——下游 schema 一律 `z.string().uuid()`，
 * 用裸 sha256 十六进制串会在校验层就被拒。命名空间前缀写死在本文件，
 * 不同业务用不同的 `parts`，天然互不碰撞。
 */
import { createHash } from "node:crypto";

/** 命名空间：换它等于让全系统的确定性幂等键改口径，务必谨慎 */
const NAMESPACE = "supply-chain/idempotency/v1";

/** 分隔符用 US（Unit Separator）：业务字段里不可能出现，避免 ("a","bc") 与 ("ab","c") 撞键 */
const SEP = "";

/**
 * 由若干业务标识推导一个稳定的 UUID 形状幂等键。
 *
 * 用法约定：`parts[0]` 是操作名（人读得懂的常量），其后是决定「这是同一次操作」的实体主键。
 * **不要**把会随时间/库存漂移的量（现货数、今天的日期）放进 parts——
 * 那正好会让「同一次操作」在第二天变成另一次操作，防重又失效。
 */
export function deterministicIdempotencyKey(...parts: (string | number)[]): string {
  const hex = createHash("sha256")
    .update([NAMESPACE, ...parts.map(String)].join(SEP), "utf8")
    .digest("hex");
  const bytes = Buffer.from(hex.slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const s = bytes.toString("hex");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
