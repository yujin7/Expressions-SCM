"use client";

import { Select } from "antd";
import RemoteSelect from "./RemoteSelect";

/** Candidates are factory-scoped before server pagination, including exact selected-label lookups. */
export default function OutsourceWarehouseSelect({ supplierId, value, onChange, disabled, label }: {
  supplierId: number | null; value: number | null; onChange: (id: number | null) => void;
  disabled?: boolean; label: string;
}) {
  if (supplierId == null) return <Select aria-label={label} disabled style={{ width: "100%" }} placeholder="请先读取加工通知单的加工厂" />;
  return <RemoteSelect key={supplierId} aria-label={label}
    api={`/api/master/warehouse?outsourceSupplierId=${supplierId}`}
    style={{ width: "100%" }} value={value} disabled={disabled} allowClear
    placeholder={`选择${label}（该厂启用的实时委外仓）`}
    getLabel={row => `${String(row.code)}｜${String(row.name)}`}
    filterRow={row => row.supplierId === supplierId && row.kind === "outsource" && row.accountingMode === "realtime" && row.active === true}
    onChange={(id: number | undefined) => onChange(id ?? null)} />;
}
