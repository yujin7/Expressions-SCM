import { describe, expect, it, vi } from "vitest";
import { auditJiandaoyunContracts } from "@/server/integrations/jiandaoyun-audit";
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
      deletedRows: 0,
      createdFrom: "2026-07-01T00:00:00.000Z",
      updatedThrough: "2026-07-29T00:00:00.000Z",
      ageDays: 1,
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
      }],
    });
    expect(JSON.stringify(result)).not.toContain("SKU-001");
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(result.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
