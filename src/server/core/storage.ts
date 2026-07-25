/**
 * 文件落盘根目录的唯一权威。
 *
 * 事故背景（本仓真实缺陷，2026-07-25 审计确认）：
 * 三处落盘各自硬编码 `process.cwd()/uploads`——
 *   src/app/api/import/upload/route.ts（导入原件）
 *   src/server/modules/attachment/service.ts（单据附件）
 *   src/jobs/export-worker.ts（异步导出产物）
 * 而 docker-compose.prod.yml:29 设的是 `FILE_STORAGE_DIR: /data/uploads`、挂载卷是
 * `uploads:/data/uploads`，`FILE_STORAGE_DIR` 在 src/ 里**零读取方**。
 * 结果：容器内实际写的是 /app/uploads（可写层），挂载卷永远是空的——
 * `ops/deploy.sh` 每次重建容器就把全部附件与导入原件抹掉，
 * 而 `ops/backup.sh` 备份的是那个空卷，**备份里一个附件都没有**。
 * 这是静默的全量数据丢失：不报错、不 500，只有需要调档时才发现东西没了。
 *
 * 纪律：任何要落盘的代码**必须**经本模块取根目录，禁止再写 `process.cwd()`。
 * 护栏：tests/architecture/storage-root.test.ts 扫描 src/ 拦截新增的硬编码。
 */
import path from "node:path";

/**
 * 落盘根目录。
 * - 生产：由 `FILE_STORAGE_DIR` 指定（compose 已设为挂载卷 /data/uploads）
 * - 本地开发：缺省 `<repo>/uploads`，与历史行为一致，无需改开发流程
 * 相对路径按 process.cwd() 解析，便于 .env 里写 `./uploads`。
 */
export function storageRoot(): string {
  const cfg = process.env.FILE_STORAGE_DIR?.trim();
  if (!cfg) return path.join(process.cwd(), "uploads");
  return path.isAbsolute(cfg) ? cfg : path.resolve(process.cwd(), cfg);
}

/** 子目录（导入原件 / 附件 / 导出产物三类共用一个根，便于单卷挂载与单脚本备份） */
export function storageDir(...segments: string[]): string {
  return path.join(storageRoot(), ...segments);
}
