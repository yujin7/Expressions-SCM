import { NextRequest, NextResponse } from "next/server";
import { errorResponse, guardRead, parseListQuery } from "@/server/modules/master/common";
import { getDuplicateCandidates } from "@/server/modules/report/data-health";

/**
 * 疑似重复主档候选（只读）。
 * 健康度回答「缺什么」，本端点回答「多了什么」。只产出候选，不做任何合并。
 */
export async function GET(req: NextRequest) {
  try {
    await guardRead();
    const { q, page, pageSize, searchParams } = parseListQuery(req.url);
    // 默认含跨品牌簇；crossBrand=0 时只看同品牌（更可能是真重复）
    const crossBrandParam = searchParams.get("crossBrand");
    const crossBrand = crossBrandParam === null ? undefined : crossBrandParam !== "0";
    const thresholdRaw = Number(searchParams.get("threshold"));
    const threshold = Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? thresholdRaw : undefined;
    const exactOnly = searchParams.get("exactOnly") === "1";
    const data = await getDuplicateCandidates({ q, crossBrand, exactOnly, page, pageSize, threshold });
    return NextResponse.json(data);
  } catch (e) {
    return errorResponse(e);
  }
}
