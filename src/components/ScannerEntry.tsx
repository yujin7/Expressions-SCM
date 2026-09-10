"use client";

import { BarcodeOutlined } from "@ant-design/icons";
import { Input, InputNumber, Typography } from "antd";
import type { InputRef } from "antd";
import { useEffect, useRef, useState } from "react";

interface ScannerEntryProps {
  disabled?: boolean;
  help: string;
  onScan: (code: string, qty: string) => boolean;
}

export default function ScannerEntry({ disabled = false, help, onScan }: ScannerEntryProps) {
  const inputRef = useRef<InputRef>(null);
  const [code, setCode] = useState("");
  const [qty, setQty] = useState("1");

  useEffect(() => {
    if (!disabled) inputRef.current?.focus({ cursor: "all" });
  }, [disabled]);

  const submit = () => {
    const trimmed = code.trim();
    const validQty = /^\d+(\.\d+)?$/.test(qty) && !/^0+(\.0+)?$/.test(qty);
    if (!trimmed || !validQty) {
      inputRef.current?.focus({ cursor: "all" });
      return;
    }
    if (onScan(trimmed, qty)) setCode("");
    requestAnimationFrame(() => inputRef.current?.focus({ cursor: "all" }));
  };

  return (
    <div
      style={{
        padding: "10px 12px",
        border: "1px solid #d9e2f0",
        borderRadius: 8,
        background: "#f7faff",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 }}>
        <Input
          ref={inputRef}
          allowClear
          disabled={disabled}
          prefix={<BarcodeOutlined />}
          placeholder="扫描条码或输入 SKU 编码后回车"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          onPressEnter={submit}
          style={{ flex: "1 1 260px", minWidth: 0, width: "100%" }}
          aria-label="扫码输入"
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <Typography.Text type="secondary">每次计入</Typography.Text>
          <InputNumber<string>
            stringMode
            min="0.0001"
            precision={4}
            disabled={disabled}
            value={qty}
            onChange={(value) => setQty(value ?? "1")}
            onPressEnter={submit}
            style={{ width: 110 }}
            aria-label="每次扫码数量"
          />
        </div>
      </div>
      <Typography.Text type="secondary" style={{ display: "block", marginTop: 6, fontSize: 12 }}>
        {help}
      </Typography.Text>
    </div>
  );
}
