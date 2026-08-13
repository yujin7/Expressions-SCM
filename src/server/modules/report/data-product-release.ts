import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import {
  DATA_PRODUCTS,
  type DataProductAutomationLevel,
  type DataProductDefinition,
} from "@/components/data-products";
import {
  currentProductAutomation,
  evaluateProductSourceEvidence,
  type ProductEvidenceSummary,
} from "@/components/data-product-source-evidence";
import * as schema from "@/db/schema";
import { digestDecisionEvidence } from "@/server/core/decision-envelope";
import type { SessionUser } from "@/server/core/dto";
import { writeAudit } from "@/server/core/audit";
import {
  CROSS_SYSTEM_IDENTITY_EXTRACTION_CONTRACT_VERSION,
  crossSystemIdentityExtractionScope,
  type CrossSystemIdentityDomain,
  type CrossSystemIdentitySource,
} from "@/lib/cross-system-identity";
import {
  CROSS_SYSTEM_SEMANTIC_CONTRACT_VERSION,
  crossSystemSemanticScope,
} from "@/lib/cross-system-semantics";
import {
  DATA_PRODUCT_METRIC_LINEAGE_VERSION,
  dataProductMetricLineageScope,
} from "@/lib/data-product-metric-lineage";
import { type AnyDb, resolveDb } from "@/server/core/svc";
import { ApiError } from "@/server/modules/master/common";
import { requireAnyRole } from "@/server/modules/outsource/common";
import {
  loadDataSourceReadiness,
  type DataSourceReadiness,
} from "@/server/modules/report/data-source-readiness";

export const DATA_PRODUCT_RELEASE_SCHEMA_VERSION = "data-product-release/v6" as const;
export type DataProductReleaseStatus = "pending" | "approved" | "rejected" | "revoked";
export type ReleasedAutomationLevel = Extract<DataProductAutomationLevel, "A2" | "A3">;

export interface DataProductReleaseDto {
  id: number;
  productId: string;
  contractVersion: string;
  targetLevel: ReleasedAutomationLevel;
  sourceEvidenceDigest: string;
  controlTotalRef: string;
  uatRef: string;
  rollbackPlan: string;
  scopeNote: string | null;
  status: DataProductReleaseStatus;
  requestedBy: number;
  requestedByName: string | null;
  requestedAt: string;
  decidedBy: number | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  revokedBy: number | null;
  revokedByName: string | null;
  revokedAt: string | null;
  version: number;
}

export interface DataProductReleaseReadiness {
  productId: string;
  runtimeLevel: "A0" | "A1";
  effectiveLevel: DataProductAutomationLevel;
  eligibleForRequest: boolean;
  gate: string;
  currentScopeDigest: string;
  activeRelease: DataProductReleaseDto | null;
  pendingRelease: DataProductReleaseDto | null;
  latestRelease: DataProductReleaseDto | null;
  activeReleaseCurrent: boolean;
  canRequest: boolean;
  canApprove: boolean;
  canReject: boolean;
  canRevoke: boolean;
  dependencyGates: DataProductDependencyGate[];
}

export interface DataProductDependencyGate {
  productId: string;
  title: string;
  minimumLevel: ReleasedAutomationLevel;
  effectiveLevel: DataProductAutomationLevel;
  activeReleaseCurrent: boolean;
  satisfied: boolean;
  purpose: string;
}

interface EvidenceEnvelope {
  schemaVersion: typeof DATA_PRODUCT_RELEASE_SCHEMA_VERSION;
  capturedAt: string;
  product: {
    id: string;
    contractVersion: string;
    maxAutomation: DataProductAutomationLevel;
    requiredSources: string[];
    requiredStreams: Record<string, string[]>;
    requiredIdentities: Record<string, string[]>;
    identityExtractionContractVersion: typeof CROSS_SYSTEM_IDENTITY_EXTRACTION_CONTRACT_VERSION;
    identityExtractionScope: ReturnType<typeof crossSystemIdentityExtractionScope>;
    semanticContractVersion: typeof CROSS_SYSTEM_SEMANTIC_CONTRACT_VERSION;
    requiredSemantics: DataProductDefinition["requiredSemantics"];
    semanticScope: ReturnType<typeof crossSystemSemanticScope>;
    metricLineageVersion: typeof DATA_PRODUCT_METRIC_LINEAGE_VERSION;
    metricIds: string[];
    metricLineageScope: ReturnType<typeof dataProductMetricLineageScope>;
    requiredScmEvidence: string[];
    requiredProducts: Array<{
      productId: string;
      minimumLevel: ReleasedAutomationLevel;
      purpose: string;
    }>;
  };
  sourceBindings: Array<{
    source: string;
    configurationBinding: string;
    contractSelectionState: string;
    selectedContractCount: number;
  }>;
  runtimeLevel: "A0" | "A1";
  runtimeReason: string;
  sourceEvidence: ProductEvidenceSummary;
  dependencyBindings: Array<{
    productId: string;
    minimumLevel: ReleasedAutomationLevel;
    contractVersion: string;
    effectiveLevel: DataProductAutomationLevel;
    activeReleaseId: number;
    sourceEvidenceDigest: string;
  }>;
}

const requestSchema = z.object({
  productId: z.string().trim().min(1).max(80),
  targetLevel: z.enum(["A2", "A3"]),
  controlTotalRef: z.string().trim().min(3, "请填写控制总量证据编号").max(200),
  uatRef: z.string().trim().min(3, "请填写业务 UAT 证据编号").max(200),
  rollbackPlan: z.string().trim().min(10, "回滚方案至少 10 个字").max(1_000),
  scopeNote: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().uuid(),
});

const decisionSchema = z.object({
  id: z.number().int().positive(),
  action: z.enum(["approve", "reject", "revoke"]),
  note: z.string().trim().min(5, "审批/撤回说明至少 5 个字").max(500),
  expectedVersion: z.number().int().positive(),
});

function getProduct(productId: string): DataProductDefinition {
  const product = DATA_PRODUCTS.find((item) => item.id === productId);
  if (!product) throw new ApiError(404, "数据产品不存在或已下线");
  return product;
}

function hasOwnerRole(user: SessionUser, product: DataProductDefinition): boolean {
  return user.roles.includes("admin") || product.ownerRoles.some((role) => user.roles.includes(role));
}

function requireOwnerRole(user: SessionUser, product: DataProductDefinition): void {
  requireAnyRole(user, ...product.ownerRoles);
}

function maxAllows(product: DataProductDefinition, level: ReleasedAutomationLevel): boolean {
  return level === "A2" || product.maxAutomation === "A3";
}

function levelAtLeast(level: DataProductAutomationLevel, minimum: ReleasedAutomationLevel): boolean {
  const rank: Record<DataProductAutomationLevel, number> = { A0: 0, A1: 1, A2: 2, A3: 3 };
  return rank[level] >= rank[minimum];
}

function dependencyGates(
  product: DataProductDefinition,
  dependencies: readonly DataProductReleaseReadiness[],
): DataProductDependencyGate[] {
  const readinessById = new Map(dependencies.map((item) => [item.productId, item]));
  return (product.requiredProducts ?? []).map((dependency) => {
    const upstreamProduct = DATA_PRODUCTS.find((item) => item.id === dependency.productId);
    const readiness = readinessById.get(dependency.productId);
    const effectiveLevel = readiness?.effectiveLevel ?? "A0";
    const activeReleaseCurrent = readiness?.activeReleaseCurrent === true;
    return {
      ...dependency,
      title: upstreamProduct?.title ?? dependency.productId,
      effectiveLevel,
      activeReleaseCurrent,
      satisfied: activeReleaseCurrent && levelAtLeast(effectiveLevel, dependency.minimumLevel),
    };
  });
}

export function buildDataProductReleaseEvidence(
  product: DataProductDefinition,
  dataSources: readonly DataSourceReadiness[],
  now = new Date(),
  dependencies: readonly DataProductReleaseReadiness[] = [],
): { envelope: EvidenceEnvelope; scopeDigest: string; eligible: boolean; gate: string } {
  const sourceEvidence = evaluateProductSourceEvidence(product, dataSources);
  const runtime = currentProductAutomation(sourceEvidence);
  const bySource = new Map(dataSources.map((row) => [row.key, row]));
  const sourceBindings = product.sources.map((source) => {
    const row = bySource.get(source);
    return {
      source,
      configurationBinding: row?.configurationBinding ?? `missing:${source}`,
      contractSelectionState: row?.contractSelectionState ?? "missing",
      selectedContractCount: row?.selectedContractCount ?? 0,
    };
  });
  const productDependencyGates = dependencyGates(product, dependencies);
  const dependencyBindings = productDependencyGates
    .filter((item) => item.satisfied)
    .map((item) => {
      const readiness = dependencies.find((dependency) => dependency.productId === item.productId)!;
      return {
        productId: item.productId,
        minimumLevel: item.minimumLevel,
        contractVersion: getProduct(item.productId).contractVersion,
        effectiveLevel: readiness.effectiveLevel,
        activeReleaseId: readiness.activeRelease!.id,
        sourceEvidenceDigest: readiness.activeRelease!.sourceEvidenceDigest,
      };
    })
    .sort((a, b) => a.productId.localeCompare(b.productId));
  const scopeContract = {
    schemaVersion: DATA_PRODUCT_RELEASE_SCHEMA_VERSION,
    product: {
      id: product.id,
      contractVersion: product.contractVersion,
      maxAutomation: product.maxAutomation,
      requiredSources: [...product.sources].sort(),
      requiredStreams: Object.fromEntries(
        Object.entries(product.requiredStreams)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([source, streams]) => [source, [...(streams ?? [])].sort()]),
      ),
      requiredIdentities: Object.fromEntries(
        Object.entries(product.requiredIdentities)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([source, identities]) => [source, [...(identities ?? [])].sort()]),
      ),
      identityExtractionContractVersion: CROSS_SYSTEM_IDENTITY_EXTRACTION_CONTRACT_VERSION,
      identityExtractionScope: crossSystemIdentityExtractionScope(
        product.requiredStreams as Partial<Record<CrossSystemIdentitySource, string[]>>,
        product.requiredIdentities as Partial<Record<CrossSystemIdentitySource, CrossSystemIdentityDomain[]>>,
      ),
      semanticContractVersion: CROSS_SYSTEM_SEMANTIC_CONTRACT_VERSION,
      requiredSemantics: Object.fromEntries(
        Object.entries(product.requiredSemantics)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([source, streams]) => [source, Object.fromEntries(
            Object.entries(streams ?? {})
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([stream, domains]) => [stream, [...domains].sort()]),
          )]),
      ) as DataProductDefinition["requiredSemantics"],
      semanticScope: crossSystemSemanticScope(product.requiredSemantics),
      metricLineageVersion: DATA_PRODUCT_METRIC_LINEAGE_VERSION,
      metricIds: [...product.metricIds].sort(),
      metricLineageScope: dataProductMetricLineageScope(product.id, product.metricIds),
      requiredScmEvidence: [...product.requiredScmEvidence].sort(),
      requiredProducts: [...(product.requiredProducts ?? [])]
        .sort((a, b) => a.productId.localeCompare(b.productId))
        .map((item) => ({ ...item })),
    },
    sourceBindings: [...sourceBindings].sort((a, b) => a.source.localeCompare(b.source)),
    dependencyBindings,
  };
  const envelope: EvidenceEnvelope = {
    ...scopeContract,
    capturedAt: now.toISOString(),
    runtimeLevel: runtime.level,
    runtimeReason: runtime.reason,
    sourceEvidence,
  };
  const missingDependencies = productDependencyGates.filter((item) => !item.satisfied);
  const eligible = runtime.level === "A1" && missingDependencies.length === 0;
  const dependencyGate = missingDependencies.length > 0
    ? `上游数据产品尚未满足：${missingDependencies.map((item) => `${item.title}需${item.minimumLevel}（当前${item.effectiveLevel}）`).join("；")}`
    : null;
  return {
    envelope,
    scopeDigest: digestDecisionEvidence(scopeContract),
    eligible,
    gate: eligible
      ? "实时来源门禁已达到 A1；补齐控制总量、业务 UAT、责任人审批和回滚方案后可受控升级。"
      : runtime.level !== "A1" ? runtime.reason : dependencyGate!,
  };
}

type ReleaseRow = typeof schema.dataProductReleases.$inferSelect;

function toDto(row: ReleaseRow, names: Map<number, string> = new Map()): DataProductReleaseDto {
  return {
    id: row.id,
    productId: row.productId,
    contractVersion: row.contractVersion,
    targetLevel: row.targetLevel as ReleasedAutomationLevel,
    sourceEvidenceDigest: row.sourceEvidenceDigest,
    controlTotalRef: row.controlTotalRef,
    uatRef: row.uatRef,
    rollbackPlan: row.rollbackPlan,
    scopeNote: row.scopeNote,
    status: row.status as DataProductReleaseStatus,
    requestedBy: row.requestedBy,
    requestedByName: names.get(row.requestedBy) ?? null,
    requestedAt: new Date(row.requestedAt).toISOString(),
    decidedBy: row.decidedBy,
    decidedByName: row.decidedBy == null ? null : names.get(row.decidedBy) ?? null,
    decidedAt: row.decidedAt == null ? null : new Date(row.decidedAt).toISOString(),
    decisionNote: row.decisionNote,
    revokedBy: row.revokedBy,
    revokedByName: row.revokedBy == null ? null : names.get(row.revokedBy) ?? null,
    revokedAt: row.revokedAt == null ? null : new Date(row.revokedAt).toISOString(),
    version: row.version,
  };
}

async function loadReleaseRows(db: AnyDb): Promise<DataProductReleaseDto[]> {
  const rows: ReleaseRow[] = await db
    .select()
    .from(schema.dataProductReleases)
    .orderBy(desc(schema.dataProductReleases.requestedAt), desc(schema.dataProductReleases.id));
  const userIds = [...new Set(rows.flatMap((row) => [row.requestedBy, row.decidedBy, row.revokedBy]).filter((id): id is number => id != null))];
  const users: Array<{ id: number; name: string }> = userIds.length > 0
    ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  return rows.map((row) => toDto(row, new Map(users.map((item) => [item.id, item.name]))));
}

function topologicalProducts(): DataProductDefinition[] {
  const byId = new Map(DATA_PRODUCTS.map((product) => [product.id, product]));
  const ordered: DataProductDefinition[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (product: DataProductDefinition) => {
    if (visited.has(product.id)) return;
    if (visiting.has(product.id)) throw new Error(`数据产品依赖存在循环：${product.id}`);
    visiting.add(product.id);
    for (const dependency of product.requiredProducts ?? []) {
      const upstream = byId.get(dependency.productId);
      if (!upstream) throw new Error(`数据产品 ${product.id} 引用了不存在的上游：${dependency.productId}`);
      visit(upstream);
    }
    visiting.delete(product.id);
    visited.add(product.id);
    ordered.push(product);
  };
  for (const product of DATA_PRODUCTS) visit(product);
  return ordered;
}

function computeReleaseReadiness(
  dataSources: readonly DataSourceReadiness[],
  releases: readonly DataProductReleaseDto[],
  user?: SessionUser,
): Array<{ readiness: DataProductReleaseReadiness; evidence: ReturnType<typeof buildDataProductReleaseEvidence> }> {
  const computed = new Map<string, DataProductReleaseReadiness>();
  const result: Array<{ readiness: DataProductReleaseReadiness; evidence: ReturnType<typeof buildDataProductReleaseEvidence> }> = [];
  for (const product of topologicalProducts()) {
    const dependencies = (product.requiredProducts ?? []).flatMap((dependency) => {
      const readiness = computed.get(dependency.productId);
      return readiness ? [readiness] : [];
    });
    const productDependencyGates = dependencyGates(product, dependencies);
    const evidence = buildDataProductReleaseEvidence(product, dataSources, new Date(), dependencies);
    const productRows = releases.filter((row) => row.productId === product.id);
    const activeRelease = productRows.find((row) => row.status === "approved") ?? null;
    const pendingRelease = productRows.find((row) => row.status === "pending") ?? null;
    const activeReleaseCurrent = activeRelease != null
      && evidence.eligible
      && activeRelease.contractVersion === product.contractVersion
      && activeRelease.sourceEvidenceDigest === evidence.scopeDigest
      && maxAllows(product, activeRelease.targetLevel);
    const owner = user ? hasOwnerRole(user, product) : false;
    const canDecide = pendingRelease != null
      && owner
      && user?.isApprover === true
      && pendingRelease.requestedBy !== user.id;
    const pendingEvidenceCurrent = pendingRelease != null
      && evidence.eligible
      && pendingRelease.contractVersion === product.contractVersion
      && pendingRelease.sourceEvidenceDigest === evidence.scopeDigest
      && maxAllows(product, pendingRelease.targetLevel);
    const effectiveLevel: DataProductAutomationLevel = activeReleaseCurrent
      ? activeRelease.targetLevel
      : evidence.envelope.runtimeLevel;
    const gate = activeReleaseCurrent
      ? `产品级放行有效：${activeRelease.targetLevel}；实时失败、过期、拒收、空源、上游产品或范围变化会自动降级。`
      : activeRelease
        ? "已有批准记录，但当前来源、上游产品、契约范围或产品版本已变化；已自动降回 A0/A1，需撤回旧记录后重新申请。"
        : pendingRelease
          ? pendingEvidenceCurrent
            ? "放行申请待责任人会签；会签时会再次核对实时证据、上游产品和范围指纹。"
            : "待审批申请的实时证据、上游产品、契约范围或产品版本已失效；禁止批准，只能拒绝后在门禁恢复时重新申请。"
          : evidence.gate;
    const readiness: DataProductReleaseReadiness = {
      productId: product.id,
      runtimeLevel: evidence.envelope.runtimeLevel,
      effectiveLevel,
      eligibleForRequest: evidence.eligible,
      gate,
      currentScopeDigest: evidence.scopeDigest,
      activeRelease,
      pendingRelease,
      latestRelease: productRows[0] ?? null,
      activeReleaseCurrent,
      canRequest: owner && evidence.eligible && activeRelease == null && pendingRelease == null,
      canApprove: Boolean(canDecide && pendingEvidenceCurrent),
      canReject: Boolean(canDecide),
      canRevoke: owner && activeRelease != null,
      dependencyGates: productDependencyGates,
    };
    computed.set(product.id, readiness);
    result.push({ readiness, evidence });
  }
  return result;
}

export async function loadDataProductReleaseReadiness(
  dataSources: readonly DataSourceReadiness[],
  user?: SessionUser,
  dbArg?: AnyDb,
): Promise<DataProductReleaseReadiness[]> {
  const db = await resolveDb(dbArg);
  const releases = await loadReleaseRows(db);
  return computeReleaseReadiness(dataSources, releases, user).map((item) => item.readiness);
}

async function findByIdempotency(db: AnyDb, key: string): Promise<ReleaseRow | null> {
  const [row] = await db
    .select()
    .from(schema.dataProductReleases)
    .where(eq(schema.dataProductReleases.idempotencyKey, key))
    .limit(1);
  return row ?? null;
}

export async function requestDataProductRelease(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<DataProductReleaseDto> {
  const value = requestSchema.parse(input);
  const product = getProduct(value.productId);
  requireOwnerRole(user, product);
  if (!maxAllows(product, value.targetLevel)) {
    throw new ApiError(409, `${product.title} 的自动化上限是 ${product.maxAutomation}，不能申请 ${value.targetLevel}`);
  }
  const db = await resolveDb(dbArg);
  const replay = await findByIdempotency(db, value.idempotencyKey);
  if (replay) {
    if (replay.requestedBy !== user.id) throw new ApiError(409, "幂等键已被其他申请占用");
    return toDto(replay);
  }
  const dataSources = await loadDataSourceReadiness(db);
  const releaseRows = await loadReleaseRows(db);
  const productState = computeReleaseReadiness(dataSources, releaseRows, user)
    .find((item) => item.readiness.productId === product.id)!;
  const evidence = productState.evidence;
  if (!evidence.eligible) throw new ApiError(409, `当前不能申请放行：${evidence.gate}`);

  return db.transaction(async (tx: AnyDb) => {
    const [open] = await tx
      .select({ id: schema.dataProductReleases.id, status: schema.dataProductReleases.status })
      .from(schema.dataProductReleases)
      .where(and(
        eq(schema.dataProductReleases.productId, product.id),
        inArray(schema.dataProductReleases.status, ["pending", "approved"]),
      ))
      .limit(1);
    if (open) throw new ApiError(409, open.status === "pending" ? "该数据产品已有待审批申请" : "该数据产品已有批准记录；请先撤回后再申请");
    const [created] = await tx
      .insert(schema.dataProductReleases)
      .values({
        productId: product.id,
        contractVersion: product.contractVersion,
        targetLevel: value.targetLevel,
        sourceEvidenceDigest: evidence.scopeDigest,
        sourceEvidence: evidence.envelope,
        controlTotalRef: value.controlTotalRef,
        uatRef: value.uatRef,
        rollbackPlan: value.rollbackPlan,
        scopeNote: value.scopeNote || null,
        idempotencyKey: value.idempotencyKey,
        requestedBy: user.id,
      })
      // 同时吸收幂等键冲突和「同一产品仅一条 pending/approved」的数据库级并发闸。
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const concurrent = await findByIdempotency(tx, value.idempotencyKey);
      if (concurrent) {
        if (concurrent.requestedBy !== user.id) throw new ApiError(409, "幂等键已被其他申请占用");
        return toDto(concurrent);
      }
      const [existingOpen] = await tx
        .select({ status: schema.dataProductReleases.status })
        .from(schema.dataProductReleases)
        .where(and(
          eq(schema.dataProductReleases.productId, product.id),
          inArray(schema.dataProductReleases.status, ["pending", "approved"]),
        ))
        .limit(1);
      throw new ApiError(
        409,
        existingOpen?.status === "approved"
          ? "该数据产品已有批准记录；请先撤回后再申请"
          : "该数据产品已有待审批申请",
      );
    }
    await writeAudit(tx, {
      userId: user.id,
      entity: "data_product_release",
      entityId: created.id,
      action: "request",
      after: {
        productId: product.id,
        contractVersion: product.contractVersion,
        targetLevel: value.targetLevel,
        sourceEvidenceDigest: evidence.scopeDigest,
        controlTotalRef: value.controlTotalRef,
        uatRef: value.uatRef,
      },
    });
    return toDto(created);
  });
}

export async function decideDataProductRelease(
  user: SessionUser,
  input: unknown,
  dbArg?: AnyDb,
): Promise<DataProductReleaseDto> {
  const value = decisionSchema.parse(input);
  const db = await resolveDb(dbArg);
  return db.transaction(async (tx: AnyDb) => {
    const [before]: ReleaseRow[] = await tx
      .select()
      .from(schema.dataProductReleases)
      .where(eq(schema.dataProductReleases.id, value.id))
      .limit(1);
    if (!before) throw new ApiError(404, "数据产品放行申请不存在");
    const product = getProduct(before.productId);
    requireOwnerRole(user, product);

    if (value.action === "revoke") {
      if (before.status !== "approved") throw new ApiError(409, "只有已批准的放行可撤回");
      const [updated] = await tx
        .update(schema.dataProductReleases)
        .set({
          status: "revoked",
          revokedBy: user.id,
          revokedAt: new Date(),
          decisionNote: value.note,
          version: sql`${schema.dataProductReleases.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(schema.dataProductReleases.id, before.id),
          eq(schema.dataProductReleases.status, "approved"),
          eq(schema.dataProductReleases.version, value.expectedVersion),
        ))
        .returning();
      if (!updated) throw new ApiError(409, "放行记录已变化，请刷新后重试");
      await writeAudit(tx, {
        userId: user.id,
        entity: "data_product_release",
        entityId: before.id,
        action: "revoke",
        before: { status: before.status, version: before.version },
        after: { status: updated.status, version: updated.version, note: value.note },
      });
      return toDto(updated);
    }

    if (!user.isApprover) throw new ApiError(403, "只有该数据产品责任角色中的审批人可会签");
    if (before.requestedBy === user.id) throw new ApiError(403, "发起人不能审批自己的放行申请");
    if (before.status !== "pending") throw new ApiError(409, "该放行申请已处理");
    if (before.version !== value.expectedVersion) throw new ApiError(409, "放行申请版本已变化，请刷新后重试");

    if (value.action === "approve") {
      const dataSources = await loadDataSourceReadiness(tx);
      const releaseRows = await loadReleaseRows(tx);
      const productState = computeReleaseReadiness(dataSources, releaseRows, user)
        .find((item) => item.readiness.productId === product.id)!;
      const evidence = productState.evidence;
      if (!evidence.eligible) throw new ApiError(409, `实时证据已不满足放行条件：${evidence.gate}`);
      if (before.contractVersion !== product.contractVersion || before.sourceEvidenceDigest !== evidence.scopeDigest) {
        throw new ApiError(409, "产品契约或连接范围已变化；请拒绝旧申请并重新发起");
      }
      if (!maxAllows(product, before.targetLevel as ReleasedAutomationLevel)) {
        throw new ApiError(409, "产品自动化上限已收紧；不能批准旧申请");
      }
    }

    const nextStatus = value.action === "approve" ? "approved" : "rejected";
    const [updated] = await tx
      .update(schema.dataProductReleases)
      .set({
        status: nextStatus,
        decidedBy: user.id,
        decidedAt: new Date(),
        decisionNote: value.note,
        version: sql`${schema.dataProductReleases.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.dataProductReleases.id, before.id),
        eq(schema.dataProductReleases.status, "pending"),
        eq(schema.dataProductReleases.version, value.expectedVersion),
      ))
      .returning();
    if (!updated) throw new ApiError(409, "放行申请已被其他人处理，请刷新");
    await writeAudit(tx, {
      userId: user.id,
      entity: "data_product_release",
      entityId: before.id,
      action: value.action,
      before: { status: before.status, version: before.version },
      after: { status: updated.status, version: updated.version, note: value.note },
    });
    return toDto(updated);
  });
}
