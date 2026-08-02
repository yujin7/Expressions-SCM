import { describe, expect, it, vi } from "vitest";
import {
  auditJiandaoyunCatalog,
  auditJiandaoyunContracts,
} from "@/server/integrations/jiandaoyun-audit";
import type { JiandaoyunFormContract } from "@/server/integrations/jiandaoyun-contracts";

const appId = "a".repeat(24);
const entryId = "b".repeat(24);

const contract: JiandaoyunFormContract = {
  key: "control-test",
  label: "控制总量测试",
  appId,
  entryId,
  targetTable: "jdy_control_test",
  fields: [
    { source: "_widget_code", target: "productCode" },
    { source: "_widget_qty", target: "qty" },
  ],
  subforms: [{
    source: "_widget_lines",
    target: "lines",
    items: [
      { source: "_widget_line_code", target: "productCode" },
      { source: "_widget_line_qty", target: "qty" },
    ],
  }],
};

describe("简道云只读控制总量", () => {
  it("只输出聚合覆盖、时间范围和子表行数，并强制最小字段投影", async () => {
    const listRecords = vi.fn(async () => [{
      _id: "c".repeat(24),
      appId,
      entryId,
      createTime: "2026-07-01T00:00:00.000Z",
      updateTime: "2026-07-29T00:00:00.000Z",
      deleteTime: null,
      _widget_code: { value: "SKU-001" },
      _widget_qty: { value: "2" },
      _widget_lines: {
        value: [
          { _widget_line_code: { value: "SKU-001" }, _widget_line_qty: { value: "1" } },
          { _widget_line_code: { value: "" }, _widget_line_qty: { value: "1" } },
        ],
      },
      _widget_phone: { value: "sensitive" },
    }]);
    const client = {
      listWidgets: vi.fn(async () => [
        { name: "_widget_code", label: "编码", type: "text", items: [] },
        { name: "_widget_qty", label: "数量", type: "number", items: [] },
        {
          name: "_widget_lines",
          label: "明细",
          type: "subform",
          items: [
            { name: "_widget_line_code", label: "编码", type: "text", items: [] },
            { name: "_widget_line_qty", label: "数量", type: "number", items: [] },
            { name: "_widget_line_image", label: "图片", type: "image", items: [] },
          ],
        },
        { name: "_widget_phone", label: "手机", type: "text", items: [] },
      ]),
      listRecords,
    };

    const [result] = await auditJiandaoyunContracts(client, {
      contracts: [contract],
      now: new Date("2026-07-30T00:00:00.000Z"),
    });

    expect(listRecords).toHaveBeenCalledWith(appId, entryId, [
      "createTime",
      "updateTime",
      "deleteTime",
      "_widget_code",
      "_widget_qty",
      "_widget_lines",
    ]);
    expect(result).toMatchObject({
      contractKey: "control-test",
      projectionFields: 6,
      sourceRows: 1,
      activeRows: 1,
      deletedRows: 0,
      createdFrom: "2026-07-01T00:00:00.000Z",
      updatedThrough: "2026-07-29T00:00:00.000Z",
      activeUpdatedThrough: "2026-07-29T00:00:00.000Z",
      ageDays: 1,
      freshness: { status: "current", maxAgeDays: 90, currentUseBlocked: false },
      businessKey: null,
      numericControls: [],
      reconciliations: [],
      fieldCoverage: [
        { field: "productCode", populated: 1, total: 1 },
        { field: "qty", populated: 1, total: 1 },
      ],
      subforms: [{
        target: "lines",
        rows: 2,
        fieldCoverage: [
          { field: "productCode", populated: 1, total: 2 },
          { field: "qty", populated: 2, total: 2 },
        ],
        numericControls: [],
      }],
    });
    expect(JSON.stringify(result)).not.toContain("SKU-001");
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(result.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("用活跃行验证业务键、定点数值总量和实际新鲜度", async () => {
    const controlled: JiandaoyunFormContract = {
      ...contract,
      businessKey: ["productCode"],
      numericControls: [{ target: "qty", scale: 4 }],
      freshnessMaxAgeDays: 5,
      subforms: [],
    };
    const base = {
      appId,
      entryId,
      createTime: "2026-07-01T00:00:00.000Z",
      updateTime: "2026-07-20T00:00:00.000Z",
      deleteTime: null,
    };
    const records = [
      {
        ...base,
        _id: "1".repeat(24),
        _widget_code: { value: "SKU-A" },
        _widget_qty: { value: "1.25" },
      },
      {
        ...base,
        _id: "2".repeat(24),
        _widget_code: { value: "sku-a" },
        _widget_qty: { value: 2.75 },
      },
      {
        ...base,
        _id: "3".repeat(24),
        _widget_code: { value: "" },
        _widget_qty: { value: "not-a-number" },
      },
      {
        ...base,
        _id: "4".repeat(24),
        updateTime: "2026-07-30T00:00:00.000Z",
        deleteTime: "2026-07-30T00:00:00.000Z",
        _widget_code: { value: "DELETED" },
        _widget_qty: { value: "100" },
      },
    ];
    const client = {
      listWidgets: vi.fn(async () => [
        { name: "_widget_code", label: "编码", type: "text", items: [] },
        { name: "_widget_qty", label: "数量", type: "number", items: [] },
      ]),
      listRecords: vi.fn(async () => records),
    };

    const [result] = await auditJiandaoyunContracts(client, {
      contracts: [controlled],
      now: new Date("2026-07-30T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      sourceRows: 4,
      activeRows: 3,
      deletedRows: 1,
      updatedThrough: "2026-07-30T00:00:00.000Z",
      activeUpdatedThrough: "2026-07-20T00:00:00.000Z",
      ageDays: 10,
      freshness: { status: "stale", maxAgeDays: 5, currentUseBlocked: true },
      businessKey: {
        fields: ["productCode"],
        completeRows: 2,
        missingRows: 1,
        duplicateKeyGroups: 1,
        duplicateRows: 2,
        unique: false,
      },
      numericControls: [{
        field: "qty",
        scale: 4,
        populated: 3,
        parsed: 2,
        invalid: 1,
        total: 3,
        sum: "4.0000",
      }],
    });
    expect(JSON.stringify(result)).not.toContain("SKU-A");
    expect(JSON.stringify(result)).not.toContain("DELETED");
  });

  it("只以目录聚合控制量标记重复视图的权威裁决需求", () => {
    const secondAppId = "d".repeat(24);
    const forms = [
      { appId, entryId, name: "采购单" },
      { appId: secondAppId, entryId, name: "  采购单  " },
      { appId: secondAppId, entryId: "e".repeat(24), name: "仓库" },
    ];
    const selected: JiandaoyunFormContract = {
      ...contract,
      appId,
      entryId,
    };

    expect(auditJiandaoyunCatalog(
      [{ appId, name: "旧应用" }, { appId: secondAppId, name: "新应用" }],
      forms,
      [selected],
    )).toEqual({
      apps: 2,
      forms: 3,
      duplicateEntryIdGroups: 1,
      duplicateFormNameGroups: 1,
      selectedContracts: 1,
      selectedViewsFound: 1,
      selectedViewsMissing: 0,
      selectedViewsWithSharedEntryId: 1,
      selectedViewsWithDuplicateName: 1,
      authorityDecisionRequired: true,
    });
  });

  it("用定点小数对账表头与明细，差异不被四舍五入掩盖", async () => {
    const reconciliationContract: JiandaoyunFormContract = {
      key: "reconciliation-test",
      label: "对账测试",
      appId,
      entryId,
      targetTable: "jdy_reconciliation_test",
      fields: [{ source: "_widget_total", target: "totalQty" }],
      numericControls: [{ target: "totalQty", scale: 4 }],
      subforms: [{
        source: "_widget_lines",
        target: "lines",
        items: [{ source: "_widget_line_qty", target: "qty" }],
        numericControls: [{ target: "qty", scale: 4 }],
      }],
      reconciliations: [{
        key: "quantity",
        headerTarget: "totalQty",
        lineTargets: [{ subformTarget: "lines", fieldTarget: "qty" }],
        scale: 4,
        tolerance: "0.0000",
      }],
    };
    const client = {
      listWidgets: vi.fn(async () => [
        { name: "_widget_total", label: "总量", type: "number", items: [] },
        {
          name: "_widget_lines",
          label: "明细",
          type: "subform",
          items: [{ name: "_widget_line_qty", label: "数量", type: "number", items: [] }],
        },
      ]),
      listRecords: vi.fn(async () => [{
        _id: "f".repeat(24),
        appId,
        entryId,
        createTime: "2026-07-01T00:00:00.000Z",
        updateTime: "2026-07-29T00:00:00.000Z",
        deleteTime: null,
        _widget_total: { value: "10.0000" },
        _widget_lines: { value: [
          { _widget_line_qty: { value: "4.0000" } },
          { _widget_line_qty: { value: "5.9999" } },
        ] },
      }]),
    };

    const [result] = await auditJiandaoyunContracts(client, {
      contracts: [reconciliationContract],
      now: new Date("2026-07-30T00:00:00.000Z"),
    });

    expect(result.reconciliations).toEqual([{
      key: "quantity",
      headerField: "totalQty",
      lineFields: [{ subform: "lines", field: "qty" }],
      headerSum: "10.0000",
      lineSum: "9.9999",
      delta: "0.0001",
      tolerance: "0.0000",
      status: "mismatched",
      totalRows: 1,
      matchedRows: 0,
      mismatchedRows: 1,
      insufficientRows: 0,
    }]);
  });
});
