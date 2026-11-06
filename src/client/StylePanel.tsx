/**
 * dsh-mindmap — 节点属性面板。
 *
 * 交互：选中节点后在画布下方浮出一条属性栏。
 *
 * 为什么是面板而不是右键菜单：
 *   右键菜单在画布上要自己做定位、防溢出、点外面关闭，而且一次只能看一个分组。
 *   属性栏固定在底部，开着的时候所有可选项一眼可见，改完立刻看到效果——
 *   调颜色这种事本来就是要反复试的。
 *
 * 所有选择都是**预设档位**（见 src/core/style.ts）：色板保证对比度，
 * 字号/圆角/边框取有限档位，避免用户选出一个把文字压没的组合。
 */

import * as React from "react";

import type { MindNode } from "../core/tree.ts";
import { MARKS, MAX_MARKS } from "../core/marks.ts";
import {
  BORDER_WIDTHS,
  FONT_SIZES,
  PALETTE,
  RADII,
  effectiveStyle,
  isDefaultStyle,
  type NodeStyle,
} from "../core/style.ts";
import type { MindmapStore, ViewState } from "./store.ts";

interface StylePanelProps {
  store: MindmapStore;
  state: ViewState;
  /** 当前选中的节点（主选中项，由画布传入）。 */
  node: MindNode | undefined;
  /** 该节点在布局里的层级（根 = 0），用于套用层级默认值。 */
  depth: number;
  /** 全部选中的节点（多选时用于批量应用）。 */
  selectedIds: string[];
}

/** 一组档位按钮。 */
function OptionRow<T extends string | number | boolean>({
  label,
  group,
  options,
  value,
  inherited,
  onPick,
}: {
  label: string;
  /** 组名：给按钮打标识，避免"字号 13"和"边框 3"这类歧义 */
  group: string;
  options: Array<{ key: T; label: string; hint?: string; swatch?: string; textColor?: string }>;
  /** 当前**生效值**（不是"显式设置过的值"）。 */
  value: T;
  /**
   * 这个生效值是不是"没设置过、跟随默认"。
   * 是的话在标签旁标一个「默认」，让用户知道这不是他自己设的。
   */
  inherited: boolean;
  onPick: (key: T | undefined) => void;
}): React.ReactElement {
  // 生效值可能不落在任何档位上（比如根节点默认字号 13.5，而档位只有 11/13/16/20）
  const matched = options.some((option) => option.key === value);
  return (
    <div className="mm-style-row">
      <span className="mm-style-label">
        {label}
        {inherited ? <em className="mm-style-default">默认</em> : null}
        {!matched ? <em className="mm-style-current">当前 {String(value)}</em> : null}
      </span>
      <div className="mm-style-options">
        {options.map((option) => {
          const active = value === option.key;
          return (
            <button
              key={String(option.key)}
              type="button"
              className="mm-style-chip"
              data-mm-style={group}
              data-mm-value={String(option.key)}
              data-active={active ? "true" : undefined}
              title={option.hint ?? option.label}
              onClick={() => onPick(active ? undefined : option.key)}
              style={
                option.swatch !== undefined
                  ? {
                      background: option.swatch,
                      color: option.textColor ?? undefined,
                      borderColor: option.swatch,
                    }
                  : undefined
              }
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 属性面板。 */
export function StylePanel({ store, state, node, depth, selectedIds }: StylePanelProps): React.ReactElement | null {
  const [subtree, setSubtree] = React.useState(false);

  // 选中变化时把"应用到子树"关掉：避免下一次操作误伤整支
  React.useEffect(() => {
    setSubtree(false);
  }, [node?.id]);

  if (node === undefined) return null;

  /*
   * 多选时面板的语义变成"批量"：
   *   - 显示的当前值是**主选中项**的，作为基准；
   *   - 任何点击都作用到全部选中节点（含子节点开关则再加子孙）。
   *
   * 为什么不做"只显示共同值"：用户框选一堆节点后想统一改色，
   * 关心的是"改成什么"，不是"它们原来各是什么"。显示共同值反而
   * 会让面板大部分时间一片空白。
   */
  const batch = selectedIds.length > 1;
  const style: NodeStyle = node.style ?? {};
  /*
   * 面板显示**生效值**，不是 style（style 只含显式设置过的项）。
   *
   * 用 style 的话，一个没设置过样式的节点在面板上看起来"什么都没有"：
   * 字号不高亮、字形不高亮、圆角边框也不高亮，用户根本不知道它现在是
   * 13 号字还是加粗。而画布上明明有确定的外观。
   */
  const effective = effectiveStyle(node, depth);
  /** 某一项是不是"没设置过、跟随默认"。 */
  const isInherited = (key: keyof NodeStyle): boolean => style[key] === undefined;

  /** 统一的补丁入口：多选时作用到全部选中节点。 */
  const patch = (changes: Partial<Record<keyof NodeStyle, unknown>>): void => {
    if (batch) {
      store.styleNodes(selectedIds, changes);
      return;
    }
    store.styleNode(node.id, changes, subtree);
  };

  return (
    <div className="mm-style" data-mm-panel="style" role="region" aria-label="节点属性">
      <div className="mm-style-head">
        <span className="mm-style-title">节点属性</span>
        <span className="mm-style-target" title={node.text}>
          {batch
            ? "已选 " + String(selectedIds.length) + " 个节点"
            : node.text.length > 0
              ? node.text
              : "（空节点）"}
        </span>
        <label
          className="mm-style-scope"
          title={
            batch
              ? "多选时直接作用于所有选中节点（不再展开子孙）"
              : "把这个设置应用到该节点及其所有子孙"
          }
        >
          <input
            type="checkbox"
            checked={subtree && !batch}
            disabled={batch}
            onChange={(event) => setSubtree(event.target.checked)}
            data-mm-action="style-subtree"
          />
          含子节点
        </label>
        <div className="mm-grow" />
        <button
          type="button"
          className="mm-btn"
          data-mm-action="style-reset"
          disabled={!batch && isDefaultStyle(node.style)}
          onClick={() => {
            if (batch) store.clearStyles(selectedIds);
            else store.clearStyle(node.id);
          }}
          title="把这个节点及其子树的样式恢复默认"
        >
          恢复默认
        </button>
        <button
          type="button"
          className="mm-btn"
          data-icon="true"
          data-mm-action="style-close"
          onClick={() => store.hideStyle()}
          title="收起属性抽屉（节点仍保持选中，再次选中会重新展开）"
        >
          ×
        </button>
      </div>

      <div className="mm-style-body">
        {/*
         * 标识：给节点打「重点 / 易错」这类记号，复习时一眼扫出来。
         * 放在最前面——它比配色常用得多，改颜色是偶尔的事。
         */}
        <div className="mm-style-row">
          <span className="mm-style-label">
            标识
            <em className="mm-style-current">
              {String(node.marks?.length ?? 0)}/{String(MAX_MARKS)}
            </em>
          </span>
          <div className="mm-style-options">
            {MARKS.map((mark) => {
              const active = node.marks?.includes(mark.key) === true;
              return (
                <button
                  key={mark.key}
                  type="button"
                  className="mm-style-chip mm-mark-chip"
                  data-mm-mark={mark.key}
                  data-active={active ? "true" : undefined}
                  title={mark.hint + "（再点一次取消）"}
                  onClick={() => {
                    if (batch) {
                      store.toast("标识一次只能给一个节点设置", "error");
                      return;
                    }
                    store.toggleMark(node.id, mark.key);
                  }}
                >
                  <span aria-hidden="true">{mark.glyph}</span>
                  {mark.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 配色：每组自带前景色，选了就保证看得清 */}
        <OptionRow
          label="配色"
          group="color"
          value={effective.color}
          inherited={isInherited("color")}
          options={PALETTE.map((entry) => ({
            key: entry.key,
            label: entry.label,
            hint: entry.key === "default" ? "跟随主题" : entry.label,
            swatch: entry.key === "default" ? undefined : entry.background,
            textColor: entry.key === "default" ? undefined : entry.foreground,
          }))}
          onPick={(key) => patch({ color: key === "default" ? null : key })}
        />

        <OptionRow
          label="字号"
          group="fontSize"
          value={effective.fontSize}
          inherited={isInherited("fontSize")}
          options={FONT_SIZES.map((size) => ({
            key: size,
            label: String(size),
            hint: size + " px",
          }))}
          onPick={(size) => patch({ fontSize: size ?? null })}
        />

        <div className="mm-style-row">
          <span className="mm-style-label">
            字形
            {isInherited("bold") && isInherited("italic") ? <em className="mm-style-default">默认</em> : null}
          </span>
          <div className="mm-style-options">
            <button
              type="button"
              className="mm-style-chip"
              data-active={effective.bold ? "true" : undefined}
              /*
               * 按"生效值"取反，而不是按"显式值"。
               * 根节点默认加粗，若按显式值判断，点一下只会存 null，
               * 结果还是加粗，用户会以为按钮坏了。
               */
              onClick={() => patch({ bold: !effective.bold })}
              style={{ fontWeight: 700 }}
              data-mm-action="style-bold"
            >
              B 粗
            </button>
            <button
              type="button"
              className="mm-style-chip"
              data-active={effective.italic ? "true" : undefined}
              onClick={() => patch({ italic: !effective.italic })}
              style={{ fontStyle: "italic" }}
              data-mm-action="style-italic"
            >
              I 斜
            </button>
          </div>
        </div>

        <OptionRow
          label="圆角"
          group="radius"
          value={effective.radius}
          inherited={isInherited("radius")}
          options={RADII.map((radius) => ({
            key: radius,
            label: String(radius),
            hint: radius === 0 ? "直角" : radius + " px 圆角",
          }))}
          onPick={(radius) => patch({ radius: radius ?? null })}
        />

        <OptionRow
          label="边框"
          group="borderWidth"
          value={effective.borderWidth}
          inherited={isInherited("borderWidth")}
          options={BORDER_WIDTHS.map((width) => ({
            key: width,
            label: width === 0 ? "无" : String(width),
            hint: width === 0 ? "不显示边框" : width + " px 边框",
          }))}
          onPick={(width) => patch({ borderWidth: width ?? null })}
        />
      </div>

      <div className="mm-style-hint">
        {state.historyState.canUndo ? "改错了按 Cmd/Ctrl+Z 撤销" : "选中节点后可调整外观"}
      </div>
    </div>
  );
}
