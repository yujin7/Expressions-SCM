/**
 * 架构护栏：落盘路径必须经 core/storage，禁止硬编码 process.cwd()/uploads。
 *
 * 事故背景（2026-07-25 审计）：三处落盘各自写 `process.cwd()/uploads`，
 * 而 compose 设的是 `FILE_STORAGE_DIR: /data/uploads` 且挂了同名卷。
 * 容器里代码写 /app/uploads（可写层），挂载卷永远空——
 * `ops/deploy.sh` 每次重建容器抹掉全部附件与导入原件，
 * `ops/backup.sh` 备份的是那个空卷。**静默全量数据丢失，不报错不 500。**
 *
 * 这类缺陷必须由测试守：它在开发机上表现完全正常（dev 的 cwd 就是仓库根），
 * 只有在容器里、且只有在需要调档时才会暴露，那时数据已经没了。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../src");
/** 唯一允许出现该模式的地方：storage 模块自己的缺省回退 */
const ALLOW = [path.join("server", "core", "storage.ts")];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("架构护栏：落盘根目录", () => {
  it("除 core/storage 外，禁止硬编码 process.cwd() 拼落盘目录", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file);
      if (ALLOW.some((a) => rel === a)) continue;
      const src = readFileSync(file, "utf8");
      // 命中形如 path.join(process.cwd(), "uploads" | "attachments" | "exports" ...)
      for (const m of src.matchAll(/process\.cwd\(\)\s*,\s*["'](uploads|attachments|exports|files)["']/g)) {
        offenders.push(`${rel} → process.cwd(), "${m[1]}"`);
      }
    }
    expect(
      offenders,
      `以下文件硬编码了落盘目录，容器内会写进可写层而非挂载卷（部署即丢数据）：\n` +
        offenders.join("\n") +
        `\n改用 storageDir(...) —— src/server/core/storage.ts`,
    ).toEqual([]);
  });

  it("storageRoot 尊重 FILE_STORAGE_DIR（绝对路径与相对路径都要对）", async () => {
    const { storageRoot, storageDir } = await import("@/server/core/storage");
    const prev = process.env.FILE_STORAGE_DIR;
    try {
      process.env.FILE_STORAGE_DIR = "/data/uploads";
      expect(storageRoot()).toBe("/data/uploads");
      expect(storageDir("exports")).toBe("/data/uploads/exports");

      process.env.FILE_STORAGE_DIR = "./uploads";
      expect(path.isAbsolute(storageRoot())).toBe(true);

      delete process.env.FILE_STORAGE_DIR;
      expect(storageRoot()).toBe(path.join(process.cwd(), "uploads"));
    } finally {
      if (prev === undefined) delete process.env.FILE_STORAGE_DIR;
      else process.env.FILE_STORAGE_DIR = prev;
    }
  });
});
