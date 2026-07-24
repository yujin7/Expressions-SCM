import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    /* PGlite 每个测试文件起一个实例；套件已达 100 文件，18 核并行时
       createTestDb() 会在默认 10s hook 超时内被饿死（随机 FAIL，单跑却全过）。
       与 testTimeout 对齐到 30s——不是放宽断言，只是给实例创建足够的排队时间。 */
    hookTimeout: 30000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
