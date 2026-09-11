import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Most files create an isolated PGlite instance. Unbounded core-count
    // parallelism causes memory pressure and closed worker channels in CI.
    maxWorkers: 4,
    testTimeout: 30000,
    /* PGlite 每个测试文件起一个实例；无界核数并行时
       createTestDb() 会在默认 10s hook 超时内被饿死（随机 FAIL，单跑却全过）。
       与 testTimeout 对齐到 30s——不是放宽断言，只是给实例创建足够的排队时间。 */
    hookTimeout: 30000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
