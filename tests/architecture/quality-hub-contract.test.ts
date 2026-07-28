import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), "utf8");

describe("quality and compliance hub UI contract", () => {
  const page = read("src/app/(app)/quality/page.tsx");
  const client = read("src/app/(app)/quality/quality-client.tsx");

  it("keeps the authenticated quality surface behind a real Suspense boundary", () => {
    expect(page).toContain("await auth()");
    expect(page).toContain('["quality", "purchasing", "warehouse", "pmc", "ops"]');
    expect(page).toContain("<Suspense>");
    expect(page).toContain("<QualityClient />");
    expect(page.indexOf("<QualityClient />")).toBeGreaterThan(page.indexOf("<Suspense>"));
    expect(page.indexOf("<QualityClient />")).toBeLessThan(page.indexOf("</Suspense>"));
  });

  it("provides three compact, independent, shareable list workspaces", () => {
    expect(client).toContain('label: "案件与行动"');
    expect(client).toContain('label: "监管证据"');
    expect(client).toContain('label: "电子标签"');
    expect(client.match(/<ListToolbar/g)).toHaveLength(3);
    expect(client.match(/className="compact-kpi-row"/g)).toHaveLength(3);
    expect(client).toContain('paramPrefix: "qc"');
    expect(client).toContain('paramPrefix: "reg"');
    expect(client).toContain('paramPrefix: "el"');
    expect(client.match(/scroll=\{\{ x:/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("exposes authorized write paths instead of read-only placeholder tables", () => {
    expect(client).toContain('postJson("/api/quality/cases"');
    expect(client).toContain("postJson(`/api/quality/cases/${actionCase.id}/actions`");
    expect(client).toContain("patchJson(`/api/quality/cases/${caseOperation.row.id}`");
    expect(client).toContain("patchJson(`/api/quality/actions/${actionOperation.row.id}`");
    expect(client).toContain('postJson("/api/quality/regulatory"');
    expect(client).toContain('postJson("/api/quality/labels"');
    expect(client).toContain("canCreateCase");
    expect(client).toContain("canCreateAction");
    expect(client).toContain("canQuality");
    expect(client).toContain("canWrite");
  });

  it("uses searchable business choices instead of asking users to memorize database IDs", () => {
    expect(client).toContain('api="/api/master/sku"');
    expect(client).toContain('api="/api/master/supplier"');
    expect(client).toContain('api="/api/master/warehouse"');
    expect(client).toContain("<BatchBalanceSelect");
    expect(client).toContain("<RegulatoryRecordSelect");
    expect(client).toContain("按批号或 SKU 搜索当前系统批次余额");
    expect(client).not.toContain('label="SKU ID"');
    expect(client).not.toContain('label="供应商 ID"');
    expect(client).not.toContain('label="仓库 ID"');
    expect(client).not.toContain('label="有效监管证据版本 ID"');
  });

  it("makes quality authority and irreversible boundaries explicit", () => {
    expect(client).toContain("仍由有权限的人承担");
    expect(client).toContain("范围快照和摘要一经固化不可覆盖");
    expect(client).toContain("行动完成人不能验证自己的行动");
    expect(client).toContain("inspectionReportDate");
    expect(client).toContain('body.reportDate = value.inspectionReportDate?.format("YYYY-MM-DD")');
    expect(client).toContain("已发布版本不可修改或删除");
    expect(client).toContain("发布后内容不可覆盖，只能追加新版本");
    expect(client).toContain("lifecycleState");
    expect(client).toContain('scheduled: { color: "processing", text: "已排期" }');
    expect(client).toContain('current: { color: "success", text: "当前有效" }');
    expect(client).toContain('historical: { color: "default", text: "历史" }');
    expect(client).toContain('blocked: { color: "error", text: "监管支撑失效" }');
    expect(client).toContain("regulatoryEligibleAtLabelEffective");
    expect(client).toContain("regulatoryEligibleNow");
    expect(client).toContain('title: "监管证据"');
    expect(client).toContain("当前支撑不可用");
  });

  it("keeps failure recovery and truthful empty states on every data surface", () => {
    expect(client.match(/<ErrorAlert/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(client).toContain('message="数据加载失败"');
    expect(client).toContain(">重试</Button>");
    expect(client).toContain("当前筛选没有匹配案件");
    expect(client).toContain("当前筛选没有匹配的监管证据");
    expect(client).toContain("当前筛选没有匹配的电子标签");
    expect(client).toContain("该案件尚未建立质量行动");
    expect(client).toContain("批次加载失败");
    expect(client).toContain("监管证据加载失败");
  });

  it("does not value-import server modules into the client bundle", () => {
    expect(client).not.toMatch(/from\s+["']@\/server\//);
  });

  it("reuses one idempotency key across retries of the same create intent", () => {
    expect(client).toContain("const createCaseKey = useRef");
    expect(client).toContain("const createActionKey = useRef");
    expect(client.match(/const publishKey = useRef/g)).toHaveLength(2);
    expect(client).not.toMatch(/idempotencyKey:\s*globalThis\.crypto\.randomUUID\(\)/);
  });

  it("keeps dependent label evidence truthful when SKU, market, or effective date changes", () => {
    expect(client).toContain("effectiveDate={labelEffectiveDate}");
    expect(client).toContain('"effectiveDate" in changed');
    expect(client).toContain('form.setFieldValue("regulatoryRecordId", undefined)');
    expect(client).toContain('form.setFieldValue("registrationRef", undefined)');
    expect(client).toContain('form.setFieldValue("registrationRef", record?.referenceNo ?? undefined)');
    expect(client).toContain("row.effectiveDate > targetDate");
    expect(client).toContain("row.expiryDate < targetDate");
  });

  it("keeps long forms usable in compact mobile viewports", () => {
    expect(client).toContain('maxHeight: "calc(100dvh - 180px)"');
    expect(client).toContain("<Col xs={24} sm={12}><Form.Item name=\"reportDueDate\"");
    expect(client).toContain("<Col xs={24} sm={12} md={6}><Form.Item name=\"effectiveDate\"");
    expect(client).toContain("scroll={{ x: 1420 }}");
  });

  it("initializes modal forms only after their Form elements mount", () => {
    expect(client).toContain("if (!createOpen) return;");
    expect(client).toContain("if (!actionCase) return;");
    expect(client).toContain("if (!caseOperation) return;");
    expect(client).toContain("if (!actionOperation) return;");
    expect(client.match(/if \(!open\) return;/g)).toHaveLength(2);
    expect(client.match(/destroyOnHidden/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(client).not.toContain("forceRender");
    expect(client).not.toMatch(
      /const openCreateCase = \(\) => \{[^}]*resetFields\(\)[^}]*setCreateOpen\(true\);/,
    );
    expect(client).not.toMatch(
      /const showCreate = \(\) => \{[^}]*resetFields\(\)[^}]*setOpen\(true\);/,
    );
    expect(client).not.toMatch(
      /const showPublish = \(\) => \{[^}]*resetFields\(\)[^}]*setOpen\(true\);/,
    );
  });

  it("renders automatic regulatory follow-up actions without offering them for manual creation", () => {
    expect(client).toContain('| "follow_up"');
    expect(client).toContain('follow_up: "监管随访"');
    expect(client).toContain('.filter(([value]) => value !== "follow_up")');
  });

  it("warns operators not to copy restricted personal evidence into collaboration fields", () => {
    expect(client).toContain("不要写消费者姓名、联系方式或其他敏感信息");
    expect(client).toContain("消费者详情留在受控证据系统");
    expect(client).toContain("不要粘贴证据正文");
    expect(client).toContain("不要写消费者或医疗敏感信息");
  });
});
