/**
 * 有界静态回归门：只锁定当前 PATCH 路由、四个公共包装函数和 patchWorkItem 的
 * “基础行 FOR UPDATE → 事务内可见性守卫 → 修改”结构。不是任意动态 SQL、跨文件
 * 反射调用或完整权限正确性的证明；真实权限/原子性仍由 todo 行为与 PostgreSQL 测试负责。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const SERVICE = "src/server/modules/todo/service.ts";
const ROUTE = "src/app/api/todo/[id]/route.ts";

function nodes<T extends ts.Node>(root: ts.Node, isMatch: (node: ts.Node) => node is T): T[] {
  const result: T[] = [];
  const visit = (node: ts.Node) => {
    if (isMatch(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return result;
}

const named = (expression: ts.Node | undefined, name: string) => !!expression && ts.isIdentifier(expression) && expression.text === name;
const callNamed = (call: ts.CallExpression, name: string) => named(call.expression, name);
const method = (call: ts.CallExpression, name: string) => ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === name;
function functionBody(source: ts.SourceFile, name: string): ts.Block | undefined {
  return source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name)?.body;
}

function delegatedReturn(body: ts.Block | undefined, target: string, field: "assigneeId" | "status" | "done" | "cancelled"): boolean {
  if (!body || body.statements.length !== 1) return false;
  const statement = body.statements[0];
  if (!ts.isReturnStatement(statement) || !statement.expression || !ts.isCallExpression(statement.expression)) return false;
  const call = statement.expression;
  if (!callNamed(call, target) || call.arguments.length !== 5
    || !named(call.arguments[0], "id") || !named(call.arguments[2], "actor")
    || !named(call.arguments[3], "dbArg") || !named(call.arguments[4], "opts")) return false;
  const payload = call.arguments[1];
  if (field === "done" || field === "cancelled") return ts.isStringLiteral(payload) && payload.text === field;
  if (!ts.isObjectLiteralExpression(payload)) return false;
  return payload.properties.some((property) => ts.isShorthandPropertyAssignment(property) && property.name.text === field
    || ts.isPropertyAssignment(property) && named(property.name, field) && named(property.initializer, field));
}

function baseRowLock(statement: ts.Statement): boolean {
  if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) return false;
  const declaration = statement.declarationList.declarations[0];
  if (!ts.isArrayBindingPattern(declaration.name) || declaration.name.elements.length !== 1
    || !ts.isBindingElement(declaration.name.elements[0]) || !named(declaration.name.elements[0].name, "existing")
    || !declaration.initializer || !ts.isAwaitExpression(declaration.initializer)) return false;
  let expression = declaration.initializer.expression;
  const chain: ts.CallExpression[] = [];
  while (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    chain.unshift(expression);
    expression = expression.expression.expression;
  }
  if (!named(expression, "tx") || chain.length !== 4
    || !["select", "from", "where", "for"].every((name, index) => method(chain[index], name))) return false;
  const [select, from, where, lock] = chain;
  const predicate = where.arguments[0];
  return select.arguments.length === 0 && from.arguments.length === 1 && named(from.arguments[0], "workItems")
    && lock.arguments.length === 1 && ts.isStringLiteral(lock.arguments[0]) && lock.arguments[0].text === "update"
    && where.arguments.length === 1 && ts.isCallExpression(predicate) && callNamed(predicate, "eq")
    && predicate.arguments.length === 2 && ts.isPropertyAccessExpression(predicate.arguments[0])
    && named(predicate.arguments[0].expression, "workItems") && predicate.arguments[0].name.text === "id"
    && named(predicate.arguments[1], "id");
}

function visibilityGuard(statement: ts.Statement): boolean {
  if (!ts.isIfStatement(statement) || !ts.isPrefixUnaryExpression(statement.expression)
    || statement.expression.operator !== ts.SyntaxKind.ExclamationToken) return false;
  const call = statement.expression.operand;
  if (!ts.isCallExpression(call) || !callNamed(call, "isWorkItemVisible") || call.arguments.length !== 2
    || !named(call.arguments[0], "existing") || !named(call.arguments[1], "actor")) return false;
  const rejection = ts.isBlock(statement.thenStatement)
    ? statement.thenStatement.statements.length === 1 ? statement.thenStatement.statements[0] : undefined
    : statement.thenStatement;
  return rejection != null && ts.isThrowStatement(rejection);
}

function checkAuthority(routeText: string, serviceText: string): string[] {
  const route = ts.createSourceFile(ROUTE, routeText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const service = ts.createSourceFile(SERVICE, serviceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const issues: string[] = [];
  const patchRoute = functionBody(route, "PATCH");
  const importedPatch = route.statements.some((statement) => ts.isImportDeclaration(statement)
    && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === "@/server/modules/todo/service"
    && statement.importClause?.isTypeOnly === false && statement.importClause.namedBindings
    && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some((item) => !item.isTypeOnly
      && item.name.text === "patchWorkItem" && (item.propertyName ?? item.name).text === "patchWorkItem"));
  const routeCalls = patchRoute ? nodes(patchRoute, ts.isCallExpression) : [];
  const delegated = routeCalls.filter((call) => callNamed(call, "patchWorkItem"));
  if (!importedPatch || delegated.length !== 1 || !ts.isAwaitExpression(delegated[0].parent)
    || delegated[0].arguments.length !== 3 || !["id", "patch", "user"].every((name, index) => named(delegated[0].arguments[index], name))
    || routeCalls.some((call) => ["assignWorkItem", "setWorkItemStatus", "completeWorkItem", "cancelWorkItem"].some((name) => callNamed(call, name))
      || ["insert", "update", "delete", "execute", "transaction"].some((name) => method(call, name)))) {
    issues.push("PATCH must await the imported patchWorkItem once, without a second known mutation path");
  }
  for (const [name, target, field] of [
    ["assignWorkItem", "patchWorkItem", "assigneeId"],
    ["setWorkItemStatus", "patchWorkItem", "status"],
    ["completeWorkItem", "setWorkItemStatus", "done"],
    ["cancelWorkItem", "setWorkItemStatus", "cancelled"],
  ] as const) {
    if (!delegatedReturn(functionBody(service, name), target, field)) issues.push(`${name} must only return ${target} with the original target and actor`);
  }
  const patch = functionBody(service, "patchWorkItem");
  const patchCalls = patch ? nodes(patch, ts.isCallExpression) : [];
  const transactions = patchCalls.filter((call) => method(call, "transaction"));
  const callback = transactions[0]?.arguments[0];
  if (transactions.length !== 1 || !ts.isPropertyAccessExpression(transactions[0].expression)
    || !named(transactions[0].expression.expression, "db") || !callback || !ts.isArrowFunction(callback)
    || callback.parameters.length !== 1 || !named(callback.parameters[0].name, "tx") || !ts.isBlock(callback.body)) {
    issues.push("patchWorkItem must use one explicit db.transaction callback");
    return issues;
  }
  const body = callback.body;
  const lockIndex = body.statements.findIndex(baseRowLock);
  const guardIndex = body.statements.findIndex(visibilityGuard);
  const visibleCalls = patchCalls.filter((call) => callNamed(call, "isWorkItemVisible"));
  if (lockIndex < 0 || guardIndex <= lockIndex || visibleCalls.length !== 1
    || (guardIndex >= 0 && !nodes(body.statements[guardIndex], ts.isCallExpression).includes(visibleCalls[0]))) {
    issues.push("patchWorkItem must reject invisible base rows inside the transaction after awaiting FOR UPDATE");
  }
  const guard = body.statements[guardIndex];
  const mutations = patchCalls.filter((call) => ["insert", "update", "delete"].some((name) => method(call, name))
    && named(call.arguments[0], "workItems"));
  if (!guard || mutations.length === 0 || mutations.some((call) => call.getStart() < guard.end
    || call.getStart() < body.getStart() || call.end > body.end || !ts.isPropertyAccessExpression(call.expression)
    || !named(call.expression.expression, "tx"))
    || body.statements.slice(0, guardIndex).some((statement) => nodes(statement, ts.isReturnStatement).length > 0)) {
    issues.push("workItems mutations and no-op returns must not bypass the transactional visibility guard");
  }
  return issues;
}

const VALID_ROUTE = `import { patchWorkItem } from "@/server/modules/todo/service";
export async function PATCH(req, ctx) {
  const item = await patchWorkItem(id, patch, user);
  return item;
}`;
const LOCK = `const [existing] = await tx.select().from(workItems).where(eq(workItems.id, id)).for("update");`;
const GUARD = `if (!isWorkItemVisible(existing, actor)) throw new Error("denied");`;
const VALID_SERVICE = `
export async function patchWorkItem(id, patch, actor, dbArg, opts) {
  return db.transaction(async (tx) => {
    ${LOCK}
    ${GUARD}
    await tx.update(workItems).set(patch);
    return existing;
  });
}
export function assignWorkItem(id, assigneeId, actor, dbArg, opts) { return patchWorkItem(id, { assigneeId }, actor, dbArg, opts); }
export function setWorkItemStatus(id, status, actor, dbArg, opts) { return patchWorkItem(id, { status }, actor, dbArg, opts); }
export function completeWorkItem(id, actor, dbArg, opts) { return setWorkItemStatus(id, "done", actor, dbArg, opts); }
export function cancelWorkItem(id, actor, dbArg, opts) { return setWorkItemStatus(id, "cancelled", actor, dbArg, opts); }
`;

function replaceOnce(source: string, before: string, after: string): string {
  expect(source.split(before)).toHaveLength(2);
  return source.replace(before, after);
}

describe("待办修改单一入口：当前路由和包装函数的有界结构门", () => {
  it("实际 PATCH/assign/status/complete/cancel 统一委托，事务锁行后按同一可见范围授权", () => {
    expect(checkAuthority(read(ROUTE), read(SERVICE))).toEqual([]);
  });

  it("有效多行结构通过；注释和字符串中的假写入/假守卫不作为执行证据", () => {
    expect(checkAuthority(VALID_ROUTE, VALID_SERVICE)).toEqual([]);
    expect(checkAuthority(VALID_ROUTE, `${VALID_SERVICE}\n// db.update(workItems); isWorkItemVisible(fake, fake)\nconst text = "db.transaction(() => {})";`)).toEqual([]);
  });

  it.each([
    ["去掉实际委托只留注释", "await patchWorkItem(id, patch, user)", "await oldPatch(id, patch, user) /* patchWorkItem(id, patch, user) */"],
    ["分两次修改", "return item;", "await assignWorkItem(id, patch.assigneeId, user); return item;"],
    ["委托后直接写表", "return item;", "await db.update(workItems).set(patch); return item;"],
    ["未等待委托", "await patchWorkItem(id, patch, user)", "patchWorkItem(id, patch, user)"],
  ])("PATCH 违规会红：%s", (_name, before, after) => {
    expect(checkAuthority(replaceOnce(VALID_ROUTE, before, after), VALID_SERVICE)).toContain("PATCH must await the imported patchWorkItem once, without a second known mutation path");
  });

  it.each([
    ["assign 绕过统一入口", "return patchWorkItem(id, { assigneeId }, actor, dbArg, opts);", "return db.update(workItems).set({ assigneeId });"],
    ["status 换掉目标身份", "return patchWorkItem(id, { status }, actor, dbArg, opts);", "return patchWorkItem(otherId, { status }, actor, dbArg, opts);"],
    ["complete 直接写表", "return setWorkItemStatus(id, \"done\", actor, dbArg, opts);", "return db.update(workItems).set({ status: 'done' });"],
  ])("包装函数违规会红：%s", (_name, before, after) => {
    expect(checkAuthority(VALID_ROUTE, replaceOnce(VALID_SERVICE, before, after)).some((issue) => issue.includes("must only return"))).toBe(true);
  });

  it.each([
    ["守卫移到事务外", `${GUARD}\n    await`, "await"],
    ["只调用不拒绝", GUARD, "isWorkItemVisible(existing, actor);"],
    ["守卫位于锁前", `${LOCK}\n    ${GUARD}`, `${GUARD}\n    ${LOCK}`],
    ["不锁基础行", '.for("update")', '.for("share")'],
    ["锁错目标表", ".from(workItems)", ".from(otherTable)"],
    ["锁错目标 ID", "eq(workItems.id, id)", "eq(workItems.id, otherId)"],
    ["守卫用错操作者", "isWorkItemVisible(existing, actor)", "isWorkItemVisible(existing, admin)"],
    ["守卫藏在未调用函数", GUARD, `function notCalled() { ${GUARD} }`],
  ])("事务锁/可见性违规会红：%s", (name, before, after) => {
    let service = replaceOnce(VALID_SERVICE, before, after);
    if (name === "守卫移到事务外") service = replaceOnce(service, "return db.transaction", `${GUARD}\n return db.transaction`);
    expect(checkAuthority(VALID_ROUTE, service)).toContain("patchWorkItem must reject invisible base rows inside the transaction after awaiting FOR UPDATE");
  });

  it.each([
    ["守卫前无操作早退", LOCK, `${LOCK}\n if (!patch.status) return existing;`],
    ["守卫前修改", GUARD, `await tx.update(workItems).set(patch); ${GUARD}`],
    ["改用事务外 DB 写入", "await tx.update(workItems)", "await db.update(workItems)"],
  ])("写入/早退绕过守卫会红：%s", (_name, before, after) => {
    expect(checkAuthority(VALID_ROUTE, replaceOnce(VALID_SERVICE, before, after))).toContain("workItems mutations and no-op returns must not bypass the transactional visibility guard");
  });
});
