"use client";

/** 列表页统一工具条（E6-P1）：自定义筛选插槽 + 密度 / 视图 / 复制链接 / 重置 / 导出 */
import { useState } from "react";
import { App, Button, ConfigProvider, Dropdown, Input, Modal, Space, Typography } from "antd";
import {
  AppstoreOutlined,
  ColumnHeightOutlined,
  CopyOutlined,
  DownloadOutlined,
  UndoOutlined,
} from "@ant-design/icons";
import type { MenuProps } from "antd";
import type { Density, ListState } from "@/components/useListState";

const DENSITY_LABEL: Record<Density, string> = {
  default: "宽松",
  middle: "适中",
  small: "紧凑",
};

interface Props<F extends Record<string, string | undefined>> {
  state: ListState<F>;
  /** 页面自定义筛选控件 */
  extra?: React.ReactNode;
  /** 页面级主操作；与列表工具同带展示，避免重复工具栏和无效留白 */
  primaryActions?: React.ReactNode;
  /** 传入即显示「导出」按钮 */
  onExport?: () => void;
  /** 导出按钮文案（默认「导出 CSV」） */
  exportText?: string;
}

export default function ListToolbar<F extends Record<string, string | undefined>>({
  state,
  extra,
  primaryActions,
  onExport,
  exportText = "导出 CSV",
}: Props<F>) {
  const { message } = App.useApp();
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState("");

  const densityItems: MenuProps["items"] = (["default", "middle", "small"] as Density[]).map((d) => ({
    key: `density:${d}`,
    label: d === state.density ? `${DENSITY_LABEL[d]} ✓` : DENSITY_LABEL[d],
  }));

  const utilityItems: MenuProps["items"] = [
    {
      key: "__density",
      icon: <ColumnHeightOutlined />,
      label: `表格密度 · ${DENSITY_LABEL[state.density]}`,
      children: densityItems,
    },
    {
      key: "__views",
      icon: <AppstoreOutlined />,
      label: `已保存视图 · ${state.savedViews.length}`,
      children: state.savedViews.length === 0
        ? [{ key: "__empty", disabled: true, label: <Typography.Text type="secondary">暂无已保存视图</Typography.Text> }]
        : state.savedViews.map((v) => ({
            key: `view:${v.name}`,
            label: (
              <Space size={8} style={{ display: "flex", justifyContent: "space-between", minWidth: 160 }}>
                <span>{v.name}</span>
                <a
                  style={{ fontSize: 12 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    state.deleteView(v.name);
                    message.success(`已删除视图「${v.name}」`);
                  }}
                >
                  删除
                </a>
              </Space>
            ),
          })),
    },
    { type: "divider" as const },
    { key: "__save", icon: <AppstoreOutlined />, label: "保存当前视图…" },
    { key: "__copy", icon: <CopyOutlined />, label: "复制当前视图链接" },
    { key: "__reset", icon: <UndoOutlined />, label: "重置筛选与分页" },
  ];

  const onUtilityClick: MenuProps["onClick"] = ({ key }) => {
    if (key.startsWith("density:")) {
      state.setDensity(key.slice("density:".length) as Density);
      return;
    }
    if (key === "__save") {
      setViewName("");
      setSaveOpen(true);
      return;
    }
    if (key === "__copy") {
      void copyLink();
      return;
    }
    if (key === "__reset") {
      state.resetFilters();
      return;
    }
    if (key.startsWith("view:")) {
      const name = key.slice(5);
      const target = state.savedViews.find((v) => v.name === name);
      if (target) {
        state.applyView(target.query);
        message.success(`已应用视图「${name}」`);
      }
    }
  };

  const doSave = () => {
    const name = viewName.trim();
    if (!name) {
      message.warning("请输入视图名称");
      return;
    }
    state.saveView(name);
    setSaveOpen(false);
    message.success(`已保存视图「${name}」`);
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(state.shareUrl());
      message.success("已复制当前视图链接");
    } catch {
      message.error("复制失败，请手动复制地址栏链接");
    }
  };

  return (
    <>
      <ConfigProvider componentSize="small">
        <div
          className={`list-toolbar${extra ? "" : " list-toolbar--actions-only"}`}
          role="toolbar"
          aria-label="列表工具"
        >
          {extra ? <div className="list-toolbar__filters">{extra}</div> : null}
          <div className="list-toolbar__right">
            <div className="list-toolbar__actions">
              <Dropdown
                trigger={["click"]}
                menu={{ items: utilityItems, onClick: onUtilityClick }}
              >
                <Button
                  icon={<AppstoreOutlined />}
                  aria-label={`列表视图与显示；当前密度 ${DENSITY_LABEL[state.density]}；已保存 ${state.savedViews.length} 个视图`}
                  title="列表视图与显示"
                >
                  <span className="list-toolbar__utility-label">视图</span>
                  <span className="list-toolbar__utility-value">· {state.savedViews.length} ▾</span>
                </Button>
              </Dropdown>
              {onExport ? (
                <Button
                  icon={<DownloadOutlined />}
                  aria-label={exportText}
                  title={exportText}
                  onClick={onExport}
                >
                  <span className="list-toolbar__utility-label">{exportText}</span>
                </Button>
              ) : null}
            </div>
            {primaryActions ? (
              <div className="list-toolbar__primary-actions">{primaryActions}</div>
            ) : null}
          </div>
        </div>
      </ConfigProvider>
      <Modal
        title="保存当前视图"
        open={saveOpen}
        onOk={doSave}
        onCancel={() => setSaveOpen(false)}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          视图保存当前的筛选与分页（本机可见，最多 20 条，同名覆盖）。
        </Typography.Paragraph>
        <Input
          autoFocus
          value={viewName}
          maxLength={30}
          placeholder="如：待处置·报废评审"
          onChange={(e) => setViewName(e.target.value)}
          onPressEnter={doSave}
        />
      </Modal>
    </>
  );
}
