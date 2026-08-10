/**
 * 「包体过期」错误识别（零依赖纯函数，客户端与测试共用）。
 *
 * 服务端重新构建后 BUILD_ID 变化，旧 chunk 从磁盘消失；用户标签页仍持有旧引用，
 * 客户端跳转时取不到脚本 → 抛 ChunkLoadError / 动态 import 失败，整页落进错误边界。
 * 这类错误与业务逻辑无关，重新加载即恢复，因此要与真正的渲染错误区分开：
 * 前者自动重载，后者必须把错误原文亮出来给人看。
 *
 * 各引擎文案不同，故按已知文案集合匹配：
 * - webpack/Next：`ChunkLoadError`、`Loading chunk 123 failed`
 * - Vite/浏览器原生 ESM：`Failed to fetch dynamically imported module`
 * - Safari：`Importing a module script failed`
 * - Firefox：`error loading dynamically imported module`
 */
const STALE_BUNDLE_RE =
  /ChunkLoadError|Loading chunk \d+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i;

export function isStaleBundleError(error: { name?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return STALE_BUNDLE_RE.test(`${error.name ?? ""} ${error.message ?? ""}`);
}
