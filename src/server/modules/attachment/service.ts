import { createHash } from "node:crypto";
import { storageDir } from "@/server/core/storage";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { desc, eq, and } from "drizzle-orm";
import { z } from "zod";
import { fileMetas, qcRecords, shDocs, skus, suppliers, users } from "@/db/schema";
import { writeAudit } from "@/server/core/audit";
import type { SessionUser } from "@/server/core/dto";
import { ApiError } from "@/server/modules/master/common";
import { type AnyDb, requireAnyRole, resolveDb } from "@/server/modules/outsource/common";

/**
 * 附件线（F-011 P0 多图上传 / QC 照片证据链 / 供应商证照影像）：
 * - 落盘 ATTACH_ROOT（默认 uploads/attachments/）/<entity>/<entityId>/<uuid>-<清洗后原名>；
 *   file_metas.path 存相对 ATTACH_ROOT 的路径，便于根目录迁移与测试隔离。
 * - 约束：图片 jpg/png/webp ≤10MB（全实体）；supplier 另允许 pdf ≤20MB（证照/检测报告）。
 * - 下载仅经鉴权路由（GET /api/attachments/[id]/file），uploads/ 不做静态托管。
 * - file_metas 无软删标记 → 删除为硬删行 + 尽力 unlink；stock 无关，不走过账。
 */

export const ATTACH_ENTITIES = ["sku", "supplier", "qc", "sh"] as const;
export type AttachEntity = (typeof ATTACH_ENTITIES)[number];

export const attachEntitySchema = z.object({
  entity: z.enum(ATTACH_ENTITIES, { errorMap: () => ({ message: "未知附件实体" }) }),
  entityId: z.coerce.number().int().positive({ message: "无效的业务 ID" }),
});

/** 写角色映射（admin 由 requireAnyRole 兜底放行） */
const WRITE_ROLES: Record<AttachEntity, string[]> = {
  sku: ["pmc"],
  supplier: ["purchasing"],
  qc: ["warehouse"],
  sh: ["warehouse"],
};

const IMAGE_MIMES: Record<string, string> = {
  "image/jpeg": "jpg/jpeg",
  "image/png": "png",
  "image/webp": "webp",
};
const PDF_MIME = "application/pdf";
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_PDF_SIZE = 20 * 1024 * 1024; // 20MB
const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;
const PDF_EXT_RE = /\.pdf$/i;

/** 附件根目录：落盘根走 core/storage（生产=挂载卷）；测试经 ATTACH_ROOT 指向临时目录 */
export function attachRoot(): string {
  return process.env.ATTACH_ROOT || storageDir("attachments");
}

/** 流式下载的 Content-Type 按扩展名推导（file_metas 无 mime 列） */
export function mimeOf(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

/** 上传文件的最小接口（浏览器 File / Node File 均满足；便于测试） */
export interface UploadFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

async function requireEntityExists(db: AnyDb, entity: AttachEntity, entityId: number): Promise<void> {
  const table =
    entity === "sku" ? skus : entity === "supplier" ? suppliers : entity === "qc" ? qcRecords : shDocs;
  const rows: { id: number }[] = await db
    .select({ id: table.id })
    .from(table)
    .where(eq(table.id, entityId))
    .limit(1);
  if (rows.length === 0) {
    const label = { sku: "SKU", supplier: "供应商", qc: "检验记录", sh: "收货单" }[entity];
    throw new ApiError(404, `${label}不存在（ID ${entityId}）`);
  }
}

function validateFile(entity: AttachEntity, file: UploadFile): void {
  const isImage = file.type in IMAGE_MIMES && IMAGE_EXT_RE.test(file.name);
  const isPdf = file.type === PDF_MIME && PDF_EXT_RE.test(file.name);
  if (isImage) {
    if (file.size > MAX_IMAGE_SIZE) throw new ApiError(400, "图片超过 10MB 限制");
    return;
  }
  if (isPdf) {
    if (entity !== "supplier") throw new ApiError(400, "PDF 仅供应商证照/检测报告可上传");
    if (file.size > MAX_PDF_SIZE) throw new ApiError(400, "PDF 超过 20MB 限制");
    return;
  }
  throw new ApiError(
    400,
    entity === "supplier" ? "仅支持 jpg/png/webp 图片或 pdf 文件" : "仅支持 jpg/png/webp 图片",
  );
}

export interface AttachmentDto {
  id: number;
  entity: string;
  entityId: number;
  filename: string;
  mime: string;
  uploadedBy: number | null;
  uploadedByName: string | null;
  createdAt: string;
  url: string;
}

type FileMetaRow = typeof fileMetas.$inferSelect;

function toDto(r: FileMetaRow, uploaderName: string | null): AttachmentDto {
  return {
    id: r.id,
    entity: r.bizType,
    entityId: r.bizId,
    filename: r.filename,
    mime: mimeOf(r.filename),
    uploadedBy: r.uploadedBy,
    uploadedByName: uploaderName,
    createdAt: (r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt)).toISOString(),
    url: `/api/attachments/${r.id}/file`,
  };
}

export async function uploadAttachment(
  user: SessionUser,
  input: { entity: unknown; entityId: unknown; file: UploadFile },
  dbArg?: AnyDb,
): Promise<AttachmentDto> {
  const { entity, entityId } = attachEntitySchema.parse({ entity: input.entity, entityId: input.entityId });
  requireAnyRole(user, ...WRITE_ROLES[entity]);
  const db = await resolveDb(dbArg);
  await requireEntityExists(db, entity, entityId);
  validateFile(entity, input.file);

  // 原名清洗防路径穿越（同 import/upload 纪律：basename + 白名单），过长截断保留扩展名
  const ext = path.extname(input.file.name).toLowerCase();
  const base = path
    .basename(input.file.name, path.extname(input.file.name))
    .replace(/[^\w.\-一-龥（）()【】]/g, "_")
    .slice(0, 80);
  const safeName = `${base || "file"}${ext.replace(/[^\w.]/g, "")}`;
  const relPath = path.posix.join(entity, String(entityId), `${globalThis.crypto.randomUUID()}-${safeName}`);

  const buf = Buffer.from(await input.file.arrayBuffer());
  const absPath = path.join(attachRoot(), relPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, buf);

  const [row]: FileMetaRow[] = await db
    .insert(fileMetas)
    .values({
      bizType: entity,
      bizId: entityId,
      filename: safeName,
      path: relPath,
      hash: createHash("sha256").update(buf).digest("hex"),
      uploadedBy: user.id,
    })
    .returning();
  await writeAudit(db, {
    userId: user.id,
    entity: "attachment",
    entityId: row.id,
    action: "upload",
    after: { bizType: entity, bizId: entityId, file: safeName, size: input.file.size },
  });
  return toDto(row, user.name);
}

export async function listAttachments(
  entity: unknown,
  entityId: unknown,
  dbArg?: AnyDb,
): Promise<AttachmentDto[]> {
  const v = attachEntitySchema.parse({ entity, entityId });
  const db = await resolveDb(dbArg);
  const rows: { meta: FileMetaRow; uploaderName: string | null }[] = await db
    .select({ meta: fileMetas, uploaderName: users.name })
    .from(fileMetas)
    .leftJoin(users, eq(fileMetas.uploadedBy, users.id))
    .where(and(eq(fileMetas.bizType, v.entity), eq(fileMetas.bizId, v.entityId)))
    .orderBy(desc(fileMetas.id));
  return rows.map((r) => toDto(r.meta, r.uploaderName));
}

/** 下载用：取行 + 解析绝对路径（防越界）；404 由路由层按 null 处理 */
export async function getAttachmentFile(
  id: number,
  dbArg?: AnyDb,
): Promise<{ meta: FileMetaRow; data: Buffer } | null> {
  const db = await resolveDb(dbArg);
  const rows: FileMetaRow[] = await db.select().from(fileMetas).where(eq(fileMetas.id, id)).limit(1);
  const meta = rows[0];
  if (!meta) return null;
  const root = path.resolve(attachRoot());
  const abs = path.resolve(root, meta.path);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null; // 防历史脏数据越界
  try {
    return { meta, data: await readFile(abs) };
  } catch {
    return null; // 磁盘文件缺失 → 404
  }
}

export async function deleteAttachment(user: SessionUser, id: number, dbArg?: AnyDb): Promise<void> {
  const db = await resolveDb(dbArg);
  const rows: FileMetaRow[] = await db.select().from(fileMetas).where(eq(fileMetas.id, id)).limit(1);
  const meta = rows[0];
  if (!meta) throw new ApiError(404, "附件不存在");
  if (meta.uploadedBy !== user.id && !user.roles.includes("admin")) {
    throw new ApiError(403, "仅上传人或管理员可删除附件");
  }
  await db.delete(fileMetas).where(eq(fileMetas.id, id));
  await writeAudit(db, {
    userId: user.id,
    entity: "attachment",
    entityId: id,
    action: "delete",
    before: { bizType: meta.bizType, bizId: meta.bizId, file: meta.filename, path: meta.path },
  });
  // 尽力 unlink（失败不回滚业务删除；文件残留可由巡检清理）
  const root = path.resolve(attachRoot());
  const abs = path.resolve(root, meta.path);
  if (abs === root || !abs.startsWith(root + path.sep)) return;
  try {
    await unlink(abs);
  } catch {
    /* best-effort */
  }
}
