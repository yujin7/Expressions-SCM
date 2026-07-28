"use client";

import { forwardRef, useEffect, useState } from "react";
import { Button, Input } from "antd";
import type { InputRef } from "antd";
import type { SearchProps } from "antd/es/input/Search";
import { SearchOutlined } from "@ant-design/icons";

/**
 * SSR-safe replacement for Ant Design's compound Input.Search.
 *
 * Input.Search renders correctly in the browser but resolves an internal element
 * to undefined during Next.js document rendering in the current React/AntD stack.
 * Composing the stable base Input and Button components keeps first loads and
 * refreshes server-renderable while preserving the familiar search interaction.
 */
const SearchInput = forwardRef<InputRef, SearchProps>(function SearchInput(
  {
    enterButton,
    loading,
    onSearch,
    onChange,
    onPressEnter,
    value,
    defaultValue,
    className,
    style,
    disabled,
    size,
    ...inputProps
  },
  ref,
) {
  const [draft, setDraft] = useState(() => String(value ?? defaultValue ?? ""));
  const controlled = value !== undefined;

  useEffect(() => {
    if (controlled) setDraft(String(value ?? ""));
  }, [controlled, value]);

  const current = controlled ? String(value ?? "") : draft;
  const submit = (event?: React.KeyboardEvent<HTMLInputElement> | React.MouseEvent<HTMLElement>) => {
    onSearch?.(current, event);
  };
  const buttonContent =
    enterButton && enterButton !== true ? enterButton : <SearchOutlined />;

  return (
    <span
      className={["app-search-input", className].filter(Boolean).join(" ")}
      style={{ display: "inline-flex", verticalAlign: "middle", ...style }}
    >
      <Input
        {...inputProps}
        ref={ref}
        value={current}
        disabled={disabled}
        size={size}
        onChange={(event) => {
          if (!controlled) setDraft(event.target.value);
          onChange?.(event);
        }}
        onPressEnter={(event) => {
          onPressEnter?.(event);
          // Read from the input event itself: React state may not have committed
          // yet when a user types and immediately presses Enter.
          if (!event.defaultPrevented) onSearch?.(event.currentTarget.value, event);
        }}
        style={{
          minWidth: 0,
          flex: 1,
          borderStartEndRadius: 0,
          borderEndEndRadius: 0,
        }}
      />
      <Button
        aria-label={typeof inputProps.placeholder === "string" ? inputProps.placeholder : "搜索"}
        disabled={disabled}
        loading={loading}
        size={size}
        type={enterButton ? "primary" : "default"}
        onClick={(event) => submit(event)}
        style={{
          marginInlineStart: -1,
          borderStartStartRadius: 0,
          borderEndStartRadius: 0,
        }}
      >
        {buttonContent}
      </Button>
    </span>
  );
});

export default SearchInput;
