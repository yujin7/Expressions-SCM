/**
 * 上游删除墓碑：登记 / 撤销 / 列表。
 *
 * 为什么是管理员专属写路径：签一条墓碑等于放行数据基线的一次收缩
 * （同步据此接受一个比上一批更少行的观察批次）。角色门与审计在服务层
 * （`integrations/deletion-ack.ts`）；这里只做会话回查、入参校验与错误边界。
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse, guardRead, readJson } from "@/server/modules/master/common";
import { guardFreshWrite } from "@/server/modules/outsource/common";
import {
  ackRecordDeletion, listRecordDeletions, revokeRecordDeletionAck,
} from "@/server/integrations/deletion-ack";

const ackSchema = z.object({
  connector: z.string().min(1),
  stream: z.string().min(1),
  sourceRecordId: z.string().min(1),
  reason: z.string().min(4),
});

export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { searchParams } = new URL(req.url);
    const connector = searchParams.get("connector") ?? "jdy";
    const stream = searchParams.get("stream") ?? undefined;
    return NextResponse.json({ rows: await listRecordDeletions(connector, stream) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const parsed = ackSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "请求体须包含 connector / stream / sourceRecordId / reason（依据至少 4 个字）" },
        { status: 400 },
      );
    }
    return NextResponse.json(await ackRecordDeletion(user, parsed.data), { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await guardFreshWrite();
    const id = Number(new URL(req.url).searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: "id 须为正整数" }, { status: 400 });
    }
    await revokeRecordDeletionAck(user, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
