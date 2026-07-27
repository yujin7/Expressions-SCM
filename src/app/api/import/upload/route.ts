/**
 * 文件上传入 staging（D20/DW2 运营环）：xlsx → uploads/ → 对应适配器 → staging。
 * 权限同放行（pmc/admin，写路径回查 DB）；文件落 uploads/（.gitignore，备份脚本已含）。
 * 解析/入库不猜测——未解析别名照常进认领队列，放行仍走放行工作台的人工闸。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { storageDir } from "@/server/core/storage";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getDbAsync } from "@/db";
import { ApiError, errorResponse } from "@/server/modules/master/common";
import { guardFreshWrite, requireAnyRole } from "@/server/modules/outsource/common";
import { stageBom } from "@/server/import/adapters/bom";
import { stageInventoryLong } from "@/server/import/adapters/inventory-long";
import { stageExpiry } from "@/server/import/adapters/expiry";
import { stageSalesMonthly } from "@/server/import/adapters/sales-monthly";
import { stageLeadtime } from "@/server/import/adapters/leadtime";
import { stageTransit } from "@/server/import/adapters/transit";
import { stageDemand } from "@/server/import/adapters/demand";
import { stagePallet } from "@/server/import/adapters/pallet";
import { stageStockSummary } from "@/server/import/adapters/stock-summary";
import { stageSkuCost } from "@/server/import/adapters/sku-cost";
import { readWorkbook } from "@/server/import/parse/xlsx";
import {
  assertWorkbookMatchesTemplate,
  IMPORT_TEMPLATES,
} from "@/server/import/template-contract";

const fields = z.object({
  template: z.enum(IMPORT_TEMPLATES, { errorMap: () => ({ message: "未知模板类型" }) }),
  brand: z.string().trim().max(20).optional(), // bom 必填（品牌编码）
});

const MAX_SIZE = 30 * 1024 * 1024; // 30MB——真实 BOM 工作簿 ~5MB，留余量

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "缺少文件");
    if (!/\.xlsx$/i.test(file.name)) throw new ApiError(400, "仅支持 .xlsx 文件");
    if (file.size > MAX_SIZE) throw new ApiError(400, "文件超过 30MB 限制");
    const v = fields.parse({
      template: form.get("template"),
      brand: form.get("brand") || undefined,
    });
    if (v.template === "bom" && !v.brand) throw new ApiError(400, "BOM 导入必须选择品牌");
    if (v.template === "sku_cost") requireAnyRole(user, "finance");
    else requireAnyRole(user, "pmc");

    // 落盘：uploads/<时间戳>/<原名>——保留原始文件名（部分适配器按文件名推导语义，
    // 如销量表回退「NN年」取年份），时间戳做目录防覆盖；原名清洗防路径穿越
    const safeName = path.basename(file.name).replace(/[^\w.\-一-龥（）()【】]/g, "_");
    const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 14);
    const dir = storageDir(stamp); // 落盘根唯一权威（core/storage）——禁止 process.cwd()
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, safeName);
    await writeFile(filePath, Buffer.from(await file.arrayBuffer()));

    // 先验内容指纹：错误模板在创建 import_job / staging 行之前即被拒绝。
    const workbook = await readWorkbook(filePath);
    assertWorkbookMatchesTemplate(workbook, v.template);

    const db = await getDbAsync();
    const summary =
      v.template === "bom"
        ? await stageBom(db, filePath, v.brand!, user.id)
        : v.template === "inventory"
          ? await stageInventoryLong(db, filePath, user.id)
          : v.template === "expiry"
            ? await stageExpiry(db, filePath, user.id)
            : v.template === "sales"
              ? await stageSalesMonthly(db, filePath, user.id)
              : v.template === "leadtime"
                ? await stageLeadtime(db, filePath, user.id)
                : v.template === "transit"
                  ? await stageTransit(db, filePath, user.id)
                  : v.template === "demand"
                    ? await stageDemand(db, filePath, user.id)
                    : v.template === "pallet"
                      ? await stagePallet(db, filePath, user.id)
                      : v.template === "stock_summary"
                        ? await stageStockSummary(db, filePath, user.id)
                        : await stageSkuCost(db, filePath, user.id);

    // RT4：上传本身留审计痕（谁在何时上传了什么文件到哪个模板）
    const { writeAudit } = await import("@/server/core/audit");
    await writeAudit(db, {
      userId: user.id,
      entity: "import_upload",
      action: "upload",
      after: { file: safeName, template: v.template, size: file.size },
    });
    return NextResponse.json({ file: safeName, template: v.template, summary });
  } catch (e) {
    return errorResponse(e);
  }
}
