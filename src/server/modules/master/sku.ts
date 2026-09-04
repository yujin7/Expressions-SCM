import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle PGlite/Postgres structural compatibility is narrowed by the surrounding service contract
type AnyTx = any;
import { getDbAsync, schema } from "@/db";
import { ApiError } from "./common";
import { SKU_TYPES, skuCreateSchema, skuSchema } from "./schemas";
import {
  assessSkuStandardName,
  COMMERCIAL_ROLES,
  type CommercialRole,
} from "@/server/rules/sku-standardization";
import {
  assertGovernedSkuCode,
  isGovernedSkuCode,
} from "@/server/rules/sku-code";
import { allocateGovernedSkuCode } from "./sku-code-allocation";

type SkuType = (typeof SKU_TYPES)[number];

function parseTypes(raw: string | null): SkuType[] | undefined {
  if (!raw) return undefined;
  const types = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SkuType => (SKU_TYPES as readonly string[]).includes(s));
  return types.length ? types : undefined;
}

function parseCommercialRole(raw: string | null): CommercialRole | undefined {
  return COMMERCIAL_ROLES.includes(raw as CommercialRole) ? (raw as CommercialRole) : undefined;
}

export async function listSkus(
  q: string,
  page: number,
  pageSize: number,
  typeParam: string | null,
  roleParam?: string | null,
) {
  const db = await getDbAsync();
  const conds = [];
  if (q) {
    conds.push(
      or(
        ilike(schema.skus.code, `%${q}%`),
        ilike(schema.skus.name, `%${q}%`),
        ilike(schema.spus.nameCn, `%${q}%`),
        ilike(schema.skus.spec, `%${q}%`),
        sql`exists (
          select 1
          from sku_identifiers si
          where si.sku_id = ${schema.skus.id}
            and si.active = true
            and si.value ilike ${`%${q}%`}
        )`,
      ),
    );
  }
  const types = parseTypes(typeParam);
  if (types) conds.push(inArray(schema.skus.skuType, types));
  const commercialRole = parseCommercialRole(roleParam ?? null);
  if (commercialRole) conds.push(eq(schema.skus.commercialRole, commercialRole));
  const where = conds.length ? and(...conds) : undefined;

  const base = db
    .select({
      id: schema.skus.id,
      code: schema.skus.code,
      name: schema.skus.name,
      spuId: schema.skus.spuId,
      spuCode: schema.spus.code,
      spuNameCn: schema.spus.nameCn,
      skuType: schema.skus.skuType,
      baseUom: schema.skus.baseUom,
      spec: schema.skus.spec,
      version: schema.skus.version,
      prodMode: schema.skus.prodMode,
      lossCategory: schema.skus.lossCategory,
      shelfLifeDays: schema.skus.shelfLifeDays,
      nearExpiryDays: schema.skus.nearExpiryDays,
      brandId: schema.skus.brandId,
      brand: schema.brands.nameCn,
      channelId: schema.skus.channelId,
      channel: schema.channels.name,
      shortName: schema.skus.shortName,
      commercialRole: schema.skus.commercialRole,
      normalLeadDays: schema.skuParams.normalLeadDays,
      logisticsLeadDays: schema.skuParams.logisticsLeadDays,
      lifecycle: schema.skus.lifecycle,
      active: schema.skus.active,
    })
    .from(schema.skus)
    .innerJoin(schema.spus, eq(schema.skus.spuId, schema.spus.id))
    .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
    .leftJoin(schema.channels, eq(schema.skus.channelId, schema.channels.id))
    .leftJoin(schema.skuParams, eq(schema.skus.id, schema.skuParams.skuId));

  const [rawRows, [{ total }]] = await Promise.all([
    base.where(where).orderBy(schema.skus.code).limit(pageSize).offset((page - 1) * pageSize),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.skus)
      .innerJoin(schema.spus, eq(schema.skus.spuId, schema.spus.id))
      .where(where),
  ]);
  const rows = rawRows.map((row) => {
    const assessment = assessSkuStandardName(row);
    const namingStatus = assessment.publishedFormat
      ? "published"
      : !assessment.ready ? "incomplete" : assessment.suggestion === row.name ? "standard" : "ready";
    return { ...row, standardName: assessment.suggestion, namingStatus };
  });
  return { data: rows, total };
}

async function assertDimensionIds(
  tx: AnyTx,
  brandId?: number | null,
  channelId?: number | null,
): Promise<{ brandCode: string | null }> {
  let brandCode: string | null = null;
  if (brandId != null) {
    const [brand] = await tx
      .select({ id: schema.brands.id, code: schema.brands.code })
      .from(schema.brands)
      .where(eq(schema.brands.id, brandId));
    if (!brand) throw new ApiError(400, "品牌不存在");
    brandCode = brand.code;
  }
  if (channelId != null) {
    const [channel] = await tx.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.id, channelId));
    if (!channel) throw new ApiError(400, "渠道不存在");
  }
  return { brandCode };
}

/**
 * @param actor 写入者。审计必须与写入落在**同一个事务**里。
 *   此前审计由路由层的 auditFromRoute 补记，而它用 getDbAsync() 拿的是**新的根连接**、
 *   且在服务事务提交之后才跑——进程在这中间挂掉就会留下「有数据、无审计」的行。
 *   CLAUDE.md 的铁律是「所有 service 写路径必须 writeAudit」，原子性是这条规则的实质。
 */
export async function createSku(input: unknown, actor?: SessionUser, dbArg?: AnyTx) {
  const v = skuCreateSchema.parse(input);
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
    const { brandCode } = await assertDimensionIds(tx, v.brandId, v.channelId);
    const isInteractive = actor != null;
    const isHistoricalMigration = v.creationMode === "historical_migration";
    if (!isInteractive && (isHistoricalMigration || v.historicalMigrationReason)) {
      throw new ApiError(403, "历史迁移模式必须由已登录管理员执行并写入审计");
    } else if (isInteractive && isHistoricalMigration) {
      if (!actor.roles.includes("admin")) {
        throw new ApiError(403, "只有管理员可以执行历史 SKU 迁移建档");
      }
      if (!v.code) {
        throw new ApiError(400, "历史迁移模式必须填写真实历史编码");
      }
      if (!v.historicalMigrationReason) {
        throw new ApiError(400, "历史迁移模式必须填写迁移原因");
      }
    } else if (isInteractive) {
      if (v.code) {
        throw new ApiError(400, "主数据新建默认使用系统 S1 编码；请留空由系统取号");
      }
      if (v.historicalMigrationReason) {
        throw new ApiError(400, "迁移原因只能用于历史迁移模式");
      }
    }
    let code = v.code;
    if (!code) {
      code = await allocateGovernedSkuCode(tx, brandCode, v.skuType);
    } else if (isGovernedSkuCode(code)) {
      throw new ApiError(400, "S1 编码由系统全局原子取号；请将编码留空。历史/外部编码不得占用 S1 命名空间");
    }
    const [created] = await tx
      .insert(schema.skus)
      .values({
        code,
        name: v.name,
        brandId: v.brandId ?? null,
        channelId: v.channelId ?? null,
        shortName: v.shortName ?? null,
        commercialRole: v.commercialRole ?? "retail",
        lifecycle: v.lifecycle ?? "on_sale",
        spuId: v.spuId,
        skuType: v.skuType,
        baseUom: v.baseUom,
        spec: v.spec ?? null,
        version: v.version ?? null,
        prodMode: v.prodMode ?? null,
        lossCategory: v.lossCategory ?? null,
        shelfLifeDays: v.shelfLifeDays ?? null,
        nearExpiryDays: v.nearExpiryDays ?? null,
        active: v.active,
      })
      .returning();
    /* 加工周期与在途周期落在同一行 sku_params，且与 /master/supply-params 是同一行
       （审计 #12：此前主档表单只有在途，加工只能去补录页填，一行数据两张半张表单）。 */
    if (v.normalLeadDays !== undefined || v.logisticsLeadDays !== undefined) {
      await tx.insert(schema.skuParams).values({
        skuId: created.id,
        ...(v.normalLeadDays !== undefined ? { normalLeadDays: v.normalLeadDays ?? null } : {}),
        ...(v.logisticsLeadDays !== undefined ? { logisticsLeadDays: v.logisticsLeadDays ?? null } : {}),
        updatedBy: actor?.id ?? null,
      });
    }
    if (actor) {
      await writeAudit(tx, {
        userId: actor.id,
        entity: "sku",
        entityId: created.id,
        action: "create",
        after: {
          ...created,
          normalLeadDays: v.normalLeadDays ?? null,
          logisticsLeadDays: v.logisticsLeadDays ?? null,
          creationMode: v.creationMode,
          ...(isHistoricalMigration
            ? { historicalMigrationReason: v.historicalMigrationReason }
            : {}),
        },
      });
    }
    return created;
  });
}

/**
 * 批量设置业务用途（样品/赠品/试用/内用/正常销售）。
 *
 * 为什么必须有：`commercial_role` 此前只能在主档表单里逐条改，BOM 批量放行路径
 * 根本不写这一列——实跑库 5,376 个 SKU **全部** 停在 `unclassified`，
 * 而「未分类」在分析口径里按参与正常销售处理，于是 0727 会议要的
 * 「小样拆出来独立统计、避免无动销失真」在真实数据上一直没生效。
 *
 * 写路径口径：
 * - 身份在路由层用 `guardWrite("sku")` 回查 DB（新鲜授权，界面可见性不算授权）；
 * - 整批一个事务：要么全改要么全不改，不接受静默部分成功；
 * - 逐 SKU 写审计，before/after 都记，便于事后追是谁把哪一批归成了样品；
 * - 幂等：值相同的行不写库也不记审计，重放返回同样的计数而不是报错；
 * - 不存在的 id 直接整批回滚报 404——宁可让人重选，也不要"改了一半还说成功"。
 */
export async function setSkuCommercialRoles(
  ids: number[],
  role: CommercialRole,
  actor: SessionUser,
  dbArg?: AnyTx,
): Promise<{ updated: number; unchanged: number; role: CommercialRole }> {
  if (!COMMERCIAL_ROLES.includes(role)) throw new ApiError(400, "业务用途取值非法");
  const unique = [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0);
  if (unique.length === 0) throw new ApiError(400, "请先选择要设置的 SKU");
  if (unique.length > 2000) throw new ApiError(400, "单次最多设置 2000 个 SKU，请分批");

  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
    const rows = await tx
      .select({ id: schema.skus.id, code: schema.skus.code, commercialRole: schema.skus.commercialRole })
      .from(schema.skus)
      .where(inArray(schema.skus.id, unique))
      // 确定性顺序：避免并发批次交叉时的行锁死锁
      .orderBy(schema.skus.id);
    if (rows.length !== unique.length) {
      const found = new Set(rows.map((r: { id: number }) => r.id));
      const missing = unique.filter((id) => !found.has(id));
      throw new ApiError(404, `以下 SKU 不存在，整批未改：${missing.slice(0, 10).join("、")}`);
    }

    const changed = rows.filter((r: { commercialRole: string }) => r.commercialRole !== role);
    if (changed.length === 0) return { updated: 0, unchanged: rows.length, role };

    await tx
      .update(schema.skus)
      .set({ commercialRole: role, updatedAt: new Date() })
      .where(inArray(schema.skus.id, changed.map((r: { id: number }) => r.id)));

    for (const r of changed) {
      await writeAudit(tx, {
        userId: actor.id,
        entity: "sku",
        entityId: r.id,
        action: "set_commercial_role",
        before: { commercialRole: r.commercialRole, code: r.code },
        after: { commercialRole: role, code: r.code },
      });
    }
    return { updated: changed.length, unchanged: rows.length - changed.length, role };
  });
}

export async function updateSku(id: number, input: unknown, actor?: SessionUser, dbArg?: AnyTx) {
  const v = skuSchema.parse(input);
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
    const [existing] = await tx.select().from(schema.skus).where(eq(schema.skus.id, id));
    if (!existing) throw new ApiError(404, "SKU 不存在");
    const [existingParams] = await tx
      .select({ normalLeadDays: schema.skuParams.normalLeadDays, logisticsLeadDays: schema.skuParams.logisticsLeadDays })
      .from(schema.skuParams)
      .where(eq(schema.skuParams.skuId, id));
    if (v.code !== undefined && v.code !== existing.code) {
      throw new ApiError(409, "SKU 主码已用于历史关联，不可直接改码；请新建替代 SKU，并把旧码登记为别名");
    }
    await assertDimensionIds(tx, v.brandId, v.channelId);
    if (isGovernedSkuCode(existing.code)) {
      try {
        // S1 的来源段是创建时的稳定起源快照，不是当前品牌关系的替代品。
        // 品牌归属可以经治理调整，但不能因此改写主码；货品类型仍属于稳定身份。
        assertGovernedSkuCode(existing.code, { skuType: v.skuType });
      } catch (error) {
        throw new ApiError(409, `S1 稳定身份不可变：${(error as Error).message}`);
      }
    }
    const [updated] = await tx
      .update(schema.skus)
      .set({
        code: existing.code,
        name: v.name,
        brandId: v.brandId ?? null,
        channelId: v.channelId ?? null,
        shortName: v.shortName ?? null,
        commercialRole: v.commercialRole ?? existing.commercialRole,
        lifecycle: v.lifecycle ?? "on_sale",
        spuId: v.spuId,
        skuType: v.skuType,
        baseUom: v.baseUom,
        spec: v.spec ?? null,
        version: v.version ?? null,
        prodMode: v.prodMode ?? null,
        lossCategory: v.lossCategory ?? null,
        shelfLifeDays: v.shelfLifeDays ?? null,
        nearExpiryDays: v.nearExpiryDays ?? null,
        active: v.active,
        updatedAt: new Date(),
      })
      .where(eq(schema.skus.id, id))
      .returning();
    if (v.normalLeadDays !== undefined || v.logisticsLeadDays !== undefined) {
      const leadSet = {
        ...(v.normalLeadDays !== undefined ? { normalLeadDays: v.normalLeadDays ?? null } : {}),
        ...(v.logisticsLeadDays !== undefined ? { logisticsLeadDays: v.logisticsLeadDays ?? null } : {}),
      };
      await tx.insert(schema.skuParams).values({
        skuId: id,
        ...leadSet,
        updatedBy: actor?.id ?? null,
      }).onConflictDoUpdate({
        target: schema.skuParams.skuId,
        set: { ...leadSet, updatedBy: actor?.id ?? null, updatedAt: new Date() },
      });
    }
    if (actor) {
      await writeAudit(tx, {
        userId: actor.id,
        entity: "sku",
        entityId: id,
        action: "update",
        before: { ...existing, normalLeadDays: existingParams?.normalLeadDays ?? null, logisticsLeadDays: existingParams?.logisticsLeadDays ?? null },
        after: {
          ...updated,
          ...(v.normalLeadDays !== undefined ? { normalLeadDays: v.normalLeadDays ?? null } : {}),
          ...(v.logisticsLeadDays !== undefined ? { logisticsLeadDays: v.logisticsLeadDays ?? null } : {}),
        },
      });
    }
    return updated;
  });
}

/** 人工采用服务端重算的标准名称；不接受客户端传建议名，也不修改稳定 SKU 主码。 */
export async function applySkuStandardName(id: number, actor: SessionUser, dbArg?: AnyTx) {
  const db: AnyTx = dbArg ?? (await getDbAsync());
  return db.transaction(async (tx: AnyTx) => {
    const [row] = await tx
      .select({
        id: schema.skus.id,
        code: schema.skus.code,
        name: schema.skus.name,
        brand: schema.brands.nameCn,
        channel: schema.channels.name,
        shortName: schema.skus.shortName,
        version: schema.skus.version,
        spec: schema.skus.spec,
      })
      .from(schema.skus)
      .leftJoin(schema.brands, eq(schema.skus.brandId, schema.brands.id))
      .leftJoin(schema.channels, eq(schema.skus.channelId, schema.channels.id))
      .where(eq(schema.skus.id, id));
    if (!row) throw new ApiError(404, "SKU 不存在");
    const assessment = assessSkuStandardName(row);
    // 不可逆降级闸：现名已符合公司公布的 (品牌)产品全称(规格) 格式时拒绝改写。
    // 界面此时不渲染按钮，这里挡的是直接调 API 的路径。
    if (assessment.publishedFormat) {
      throw new ApiError(
        409,
        `「${row.name}」已符合公司公布的命名格式，不改写；两套命名口径需业务先行裁决`,
      );
    }
    if (!assessment.suggestion) {
      const missing = assessment.missing.map((field) => field === "brand" ? "品牌" : "产品简称").join("、");
      throw new ApiError(400, `采用标准名称前请补齐：${missing}`);
    }
    if (row.name === assessment.suggestion) {
      return { id, code: row.code, name: row.name, unchanged: true };
    }
    const [updated] = await tx
      .update(schema.skus)
      .set({ name: assessment.suggestion, updatedAt: new Date() })
      .where(eq(schema.skus.id, id))
      .returning({ id: schema.skus.id, code: schema.skus.code, name: schema.skus.name });
    await writeAudit(tx, {
      userId: actor.id,
      entity: "sku",
      entityId: id,
      action: "standardize_name",
      before: { name: row.name },
      after: { name: updated.name, stableCode: updated.code },
    });
    return { ...updated, unchanged: false };
  });
}
