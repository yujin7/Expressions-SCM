import Sku360Client from "./sku-360-client";

export const metadata = { title: "SKU 360" };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ sku?: string; q?: string }>;
}) {
  const params = await searchParams;
  return <Sku360Client initialSku={(params.sku ?? params.q ?? "").trim()} />;
}
