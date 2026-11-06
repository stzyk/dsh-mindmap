/**
 * dsh-mindmap — 节点样式（两半共用）。
 *
 * 设计取向：**只给预设色板，不给自由取色器。**
 *
 * 自由取色看起来更强大，但它把"文字能不能看清"这件事交给用户去保证。
 * 用户选一个深蓝底、又忘了改文字色，节点就变成一块看不清的色块——
 * 而这个插件之前已经因为"根节点反色"踩过一模一样的坑（换肤后变纯黑块）。
 * 预设色板的每一组都是**背景 + 前景配对**好的，对比度由色板保证，
 * 换任何皮肤都不会出问题。
 *
 * 字号给了档位而不是任意像素：布局要按字号算宽高，任意值会让
 * "同一个字号在不同节点上看起来不一样"的边界问题变多。
 */

import type { MindNode } from "./tree.ts";

/* ------------------------------------------------------------------ *
 * 色板
 * ------------------------------------------------------------------ */

/** 一组预设配色：背景 + 前景（已保证对比度 ≥ 4.5:1）。 */
export interface PaletteColor {
  /** 稳定键名，存进数据的是它（不是色值）——换色板主题时能平滑跟过去。 */
  key: string;
  /** 显示名（中文）。 */
  label: string;
  /** 节点底色。 */
  background: string;
  /** 节点文字色。 */
  foreground: string;
}

/**
 * 内置色板。
 *
 * 每一组都在浅色与深色宿主主题下试过：底色是低饱和的"纸色"，
 * 文字用同色系加深，不依赖宿主变量，因此不会因换肤而失效。
 */
export const PALETTE: readonly PaletteColor[] = [
  { key: "default", label: "默认", background: "", foreground: "" },
  { key: "slate", label: "石板", background: "#eef1f5", foreground: "#1f2933" },
  { key: "blue", label: "海蓝", background: "#dce8f7", foreground: "#123a63" },
  { key: "teal", label: "青碧", background: "#d6eeea", foreground: "#0f3f3a" },
  { key: "green", label: "草绿", background: "#ddeed6", foreground: "#1f3d18" },
  { key: "amber", label: "琥珀", background: "#faedd0", foreground: "#4a3410" },
  { key: "orange", label: "落日", background: "#fbe0d1", foreground: "#55260f" },
  { key: "red", label: "砖红", background: "#f8dcdc", foreground: "#5a1717" },
  { key: "pink", label: "藕粉", background: "#f7dfeb", foreground: "#521633" },
  { key: "purple", label: "雾紫", background: "#e8e0f5", foreground: "#341a5c" },
  { key: "gray", label: "石灰", background: "#e6e6e6", foreground: "#2b2b2b" },
  { key: "ink", label: "墨黑", background: "#2b3038", foreground: "#eef2f7" },
] as const;

/** 按 key 查一组配色。 */
export function paletteOf(key: string | undefined): PaletteColor | undefined {
  if (key === undefined || key === "" || key === "default") return undefined;
  return PALETTE.find((entry) => entry.key === key);
}

/* ------------------------------------------------------------------ *
 * 节点样式
 * ------------------------------------------------------------------ */

/** 字号档位：小 / 常规 / 大 / 特大。 */
export const FONT_SIZES = [11, 13, 16, 20] as const;
/** 圆角档位（px）。 */
export const RADII = [0, 4, 8, 14] as const;
/** 边框粗细档位（px）。 */
export const BORDER_WIDTHS = [0, 1, 2, 3] as const;

/**
 * 与 CSS 保持一致的默认值。
 *
 * 属性面板要显示"当前生效值"，就必须知道没设置时是多少。
 * 这些数字同时出现在 styles.ts 的 .mm-node 规则里，单测会校验两边一致
 * （否则面板显示的和画布画出来的会对不上，而且没人会发现）。
 */
export const DEFAULT_RADIUS = 6;
export const DEFAULT_BORDER_WIDTH = 1;

/** 一个节点的外观设置。全部字段可选：没写的就跟随默认。 */
export interface NodeStyle {
  /** 色板键名（见 PALETTE）。缺省 / "default" = 跟随主题。 */
  color?: string;
  /** 字号（px），取自 FONT_SIZES。 */
  fontSize?: number;
  /** 加粗。 */
  bold?: boolean;
  /** 斜体。 */
  italic?: boolean;
  /** 圆角（px），取自 RADII。 */
  radius?: number;
  /** 边框粗细（px），取自 BORDER_WIDTHS。0 = 无边框。 */
  borderWidth?: number;
}

/** 样式是否为空（全默认）。 */
export function isDefaultStyle(style: NodeStyle | undefined): boolean {
  if (style === undefined) return true;
  return (
    (style.color === undefined || style.color === "" || style.color === "default") &&
    style.fontSize === undefined &&
    style.bold === undefined &&
    style.italic === undefined &&
    style.radius === undefined &&
    style.borderWidth === undefined
  );
}

/**
 * 把任意来源收敛成合法样式。
 *
 * 逐字段白名单校验：只接受预设档位里的值，其余丢弃。
 * 这样即使手改 JSON 写了个 `fontSize: 999`，也不会把画布撑爆。
 *
 * @returns 合法样式；全默认时返回 undefined（不留空对象）。
 */
export function normalizeStyle(input: unknown): NodeStyle | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const style: NodeStyle = {};

  if (typeof raw.color === "string" && paletteOf(raw.color) !== undefined) {
    style.color = raw.color;
  }
  if (typeof raw.fontSize === "number" && (FONT_SIZES as readonly number[]).includes(raw.fontSize)) {
    style.fontSize = raw.fontSize;
  }
  /*
   * bold / italic 允许显式 false。
   *
   * 只存 true 的话，"取消根节点的加粗"就没法表达——根节点默认加粗，
   * 面板上点了 B 只能存 true 或什么都不存，两种都还是加粗。
   */
  if (typeof raw.bold === "boolean") style.bold = raw.bold;
  if (typeof raw.italic === "boolean") style.italic = raw.italic;
  if (typeof raw.radius === "number" && (RADII as readonly number[]).includes(raw.radius)) {
    style.radius = raw.radius;
  }
  if (typeof raw.borderWidth === "number" && (BORDER_WIDTHS as readonly number[]).includes(raw.borderWidth)) {
    style.borderWidth = raw.borderWidth;
  }

  return isDefaultStyle(style) ? undefined : style;
}

/**
 * 这个节点实际渲染用的字号。
 *
 * 优先级：节点自定义 > 层级默认（根与一级略大）。
 * 布局与渲染都必须走这个函数，否则算出来的宽高和画出来的对不上。
 */
export function effectiveFontSize(node: MindNode, depth: number): number {
  if (node.style?.fontSize !== undefined) return node.style.fontSize;
  // 根 13.5、一级 13（加粗），其余 13
  if (depth === 0) return 13.5;
  return 13;
}

/** 这个节点实际是否加粗（根节点默认加粗）。 */
export function effectiveBold(node: MindNode, depth: number): boolean {
  if (node.style?.bold !== undefined) return node.style.bold;
  return depth === 0;
}

/** 一个节点当前**实际生效**的全部外观值（面板用它显示"现在是什么样"）。 */
export interface EffectiveStyle {
  /** 色板 key；"default" 表示跟随主题。 */
  color: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  radius: number;
  borderWidth: number;
}

/**
 * 算出节点当前实际生效的外观。
 *
 * 属性面板必须显示这个，而不是 `node.style`：后者只包含**显式设置过**的项，
 * 一个没设置过样式的节点在面板上会看起来"什么都没有"，用户没法知道
 * 它现在到底是 13 号字还是加粗。
 *
 * @param depth - 节点在布局里的层级（根 = 0），用于套用层级默认值。
 */
export function effectiveStyle(node: MindNode, depth: number): EffectiveStyle {
  const style = node.style;
  return {
    color: style?.color ?? "default",
    fontSize: effectiveFontSize(node, depth),
    bold: effectiveBold(node, depth),
    italic: style?.italic === true,
    radius: style?.radius ?? DEFAULT_RADIUS,
    borderWidth: style?.borderWidth ?? DEFAULT_BORDER_WIDTH,
  };
}

/* ------------------------------------------------------------------ *
 * 样式操作（返回新树，不动入参）
 * ------------------------------------------------------------------ */

/** 应用一组样式补丁到节点；字段传 null 表示恢复默认。 */
/**
 * 这个值是否表示"清除这一项，回到默认"。
 *
 * 注意**不包含 false**：bold/italic 的显式 false 是有意义的取值
 * （用来取消根节点默认的加粗），当成"清除"的话就永远取消不掉。
 */
function isClearValue(value: unknown): boolean {
  return value === null || value === undefined || value === "default";
}

export function applyStyle(
  root: MindNode,
  id: string,
  patch: Partial<Record<keyof NodeStyle, unknown>>,
  clone: (node: MindNode) => MindNode,
  locate: (root: MindNode, id: string) => { node: MindNode } | undefined,
): MindNode | undefined {
  const next = clone(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;

  const merged: Record<string, unknown> = { ...(target.node.style ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (isClearValue(value)) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  const style = normalizeStyle(merged);
  if (style === undefined) delete target.node.style;
  else target.node.style = style;
  return next;
}

/** 把一组样式应用到整棵子树（"让这一支都变蓝"这种操作）。 */
export function applyStyleToSubtree(
  root: MindNode,
  id: string,
  patch: Partial<Record<keyof NodeStyle, unknown>>,
  clone: (node: MindNode) => MindNode,
  locate: (root: MindNode, id: string) => { node: MindNode } | undefined,
): MindNode | undefined {
  const next = clone(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;

  const applyOne = (node: MindNode): void => {
    const merged: Record<string, unknown> = { ...(node.style ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (isClearValue(value)) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
    const style = normalizeStyle(merged);
    if (style === undefined) delete node.style;
    else node.style = style;
    for (const child of node.children) applyOne(child);
  };
  applyOne(target.node);
  return next;
}

/** 清除节点及其子树的全部自定义样式。 */
export function clearStyle(
  root: MindNode,
  id: string,
  clone: (node: MindNode) => MindNode,
  locate: (root: MindNode, id: string) => { node: MindNode } | undefined,
): MindNode | undefined {
  const next = clone(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  const wipe = (node: MindNode): void => {
    delete node.style;
    for (const child of node.children) wipe(child);
  };
  wipe(target.node);
  return next;
}

/** 是否有任何节点带自定义样式（导出提示、诊断用）。 */
export function hasCustomStyle(root: MindNode): boolean {
  if (root.style !== undefined) return true;
  for (const child of root.children) {
    if (hasCustomStyle(child)) return true;
  }
  return false;
}

/**
 * 批量给多个节点应用同一组样式（框选后用）。
 *
 * 与 applyStyleToSubtree 的区别：那个是"一个节点 + 它的子孙"，
 * 这个是"用户框选出来的一批互不相干的节点"。
 *
 * @param root - 当前树（不会被修改）。
 * @param ids - 目标节点 id 列表。
 * @param patch - 要改的字段；null 表示恢复该项默认。
 * @param clone - 深拷贝函数（避免本模块反向依赖 tree.ts 的实现）。
 * @param locate - 按 id 定位节点的函数。
 * @returns 新树；一个都没命中时返回 undefined。
 */
export function applyStyleToMany(
  root: MindNode,
  ids: readonly string[],
  patch: Partial<Record<keyof NodeStyle, unknown>>,
  clone: (node: MindNode) => MindNode,
  locate: (root: MindNode, id: string) => { node: MindNode } | undefined,
): MindNode | undefined {
  const next = clone(root);
  let touched = 0;
  for (const id of ids) {
    const target = locate(next, id);
    if (target === undefined) continue;
    const merged: Record<string, unknown> = { ...(target.node.style ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (isClearValue(value)) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }
    const style = normalizeStyle(merged);
    if (style === undefined) delete target.node.style;
    else target.node.style = style;
    touched += 1;
  }
  return touched > 0 ? next : undefined;
}

/** 批量清除多个节点的自定义样式。 */
export function clearStyleMany(
  root: MindNode,
  ids: readonly string[],
  clone: (node: MindNode) => MindNode,
  locate: (root: MindNode, id: string) => { node: MindNode } | undefined,
): MindNode | undefined {
  const next = clone(root);
  let touched = 0;
  for (const id of ids) {
    const target = locate(next, id);
    if (target === undefined) continue;
    const wipe = (node: MindNode): void => {
      delete node.style;
      for (const child of node.children) wipe(child);
    };
    wipe(target.node);
    touched += 1;
  }
  return touched > 0 ? next : undefined;
}
