import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

type LockPackage = {
  version?: string;
};

type PackageLock = {
  packages?: Record<string, LockPackage>;
};

describe("Ant Design style runtime contract", () => {
  it("keeps the registry and Ant Design on one css-in-js runtime", () => {
    const root = process.cwd();
    const packageJson = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const lock = JSON.parse(
      readFileSync(path.join(root, "package-lock.json"), "utf8"),
    ) as PackageLock;

    const declared = packageJson.dependencies?.["@ant-design/cssinjs"];
    const rootRuntime = lock.packages?.["node_modules/@ant-design/cssinjs"]?.version;
    const nestedRuntimes = Object.entries(lock.packages ?? {})
      .filter(([name]) => name.endsWith("/node_modules/@ant-design/cssinjs"))
      .map(([, value]) => value.version)
      .filter(Boolean);

    expect(declared).toBe("1.24.0");
    expect(rootRuntime).toBe(declared);
    expect(nestedRuntimes).toEqual([]);
  });
});
