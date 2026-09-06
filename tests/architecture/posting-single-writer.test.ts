/**
 * 常见库存写路径的静态回归门，不是运行时权限或任意程序的数据流证明。
 * AST + 本文件内符号解析覆盖多行、import/局部别名、namespace、SQL 字面量；
 * 注释、同名局部参数、只读 SQL 不算写入。跨文件转发、动态计算 SQL 等仍须审阅、
 * posting 行为测试和数据库约束共同保证，不能把静态绿灯当成绝对安全。
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import ts from "typescript";
import { isRegisteredSource } from "@/server/posting/registry";

const POSTING_DIR = resolve("src/server/posting");
const TABLES = { stockLedger: "stock_ledger", stockBalances: "stock_balances" } as const;
type Table = typeof TABLES[keyof typeof TABLES];
type Binding = Table | "schema" | "db" | "sql";
interface WriteHit { table: Table; line: number; kind: string }

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

/** Bind local symbols without loading node_modules or doing a project typecheck. */
function scanner(files: Map<string, string>) {
  const sources = new Map([...files].map(([file, body]) => [resolve(file), ts.createSourceFile(
    resolve(file), body, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )]));
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (file) => sources.get(resolve(file));
  const checker = ts.createProgram([...sources.keys()], options, host).getTypeChecker();

  function importKind(node: ts.Node, name?: string): Binding | undefined {
    let p: ts.Node | undefined = node;
    while (p && !ts.isImportDeclaration(p)) p = p.parent;
    if (!p || !ts.isImportDeclaration(p) || !ts.isStringLiteral(p.moduleSpecifier)) return;
    const spec = p.moduleSpecifier.text;
    if (spec === "drizzle-orm" && name === "sql") return "sql";
    const modulePath = spec.startsWith("@/") ? resolve("src", spec.slice(2)) : resolve(dirname(p.getSourceFile().fileName), spec);
    const schemaPath = resolve("src/db/schema");
    if (modulePath === schemaPath || modulePath.startsWith(`${schemaPath}${sep}`)) {
      return name == null ? "schema" : TABLES[name as keyof typeof TABLES];
    }
    if (modulePath === resolve("src/db")) return name === "schema" ? "schema" : name == null ? "db" : undefined;
  }

  function member(base: Binding | undefined, name: string): Binding | undefined {
    if (base === "schema") return TABLES[name as keyof typeof TABLES];
    if (base === "db" && name === "schema") return "schema";
  }

  function binding(node: ts.Expression, seen = new Set<ts.Symbol>()): Binding | undefined {
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return binding(node.expression, seen);
    if (ts.isPropertyAccessExpression(node)) return member(binding(node.expression, seen), node.name.text);
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) return member(binding(node.expression, seen), node.argumentExpression.text);
    if (!ts.isIdentifier(node)) return;
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol || seen.has(symbol)) return;
    seen.add(symbol);
    for (const decl of symbol.declarations ?? []) {
      if (ts.isImportSpecifier(decl) && !decl.isTypeOnly && !decl.parent.parent.isTypeOnly) return importKind(decl, (decl.propertyName ?? decl.name).text);
      if (ts.isNamespaceImport(decl) && !decl.parent.isTypeOnly) return importKind(decl);
      if (ts.isVariableDeclaration(decl) && decl.initializer) return binding(decl.initializer, seen);
      if (ts.isBindingElement(decl) && ts.isObjectBindingPattern(decl.parent)) {
        const parent = decl.parent.parent;
        const key = decl.propertyName ?? decl.name;
        if (ts.isVariableDeclaration(parent) && parent.initializer && ts.isIdentifier(key)) return member(binding(parent.initializer, seen), key.text);
      }
    }
  }

  function sqlText(node: ts.Expression, seen = new Set<ts.Symbol>()): string {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return sqlText(node.expression, seen);
    if (ts.isTaggedTemplateExpression(node) && binding(node.tag) === "sql") return sqlText(node.template, seen);
    if (ts.isTemplateExpression(node)) {
      return node.head.text + node.templateSpans.map((span) => {
        const table = binding(span.expression);
        const fragment = table === "stock_ledger" || table === "stock_balances" ? table
          : ts.isTaggedTemplateExpression(span.expression) || ts.isCallExpression(span.expression)
            ? sqlText(span.expression, new Set(seen)) : " ? ";
        return fragment + span.literal.text;
      }).join("");
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return sqlText(node.left, new Set(seen)) + sqlText(node.right, new Set(seen));
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && binding(node.expression.expression) === "sql" && node.arguments[0]) {
      if (node.expression.name.text === "raw") return sqlText(node.arguments[0], seen);
      if (node.expression.name.text === "identifier" && ts.isStringLiteral(node.arguments[0])) return `"${node.arguments[0].text.replaceAll('"', '""')}"`;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol || seen.has(symbol)) return " ? ";
      seen.add(symbol);
      for (const decl of symbol.declarations ?? []) if (ts.isVariableDeclaration(decl) && decl.initializer) return sqlText(decl.initializer, seen);
    }
    return " ? ";
  }

  return (file: string): WriteHit[] => {
    const source = sources.get(resolve(file));
    if (!source) throw new Error(`Missing source: ${file}`);
    const hits = new Map<string, WriteHit>();
    const record = (node: ts.Node, table: Table, kind: string) => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      hits.set(`${line}:${table}`, { table, line, kind });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const method = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
          : ts.isElementAccessExpression(node.expression) && ts.isStringLiteral(node.expression.argumentExpression) ? node.expression.argumentExpression.text : undefined;
        if (method && ["insert", "update", "delete"].includes(method) && node.arguments[0]) {
          const table = binding(node.arguments[0]);
          if (table === "stock_ledger" || table === "stock_balances") record(node, table, method);
        }
        if (method && ["execute", "query", "$executeRaw", "$executeRawUnsafe", "raw"].includes(method)) {
          for (const arg of node.arguments) for (const table of sqlWrites(sqlText(arg))) record(node, table, "sql");
        }
      }
      if (ts.isTaggedTemplateExpression(node) && binding(node.tag) === "sql") for (const table of sqlWrites(sqlText(node.template))) record(node, table, "sql");
      ts.forEachChild(node, visit);
    };
    visit(source);
    return [...hits.values()];
  };
}

/** Small SQL lexer: discard comments/value strings; preserve quoted/schema-qualified identifiers. */
function sqlWrites(sql: string): Table[] {
  const tokens = [...sql.matchAll(/--[^\n]*|\/\*[\s\S]*?\*\/|\$(\w*)\$[\s\S]*?\$\1\$|'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_]\w*|[.,;]/g)]
    .filter(([token]) => !token.startsWith("--") && !token.startsWith("/*") && !token.startsWith("'") && !token.startsWith("$"))
    .map(([token]) => token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"') : token.toLowerCase());
  const writes = new Set<Table>();
  for (let i = 0; i < tokens.length; i++) {
    let target = i + 1;
    if ((tokens[i] === "insert" || tokens[i] === "merge") && tokens[target] === "into") target++;
    else if (tokens[i] === "delete" && tokens[target] === "from") target++;
    else if (tokens[i] === "truncate") { if (tokens[target] === "table") target++; }
    else if (tokens[i] !== "update") continue;
    if (tokens[target] === "only") target++;
    do {
      if (tokens[target + 1] === ".") target += 2;
      const table = tokens[target];
      if (table === "stock_ledger" || table === "stock_balances") writes.add(table);
      target++;
      if (tokens[i] !== "truncate" || tokens[target] !== ",") break;
      target++;
    } while (target < tokens.length);
  }
  return [...writes];
}

describe("库存过账写路径静态回归", () => {
  const files = new Map(walk("src").map((file) => [file, readFileSync(file, "utf8")]));
  const detect = scanner(files);
  it("已识别的库存写语句只允许出现在 src/server/posting/ 下", () => {
    const offenders = [...files.keys()].filter((file) => !resolve(file).startsWith(`${POSTING_DIR}${sep}`)).flatMap((file) => detect(file).map((hit) => `${file}:${hit.line} ${hit.kind} ${hit.table}`));
    expect(offenders, `新的库存动作请在 posting/registry.ts 注册来源：\n${offenders.join("\n")}`).toEqual([]);
  });
  it("同一检测器确实识别过账层对两张表的插入", () => {
    const hits = [...files.keys()].filter((file) => resolve(file).startsWith(`${POSTING_DIR}${sep}`)).flatMap(detect);
    expect(hits.some((hit) => hit.table === "stock_ledger" && hit.kind === "insert")).toBe(true);
    expect(hits.some((hit) => hit.table === "stock_balances" && hit.kind === "insert")).toBe(true);
  });
  it("registry 准入函数实际拒绝未知来源/动作（post 的事务行为由 posting 套件覆盖）", () => {
    expect(isRegisteredSource("sh_purchase_in", "post")).toBe(true);
    expect(isRegisteredSource("unregistered_source", "post")).toBe(false);
    expect(isRegisteredSource("sh_purchase_in", "writeoff")).toBe(false);
  });
});

const WRITE_FIXTURES = [
  'import { stockLedger as ledger } from "@/db/schema"; db.insert(\n ledger\n).values([]);',
  'import * as tables from "@/db/schema"; db.update(tables.stockBalances);',
  'import { schema as tables } from "@/db"; db.delete(tables["stockLedger"]);',
  'import * as database from "@/db"; db.insert(database.schema.stockBalances);',
  'import { stockLedger } from "../db/schema"; const alias = stockLedger; db["insert"](alias);',
  'import * as schema from "@/db/schema"; const { stockBalances: balances } = schema; db.update(balances);',
  'import { sql as query } from "drizzle-orm"; db.execute(query`INSERT /* reason */ INTO "public"."stock_ledger" VALUES (1)`);',
  'import { sql } from "drizzle-orm"; import { stockBalances as balances } from "@/db/schema"; db.execute(sql`update ${balances} set qty = 0`);',
  'const text = "DELETE FROM " + "stock_ledger WHERE id = $1"; client.query(text, [1]);',
  'import { sql } from "drizzle-orm"; db.execute(sql.raw("WITH old AS (DELETE FROM stock_balances RETURNING *) SELECT * FROM old"));',
  'db.query("TRUNCATE TABLE public.stock_balances, stock_ledger");',
  'import { sql } from "drizzle-orm"; db.execute(sql`INSERT INTO ${sql.identifier("stock_ledger")} VALUES (1)`);',
];
const READ_FIXTURES = [
  '// db.insert(stockLedger);\n/* INSERT INTO stock_ledger */ const note = "DELETE FROM stock_ledger";',
  'import { stockLedger } from "@/db/schema"; db.select().from(stockLedger);',
  'import { stockLedger } from "@/db/schema"; function unrelated(stockLedger: unknown) { db.insert(stockLedger); }',
  'import { stockLedger } from "other-package"; db.insert(stockLedger);',
  'import { sql } from "drizzle-orm"; db.execute(sql`SELECT * FROM stock_balances FOR UPDATE`);',
  'import { sql } from "drizzle-orm"; db.execute(sql`SELECT \'DELETE FROM stock_ledger\', $$UPDATE stock_balances$$ /* INSERT INTO stock_ledger */`);',
  'db.query("SELECT * FROM stock_ledger -- DELETE FROM stock_balances\\n");',
  'import { sql } from "drizzle-orm"; db.execute(sql`UPDATE other_table SET note = \'stock_ledger\'`);',
];
describe("检测器自身的正反例（内存源码，不改仓库）", () => {
  it.each(WRITE_FIXTURES)("识别写入 %#", (source) => {
    const file = "src/fixtures/example.ts";
    expect(scanner(new Map([[file, source]]))(file).length).toBeGreaterThan(0);
  });
  it.each(READ_FIXTURES)("不把注释/只读/不同绑定算成写入 %#", (source) => {
    const file = "src/fixtures/example.ts";
    expect(scanner(new Map([[file, source]]))(file)).toEqual([]);
  });
});
