import SupplierClient from "./supplier-client";

export default async function SupplierPage({ searchParams }: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { q } = await searchParams;
  const initialQuery = (Array.isArray(q) ? q[0] ?? "" : q ?? "").trim();
  return <SupplierClient initialQuery={initialQuery} />;
}
