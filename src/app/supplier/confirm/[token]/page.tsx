import SupplierConfirmClient from "./confirm-client";

export const metadata = { title: "采购单确认" };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SupplierConfirmClient token={token} />;
}
