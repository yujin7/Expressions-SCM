import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("responsive application header", () => {
  it("uses a compact, accessible account menu only at intermediate desktop widths", () => {
    const shell = read("src/components/AppShell.tsx");

    expect(shell).toContain(
      "const isCompactHeader = screens.lg === true && screens.xl === false",
    );
    expect(shell).toContain("isCompactHeader ? (");
    expect(shell).toContain('aria-label={`打开账户菜单：${userName ?? "未登录"}`}');
    expect(shell).toContain('aria-haspopup="menu"');
    expect(shell).toContain('{ key: "password", label: "修改密码" }');
    expect(shell).toContain('{ key: "signout", label: "退出登录", danger: true }');
    expect(shell).toContain('if (key === "password") router.push("/account/password")');
    expect(shell).toContain('if (key === "signout") router.push("/signout")');
  });

  it("lets global search shrink without losing its accessible name", () => {
    const search = read("src/components/GlobalSearch.tsx");
    const styles = read("src/app/globals.css");

    expect(search).toContain('className="global-search"');
    expect(search).toContain('style={{ width: "100%" }}');
    expect(search).toContain('aria-label="全局搜索：编码、中文、拼音、首字母或单号"');
    expect(styles).toMatch(
      /\.app-header__search\s*\{[^}]*flex:\s*0 1 320px;[^}]*min-width:\s*180px;[^}]*max-width:\s*320px;/s,
    );
    expect(styles).toMatch(/\.global-search\s*\{[^}]*width:\s*100%;/s);
  });

  it("tightens only the 992–1199px header range while preserving mobile rules", () => {
    const styles = read("src/app/globals.css");

    expect(styles).toMatch(
      /@media \(min-width:\s*992px\) and \(max-width:\s*1199px\)\s*\{[\s\S]*?\.app-header__actions\s*\{[^}]*gap:\s*6px;[^}]*margin-left:\s*16px;[^}]*\}[\s\S]*?\.app-header__search\s*\{[^}]*flex-basis:\s*280px;[^}]*min-width:\s*150px;[^}]*max-width:\s*280px;/s,
    );
    expect(styles).toMatch(
      /@media \(max-width:\s*991px\)\s*\{[\s\S]*?\.app-header__actions\s*\{[^}]*flex:\s*0 0 auto;[^}]*gap:\s*6px;[^}]*margin-left:\s*12px;/s,
    );
  });
});
