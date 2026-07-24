import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLogs, fileMetas, qcRecords, shDocs, skus, spus, suppliers, users, warehouses } from "@/db/schema";
import type { SessionUser } from "@/server/core/dto";
import {
  deleteAttachment, getAttachmentFile, listAttachments, uploadAttachment,
} from "@/server/modules/attachment/service";
import { createTestDb, type TestDb } from "../helpers/db";

/**
 * 附件线（F-011 多图上传 / QC 照片证据链 / 供应商证照）：
 * 上传/列表/删除快乐路径 + 实体不存在 + 超限 + 非法类型 + 非上传人删除拒绝 + 角色映射。
 * ATTACH_ROOT 指向临时目录——不写仓库 uploads/。
 */

function mkFile(name: string, mime: string, bytes: number): File {
  return new File([new Uint8Array(bytes).fill(7)], name, { type: mime });
}

describe("附件 service：上传/列表/下载/删除", () => {
  let db: TestDb;
  let root = "";
  let prevRoot: string | undefined;

  let pmc: SessionUser;
  let purchasing: SessionUser;
  let wh: SessionUser;
  let admin: SessionUser;

  let skuId = 0;
  let supplierId = 0;
  let shId = 0;
  let qcId = 0;

  beforeAll(async () => {
    ({ db } = await createTestDb());
    prevRoot = process.env.ATTACH_ROOT;
    root = await mkdtemp(path.join(tmpdir(), "attach-test-"));
    process.env.ATTACH_ROOT = root;

    const mkUser = async (name: string, roles: string[]): Promise<SessionUser> => {
      const [u] = await db.insert(users).values({ name, roles, isApprover: false }).returning();
      return { id: u.id, name: u.name, roles, isApprover: false };
    };
    pmc = await mkUser("计划员", ["pmc"]);
    purchasing = await mkUser("采购员", ["purchasing"]);
    wh = await mkUser("仓管员", ["warehouse"]);
    admin = await mkUser("管理员", ["admin"]);

    const [spu] = await db.insert(spus).values({ code: "P00001", nameCn: "测试产品" }).returning();
    const [sku] = await db
      .insert(skus)
      .values({ code: "CP00001", name: "成品A", spuId: spu.id, skuType: "finished", baseUom: "盒" })
      .returning();
    skuId = sku.id;

    const [sup] = await db
      .insert(suppliers)
      .values({ code: "SUP001", name: "供应商A", kinds: ["raw"], status: "qualified" })
      .returning();
    supplierId = sup.id;

    const [whRow] = await db
      .insert(warehouses)
      .values({ code: "WH01", name: "成品仓", kind: "finished", accountingMode: "realtime" })
      .returning();
    const [sh] = await db
      .insert(shDocs)
      .values({
        docNo: "SH-T-0001", status: "approved", sourceType: "po", sourceId: 1,
        warehouseId: whRow.id, createdBy: wh.id,
      })
      .returning();
    shId = sh.id;
    const [qc] = await db.insert(qcRecords).values({ shId: sh.id, createdBy: wh.id }).returning();
    qcId = qc.id;
  });

  afterAll(async () => {
    if (prevRoot === undefined) delete process.env.ATTACH_ROOT;
    else process.env.ATTACH_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  });

  it("1) sku 图片上传快乐路径：落盘 + file_metas + 审计 + 列表 url", async () => {
    const dto = await uploadAttachment(
      pmc,
      { entity: "sku", entityId: skuId, file: mkFile("主图 (1).jpg", "image/jpeg", 1024) },
      db,
    );
    expect(dto.entity).toBe("sku");
    expect(dto.entityId).toBe(skuId);
    expect(dto.mime).toBe("image/jpeg");
    expect(dto.url).toBe(`/api/attachments/${dto.id}/file`);

    // 落盘在 ATTACH_ROOT/sku/<id>/ 下
    const dir = path.join(root, "sku", String(skuId));
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect((await stat(path.join(dir, files[0]))).size).toBe(1024);
    // 原名清洗：空格/括号进白名单化，且带 uuid 前缀防覆盖
    expect(files[0]).toMatch(/-主图_（1）\.jpg$|-主图_\(1\)\.jpg$/);

    const metas = await db.select().from(fileMetas).where(eq(fileMetas.id, dto.id));
    expect(metas).toHaveLength(1);
    expect(metas[0].bizType).toBe("sku");
    expect(metas[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(metas[0].uploadedBy).toBe(pmc.id);

    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "attachment"));
    expect(audits.some((a) => a.action === "upload" && a.entityId === dto.id)).toBe(true);

    const list = await listAttachments("sku", skuId, db);
    expect(list).toHaveLength(1);
    expect(list[0].uploadedByName).toBe("计划员");

    const file = await getAttachmentFile(dto.id, db);
    expect(file).not.toBeNull();
    expect(file!.data.byteLength).toBe(1024);
  });

  it("2) supplier 允许 pdf ≤20MB；qc/sh 由 warehouse 上传", async () => {
    const pdf = await uploadAttachment(
      purchasing,
      { entity: "supplier", entityId: supplierId, file: mkFile("营业执照.pdf", "application/pdf", 2048) },
      db,
    );
    expect(pdf.mime).toBe("application/pdf");

    const qcPhoto = await uploadAttachment(
      wh,
      { entity: "qc", entityId: qcId, file: mkFile("qc1.png", "image/png", 100) },
      db,
    );
    expect(qcPhoto.entity).toBe("qc");
    const shPhoto = await uploadAttachment(
      wh,
      { entity: "sh", entityId: shId, file: mkFile("sh1.webp", "image/webp", 100) },
      db,
    );
    expect(shPhoto.entity).toBe("sh");
  });

  it("3) 业务实体不存在 → 404；未知实体 → 校验失败", async () => {
    await expect(
      uploadAttachment(pmc, { entity: "sku", entityId: 999999, file: mkFile("a.jpg", "image/jpeg", 10) }, db),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      uploadAttachment(admin, { entity: "warehouse", entityId: 1, file: mkFile("a.jpg", "image/jpeg", 10) }, db),
    ).rejects.toThrow(/未知附件实体/);
  });

  it("4) 超限拒绝：图片 >10MB；supplier pdf >20MB", async () => {
    await expect(
      uploadAttachment(
        pmc,
        { entity: "sku", entityId: skuId, file: mkFile("big.jpg", "image/jpeg", 10 * 1024 * 1024 + 1) },
        db,
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("10MB") });
    await expect(
      uploadAttachment(
        purchasing,
        { entity: "supplier", entityId: supplierId, file: mkFile("big.pdf", "application/pdf", 20 * 1024 * 1024 + 1) },
        db,
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("20MB") });
  });

  it("5) 非法类型拒绝：pdf 仅 supplier；mime/扩展名不符拒绝", async () => {
    await expect(
      uploadAttachment(pmc, { entity: "sku", entityId: skuId, file: mkFile("报告.pdf", "application/pdf", 10) }, db),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      uploadAttachment(pmc, { entity: "sku", entityId: skuId, file: mkFile("a.txt", "text/plain", 10) }, db),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("jpg/png/webp") });
    // 扩展名与 mime 不一致（.exe 伪装 image/jpeg）也拒
    await expect(
      uploadAttachment(pmc, { entity: "sku", entityId: skuId, file: mkFile("a.exe", "image/jpeg", 10) }, db),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("6) 写角色映射：sku→pmc、supplier→purchasing、qc|sh→warehouse（admin 兜底）", async () => {
    const img = () => mkFile("x.jpg", "image/jpeg", 10);
    await expect(
      uploadAttachment(wh, { entity: "sku", entityId: skuId, file: img() }, db),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      uploadAttachment(pmc, { entity: "supplier", entityId: supplierId, file: img() }, db),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      uploadAttachment(purchasing, { entity: "qc", entityId: qcId, file: img() }, db),
    ).rejects.toMatchObject({ status: 403 });
    // admin 全通
    const dto = await uploadAttachment(admin, { entity: "sh", entityId: shId, file: img() }, db);
    await deleteAttachment(admin, dto.id, db);
  });

  it("7) 删除：非上传人非 admin 拒绝；上传人可删（行删 + 文件清理）；admin 可删他人", async () => {
    const dto = await uploadAttachment(
      pmc,
      { entity: "sku", entityId: skuId, file: mkFile("del.jpg", "image/jpeg", 10) },
      db,
    );
    await expect(deleteAttachment(wh, dto.id, db)).rejects.toMatchObject({ status: 403 });

    await deleteAttachment(pmc, dto.id, db);
    expect(await db.select().from(fileMetas).where(eq(fileMetas.id, dto.id))).toHaveLength(0);
    expect(await getAttachmentFile(dto.id, db)).toBeNull();
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.entity, "attachment"));
    expect(audits.some((a) => a.action === "delete" && a.entityId === dto.id)).toBe(true);

    // admin 删他人上传
    const dto2 = await uploadAttachment(
      wh,
      { entity: "qc", entityId: qcId, file: mkFile("del2.png", "image/png", 10) },
      db,
    );
    await deleteAttachment(admin, dto2.id, db);
    expect(await db.select().from(fileMetas).where(eq(fileMetas.id, dto2.id))).toHaveLength(0);

    // 删不存在 → 404
    await expect(deleteAttachment(admin, 999999, db)).rejects.toMatchObject({ status: 404 });
  });
});
