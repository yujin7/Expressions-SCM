import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Ant Design 5 / React 19 compatibility", () => {
  it("根布局安装 createRoot 兼容渲染器", () => {
    const root = resolve(process.cwd());
    const layout = readFileSync(resolve(root, "src/app/layout.tsx"), "utf8");
    const compat = readFileSync(resolve(root, "src/components/AntdReact19Compat.tsx"), "utf8");

    expect(layout).toContain("<AntdReact19Compat />");
    expect(compat).toContain("unstableSetRender");
    expect(compat).toContain("createRoot(container)");
  });
});
