/**
 * dsh-mindmap — 连线属性抽屉（Client 半区）。
 *
 * 和节点属性面板同一个抽屉区、同一套视觉，只是操作对象是**线**：
 * 线型、粗细、颜色。
 *
 * 为什么不用画布上的浮动小按钮：SVG 里的 <text> 命中区太小，
 * 而且会被连线本体和节点盖住（实测点了没反应）。抽屉是 HTML，
 * 命中区稳定，也和"节点属性在右边"形成一致的肌肉记忆。
 */

import * as React from "react";

import type { MindmapStore, ViewState } from "./store.ts";

/** 连线可选颜色（和节点配色分开：线要更克制，避免抢主体）。 */
const EDGE_COLORS: Array<{ key: string; label: string; value: string | undefined }> = [
  { key: "default", label: "默认", value: undefined },
  { key: "blue", label: "蓝", value: "#4a7dff" },
  { key: "green", label: "绿", value: "#1f9d55" },
  { key: "orange", label: "橙", value: "#e08a1e" },
  { key: "red", label: "红", value: "#d64545" },
  { key: "gray", label: "灰", value: "#9a9a9a" },
];

/** 粗细档位。 */
const EDGE_WIDTHS = [1, 2, 3];

interface EdgePanelProps {
  store: MindmapStore;
  state: ViewState;
  /** 正在编辑的是父子连线（有 toId）还是自由连线（有 id）。 */
  kind: "tree" | "free";
  /** 父子连线：子节点 id；自由连线：连线 id。 */
  targetId: string;
  style?: "solid" | "dashed";
  width?: number;
  color?: string;
}

export function EdgePanel({ store, state, kind, targetId, style, width, color }: EdgePanelProps): React.ReactElement {
  const setStyle = (next: "solid" | "dashed"): void => {
    if (kind === "tree") store.setEdgeStyle(targetId, next);
    else store.setFreeLinkStyle(targetId, next);
  };
  const setWidth = (next: number): void => {
    if (kind === "tree") store.setEdgeWidth(targetId, next);
    else store.setFreeLinkWidth(targetId, next);
  };
  const setColor = (next: string | undefined): void => {
    if (kind === "tree") store.setEdgeColor(targetId, next);
    else store.setFreeLinkColor(targetId, next);
  };

  const current = style ?? "solid";
  const currentWidth = width ?? 1.5;
  const currentColor = color;

  return (
    <div className="mm-style" data-mm-edge-panel="true">
      <div className="mm-style-head">
        <span className="mm-style-title">连线属性</span>
        <button
          type="button"
          className="mm-style-close"
          data-mm-action="hide-edge-style"
          onClick={() => {
            if (kind === "tree") store.selectEdge(null);
            else store.selectFreeLink(null);
          }}
          title="关闭"
        >
          ×
        </button>
      </div>

      <div className="mm-style-row">
        <span className="mm-style-label">线型</span>
        <div className="mm-style-options">
          <button
            type="button"
            className="mm-style-chip"
            data-mm-edge-style="solid"
            data-active={current === "solid" ? "true" : undefined}
            onClick={() => setStyle("solid")}
          >
            实线
          </button>
          <button
            type="button"
            className="mm-style-chip"
            data-mm-edge-style="dashed"
            data-active={current === "dashed" ? "true" : undefined}
            onClick={() => setStyle("dashed")}
          >
            虚线
          </button>
        </div>
      </div>

      <div className="mm-style-row">
        <span className="mm-style-label">粗细</span>
        <div className="mm-style-options">
          {EDGE_WIDTHS.map((step) => (
            <button
              key={step}
              type="button"
              className="mm-style-chip"
              data-mm-edge-width={String(step)}
              data-active={Math.round(currentWidth) === step ? "true" : undefined}
              onClick={() => setWidth(step)}
            >
              {step}
            </button>
          ))}
        </div>
      </div>

      <div className="mm-style-row">
        <span className="mm-style-label">颜色</span>
        <div className="mm-style-options">
          {EDGE_COLORS.map((item) => (
            <button
              key={item.key}
              type="button"
              className="mm-style-chip"
              data-mm-edge-color={item.key}
              data-active={currentColor === item.value ? "true" : undefined}
              onClick={() => setColor(item.value)}
              title={item.label}
            >
              {item.value === undefined ? (
                "默认"
              ) : (
                <span className="mm-edge-swatch" style={{ background: item.value }} />
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="mm-style-foot">选中线后可以调整样式，双击线可写说明</div>
    </div>
  );
}
