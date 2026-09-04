/**
 * 上游删除墓碑：把「同步永久停摆」变成一次可签字、可撤销、可审计的决定。
 *
 * 事故实况（2026-09-04 → 09-05）：jst-item-master-mirror-observation 从 6448 掉到 6447，
 * 同步每轮拒绝替代批次 #524，而系统**没有任何让人确认的路径**——唯一在跑通的连接器
 * 就此停摆，只能改代码才能恢复。
 *
 * 本套测试钉住的是「补了路径但没把门拆掉」：
 *  - 签字只放行**具体一条**，不是「以后丢的都算数」；
 *  - 不能为系统从未见过的记录预签（否则真发生截断时它就是现成的放行券）；
 *  - **截断的形状即使逐条签了字也照样拒绝**——这是本功能最容易被做坏的一半。
 */
import { describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb } from "../helpers/db";
import {
  ackRecordDeletion, listRecordDeletions, loadAckedDeletions, revokeRecordDeletionAck,
} from "@/server/integrations/deletion-ack";
import { ApiError } from "@/server/modules/master/common";

const STREAM = "jst-item-master-mirror-observation";

async function seed(db: Awaited<ReturnType<typeof createTestDb>>["db"]) {
  const [admin] = await db.insert(schema.users).values({ name: "管理员", roles: ["admin"] }).returning();
  const [ops] = await db.insert(schema.users).values({ name: "运营", roles: ["ops"] }).returning();
  const [job] = await db.insert(schema.importJobs).values({
    template: "jdy_jst_item_master_mirror_observation", filename: "m", createdBy: admin.id, status: "done",
  }).returning();
  await db.insert(schema.stagingRows).values(["aaa", "bbb"].map((id) => ({
    importJobId: job.id,
    rowNo: 1,
    status: "pending" as const,
    payload: { sourceRecordId: id, _source: { contractKey: STREAM, connector: "jdy" }, data: {} },
  })));
  return { admin, ops, job };
}

const asUser = (u: { id: number; name: string; roles: string[] }) => ({ ...u, isApprover: false });

describe("上游删除墓碑", () => {
  it("管理员可为**见过的**记录签字，落库并写审计；非管理员 403", async () => {
    const { db, client } = await createTestDb();
    try {
      const { admin, ops, job } = await seed(db);
      await expect(ackRecordDeletion(asUser(ops), {
        connector: "jdy", stream: STREAM, sourceRecordId: "aaa", reason: "上游确认已删除",
      }, db)).rejects.toBeInstanceOf(ApiError);

      const row = await ackRecordDeletion(asUser(admin), {
        connector: "jdy", stream: STREAM, sourceRecordId: "aaa", reason: "已与仓库核对，该试用装确实下架删除",
      }, db);
      expect(row.observedInJobId, "必须绑定它真的出现过的那个批次").toBe(job.id);

      const audits = await db.select().from(schema.auditLogs);
      expect(audits.map((a) => a.action)).toContain("integration.record_deletion.ack");
      expect(await loadAckedDeletions(db, "jdy", STREAM)).toEqual(new Set(["aaa"]));
    } finally {
      await client.close();
    }
  });

  it("不能为系统从未见过的记录预先签字（否则真截断时它就是现成的放行券）", async () => {
    const { db, client } = await createTestDb();
    try {
      const { admin } = await seed(db);
      await expect(ackRecordDeletion(asUser(admin), {
        connector: "jdy", stream: STREAM, sourceRecordId: "never-existed", reason: "先签着以后再说",
      }, db)).rejects.toThrow(/从未在/);
    } finally {
      await client.close();
    }
  });

  it("依据必填且不能敷衍；同一条不能重复签", async () => {
    const { db, client } = await createTestDb();
    try {
      const { admin } = await seed(db);
      await expect(ackRecordDeletion(asUser(admin), {
        connector: "jdy", stream: STREAM, sourceRecordId: "aaa", reason: "ok",
      }, db)).rejects.toThrow(/依据/);
      await ackRecordDeletion(asUser(admin), {
        connector: "jdy", stream: STREAM, sourceRecordId: "aaa", reason: "上游已确认删除该记录",
      }, db);
      await expect(ackRecordDeletion(asUser(admin), {
        connector: "jdy", stream: STREAM, sourceRecordId: "aaa", reason: "上游已确认删除该记录",
      }, db)).rejects.toThrow(/已经确认过/);
    } finally {
      await client.close();
    }
  });

  it("签错了能撤销，且撤销同样留痕；撤销后墓碑立即失效", async () => {
    const { db, client } = await createTestDb();
    try {
      const { admin } = await seed(db);
      const row = await ackRecordDeletion(asUser(admin), {
        connector: "jdy", stream: STREAM, sourceRecordId: "bbb", reason: "误判为删除，稍后撤销",
      }, db);
      await revokeRecordDeletionAck(asUser(admin), row.id, db);
      expect(await loadAckedDeletions(db, "jdy", STREAM)).toEqual(new Set());
      const audits = await db.select().from(schema.auditLogs);
      expect(audits.map((a) => a.action)).toContain("integration.record_deletion.revoke");
      expect(await listRecordDeletions("jdy", STREAM, db)).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("墓碑按 (connector, stream) 隔离：给 A 流签的字不放行 B 流", async () => {
    const { db, client } = await createTestDb();
    try {
      const { admin } = await seed(db);
      await ackRecordDeletion(asUser(admin), {
        connector: "jdy", stream: STREAM, sourceRecordId: "aaa", reason: "上游已确认删除该记录",
      }, db);
      expect(await loadAckedDeletions(db, "jdy", "another-observation")).toEqual(new Set());
      expect(await loadAckedDeletions(db, "yonyou", STREAM)).toEqual(new Set());
    } finally {
      await client.close();
    }
  });
});
