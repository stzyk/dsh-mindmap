/**
 * dsh-mindmap — 导图画布布局（纯函数）。
 *
 * 布局形状：**右向树**（root 在最左，子节点往右展开、垂直居中于子树块）。
 * 这是思维导图最常见的读法——从中心往右读，长句不会被挤成窄柱。
 *
 * 为什么不用"按深度对齐成等宽列"：
 *   那样每一层的节点都会被强制拉成同一列宽，短节点旁边留一片空白，
 *   深树很快就横向溢出。按"父节点右边缘 + 固定间距"排，短句子自然紧凑，
 *   整张图宽度由最深的那条路径决定，而不是由最宽的那个节点 × 深度决定。
 *
 * 这个模块不碰 DOM：文字宽度靠字符估算。估算值只影响方框是否贴合文字，
 * 不影响节点之间的相对位置与连线正确性——所以宁可估宽一点（留白），
 * 也不要挤出框。
 */

import type { MindNode } from "./tree.ts";
import { effectiveBold, effectiveFontSize } from "./style.ts";
import { markOf } from "./marks.ts";

/** 布局常量：所有尺寸都在这里，改视觉只改这一处。 */
export const LAYOUT = {
  /** 节点方框最小宽度（px）。 */
  minWidth: 92,
  /** 节点方框最大宽度（px）：超过就截断文字。 */
  maxWidth: 260,
  /** 方框左右内边距合计。 */
  paddingX: 22,
  /** 节点高度（单行）。 */
  nodeHeight: 34,
  /** 兄弟子树之间的垂直间距。 */
  gapY: 14,
  /** 父子之间的水平间距（留给连线和折叠按钮）。 */
  gapX: 54,
  /** 画布外边距。 */
  margin: 32,
  /** 字号（px），与 estimateWidth 保持一致。 */
  fontSize: 13,
  /** 节点内图片的最大显示边长（px）：太大就把导图撑得没法看。 */
  imageMaxSide: 132,
  /** 图片与文字之间、图片与图片之间的间距。 */
  imageGap: 6,
  /** 纯图片节点没有文字行时的高度（只有图片 + 上下内边距）。 */
  imagePaddingY: 8,
} as const;

/**
 * 真实文字测量函数：给浏览器用，拿到与最终渲染完全一致的宽度。
 * @param text - 节点文字。
 * @param fontSize - 该层级字号。
 * @param bold - 是否粗体（root）。
 */
export type TextMeasurer = (text: string, fontSize: number, bold: boolean) => number;

/** 一个节点的布局结果（相对画布坐标）。 */
export interface LayoutNode {
  id: string;
  text: string;
  /** 方框左上角。 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 层级：根 = 0。 */
  depth: number;
  /** 是否收起了子节点。 */
  collapsed: boolean;
  /** 是否有子节点（用于决定是否画折叠按钮）。 */
  hasChildren: boolean;
  /** 被文字截断时保留完整文字，供 title 提示。 */
  title: string;
  /** 是否带手动坐标（拖动过）。 */
  manual?: boolean;
  /** 这个节点上要渲染的图片（已算好显示尺寸）。 */
  images?: Array<{ id: string; type: string; width: number; height: number; caption?: string }>;
  /** 是否有文字（纯图片节点为 false）。 */
  hasText: boolean;
  /** 父节点连到本节点的那条线上的文字（渲染连线标签用）。 */
  edgeLabel?: string;
  /** 节点标识的符号（已按 key 解析成 emoji，渲染层直接用）。 */
  marks?: string[];
  /** 连到父节点的那条线是否被断开（断开的节点不画线，但仍参与布局）。 */
  detached?: boolean;
  /** 连到父节点那条线的样式（缺省跟随文档默认）。 */
  edgeStyle?: "solid" | "dashed";
  /** 连到父节点那条线的粗细。 */
  edgeWidth?: number;
  /** 连到父节点那条线的颜色。 */
  edgeColor?: string;
}

/** 一条父子连线（从父方框右中点连到子方框左中点）。 */
export interface LayoutLink {
  fromId: string;
  toId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  depth: number;
  /** 连线上的文字（来自子节点的 edgeLabel）。 */
  label?: string;
  /**
   * 标签的锚点（曲线的中点）。
   *
   * 提前在布局层算好，而不是让渲染层自己算：曲线是三次贝塞尔，
   * 中点不是两端的平均值，各处各算一次容易不一致。
   */
  labelX: number;
  labelY: number;
}

/** 整张图的布局结果。 */
export interface Layout {
  nodes: LayoutNode[];
  links: LayoutLink[];
  width: number;
  height: number;
}

/**
 * 估算一行文字的像素宽度。
 *
 * 没有 DOM 时唯一可靠的近似：按字符类别给不同权重——
 * CJK / 全角标点 ≈ 1 个字宽，其余 ≈ 0.55 个字宽。
 * 估宽偏保守（宁可框大一点），避免文字溢出方框。
 */
export function estimateWidth(text: string, fontSize = LAYOUT.fontSize): number {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // CJK 统一表意文字、假名、全角符号、CJK 标点
    const isWide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    units += isWide ? 1 : 0.55;
  }
  return Math.round(units * fontSize);
}

/**
 * 每个层级实际渲染用的字号。
 *
 * 必须与 styles.ts 里的 CSS 对齐：root 是 13.5px / 600 字重，一级是 500
 * 字重，其余 13px。粗体的中日韩文字比常规体明显更宽，按同一字号估算
 * 会让 root 的文字刚好溢出方框——截图里 root 曾经被截成"冒烟测试…"。
 */
export function fontSizeForDepth(depth: number): number {
  if (depth === 0) return 13.5;
  return LAYOUT.fontSize;
}

/**
 * 计算一个节点的方框宽度。
 * @param text - 节点文字。
 * @param depth - 层级（root 用更大的字号，见 fontSizeForDepth）。
 * @param measure - 可选的真实测量函数（浏览器里用 canvas measureText）；
 *   不给时回落到字符估算，供 Host 与单测使用。
 */
/**
 * 按图片原始宽高比，算出它在这个节点里的显示尺寸。
 *
 * 上限是 `imageMaxSide`；宽图与高图都不会超出这个方形框。返回的是
 * "保持比例缩放到框内"的结果，不是裁剪——导图里的图应该完整可见。
 */
export function imageDisplaySize(
  image: { width?: number; height?: number },
  maxSide = LAYOUT.imageMaxSide,
): { width: number; height: number } {
  const rawWidth = image.width !== undefined && image.width > 0 ? image.width : 4;
  const rawHeight = image.height !== undefined && image.height > 0 ? image.height : 3;
  const scale = Math.min(maxSide / rawWidth, maxSide / rawHeight, 1);
  // 至少 24px：再小的缩略图也没法点，不如给个能看见的最小尺寸
  return {
    width: Math.max(24, Math.round(rawWidth * scale)),
    height: Math.max(24, Math.round(rawHeight * scale)),
  };
}

/**
 * 节点的内容尺寸：文字宽 + 图片块。
 *
 * 图片横排在文字下方（不嵌进文字行），因为导图节点普遍窄，
 * 文字与图片并排会把两边都挤扁。纯图片节点则只有图片。
 */
export function contentSize(
  node: MindNode,
  depth: number,
  measure?: TextMeasurer,
): { width: number; height: number } {
  const images = node.images ?? [];
  const hasText = node.text.trim().length > 0;
  /*
   * 字号必须走 effectiveFontSize（节点自定义优先），而不是只看层级。
   * 布局与渲染是两处独立代码，若这里用层级默认而渲染用自定义字号，
   * 大字号节点的文字会溢出方框——这种"算的框装不下画的字"很难查。
   */
  const fontSize = effectiveFontSize(node, depth);
  const bold = effectiveBold(node, depth);

  let textWidth = 0;
  if (hasText) {
    textWidth =
      measure !== undefined
        ? Math.ceil(measure(node.text, fontSize, bold))
        : Math.round(estimateWidth(node.text, fontSize) * (bold ? 1.04 : 1));
  }

  let imageRowWidth = 0;
  let imageRowHeight = 0;
  for (const image of images) {
    const size = imageDisplaySize(image);
    imageRowWidth += size.width;
    imageRowHeight = Math.max(imageRowHeight, size.height);
  }
  if (images.length > 1) imageRowWidth += LAYOUT.imageGap * (images.length - 1);

  /*
   * 标识（emoji）占的宽度必须算进节点宽，否则文字会把图标挤出去、
   * 或者图标压到文字上——"算的框装不下画的东西"。
   *
   * emoji 的实际宽度接近一个全角字符，按 fontSize * 1.15 估，
   * 图标之间留 2px。
   */
  const markCount = node.marks?.length ?? 0;
  const marksWidth = markCount > 0 ? Math.round(fontSize * 1.15 * markCount + 2 * (markCount - 1) + 6) : 0;

  // 单行文字的行高跟着字号走，否则大字号的字会被压扁
  const textHeight = hasText ? Math.round(fontSize * 1.38) : 0;
  const imagesHeight = images.length > 0 ? imageRowHeight + (hasText ? LAYOUT.imageGap : 0) : 0;
  const innerHeight = textHeight + imagesHeight;
  const height =
    images.length > 0
      ? Math.max(LAYOUT.nodeHeight, innerHeight + LAYOUT.imagePaddingY * 2)
      : Math.max(LAYOUT.nodeHeight, innerHeight + 8);

  // 带图片的节点允许更宽：图片需要横向空间
  const maxWidth = images.length > 0 ? LAYOUT.maxWidth * 1.6 : LAYOUT.maxWidth;
  // 标识占的横向空间并进内容宽度（和文字并排，不是单独一行）
  const width = Math.max(textWidth, imageRowWidth) + marksWidth + LAYOUT.paddingX + 2;

  return {
    width: Math.max(LAYOUT.minWidth, Math.min(maxWidth, width)),
    height: Math.round(height),
  };
}

export function nodeWidth(text: string, depth = 1, measure?: TextMeasurer): number {
  const fontSize = fontSizeForDepth(depth);
  const textWidth = measure !== undefined
    ? Math.ceil(measure(text, fontSize, depth === 0))
    : estimateWidth(text, fontSize);
  // paddingX 之外再留 2px 给左右边框（box-sizing: border-box 会把边框算进内容区）
  const raw = textWidth + LAYOUT.paddingX + 2;
  return Math.max(LAYOUT.minWidth, Math.min(LAYOUT.maxWidth, raw));
}

/**
 * 计算整棵树的布局。
 *
 * 两趟：
 *   1. 自底向上算每棵子树的"垂直占位"（自身高度与所有子树之和取大者）；
 *   2. 自顶向下按占位把节点摆到它子树块的垂直中心。
 *
 * 收起（collapsed）的节点按"叶子"参与布局：它的子树不占位、不产生节点，
 * 但 hasChildren 仍为 true，好让 UI 画出"还有 N 个子节点"的折叠按钮。
 *
 * @param root - 根节点（不会被修改）。
 * @param options - 覆盖默认常量（UI 缩放时用）。
 * @returns 布局结果，坐标原点在画布左上角（margin 之后）。
 */
/**
 * 碰撞消解：把重叠的节点推开。
 *
 * 为什么需要它：手动摆放过（拖过）的节点用自己的坐标，自动排布管不到它们，
 * 于是会出现"两个节点叠在一起"——实测一张 200 节点的图里能叠出五六处，
 * 文字互相盖住，既看不清也点不中。
 *
 * 策略：按 y 从上往下扫，发现重叠就把**下面那个**（连同它的整棵子树）
 * 往下推，推到刚好不重叠为止。只推手动节点——自动节点本来就由排布保证不重叠，
 * 推它们会破坏树的层级感。
 *
 * 迭代 4 轮：推开一个可能又撞上更下面的，扫几遍才收敛。
 * 不做无限循环——真遇到极端布局（用户把节点拖成环），宁可留一点重叠也不能卡死。
 */
function resolveOverlaps(nodes: LayoutNode[], parents: Map<string, string>, gapY: number): void {
  const descendantsOf = (id: string): LayoutNode[] => {
    const out: LayoutNode[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const node of nodes) {
        if (parents.get(node.id) === current) {
          out.push(node);
          stack.push(node.id);
        }
      }
    }
    return out;
  };

  for (let pass = 0; pass < 4; pass += 1) {
    let moved = false;
    // 从上往下扫，保证"上面的先定位，下面的再让"
    const ordered = [...nodes].sort((a, b) => a.y - b.y);
    for (let i = 0; i < ordered.length; i += 1) {
      const above = ordered[i]!;
      for (let j = i + 1; j < ordered.length; j += 1) {
        const below = ordered[j]!;
        // 水平不相交就不算撞（左右两列各排各的）
        const horizontallyOverlapping =
          above.x < below.x + below.width && below.x < above.x + above.width;
        if (!horizontallyOverlapping) continue;
        const overlapY = above.y + above.height + gapY - below.y;
        if (overlapY <= 0) continue;
        // 只推手动节点：自动节点由排布保证，推它会破坏层级
        if (below.manual !== true) continue;
        below.y += overlapY;
        for (const child of descendantsOf(below.id)) child.y += overlapY;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

export function layoutTree(
  root: MindNode,
  options: {
    nodeHeight?: number;
    gapY?: number;
    gapX?: number;
    margin?: number;
    /** 真实文字测量（浏览器注入）；缺省用字符估算。 */
    measure?: TextMeasurer;
  } = {},
): Layout {
  const nodeHeight = options.nodeHeight ?? LAYOUT.nodeHeight;
  const gapY = options.gapY ?? LAYOUT.gapY;
  const gapX = options.gapX ?? LAYOUT.gapX;
  const margin = options.margin ?? LAYOUT.margin;
  const measure = options.measure;

  const nodes: LayoutNode[] = [];
  /** 父子关系，连线在全部节点摆好之后统一生成（父节点位置可能被二次调整）。 */
  const parents = new Map<string, string>();
  /** 每个节点最终的中心 y，供父节点对齐子节点跨度中点。 */
  const centers = new Map<string, number>();

  /** 第一趟：子树垂直占位。收起的节点按叶子算。 */
  /*
   * 子树垂直占位。
   *
   * 关键：ownHeight 必须是这个节点的**真实高度**（contentSize 算出来的，
   * 带图片的会高很多），不能统一用 LAYOUT.nodeHeight。否则一个 139px 高的
   * 图片节点会被按 34px 占位，摆出来的兄弟节点直接压在它身上。
   */
  const dimensionCache = new Map<string, { width: number; height: number }>();
  const dimsOf = (node: MindNode, depth: number): { width: number; height: number } => {
    const cached = dimensionCache.get(node.id);
    if (cached !== undefined) return cached;
    const size = contentSize(node, depth, measure);
    dimensionCache.set(node.id, size);
    return size;
  };

  const spanOf = (node: MindNode, depth = 0): number => {
    const visibleChildren = node.collapsed === true ? [] : node.children;
    const ownHeight = dimsOf(node, depth).height;
    if (visibleChildren.length === 0) return ownHeight;
    let total = 0;
    for (const child of visibleChildren) total += spanOf(child, depth + 1);
    total += gapY * (visibleChildren.length - 1);
    return Math.max(ownHeight, total);
  };

  /**
   * 第二趟：摆放。
   *
   * 父节点先按"子树块的正中"放，等子节点摆完再改到**首尾子节点的中心**
   * 之间。为什么不用子树块的加权重心：当子树块大小不均时（一个分支挂了
   * 五个孙节点、另一个只有一个），重心会把父节点往"重的"那一侧拉，
   * 视觉上父节点就不在自己两个分支的中间了。首尾中点永远在分支之间，
   * 这也是主流思维导图工具的排法。
   *
   * @param node - 当前节点。
   * @param depth - 层级。
   * @param left - 本节点方框的左边界。
   * @param top - 本子树块的顶部。
   * @param blockHeight - 本子树块的垂直占位。
   * @param parentId - 父节点 id。
   */
  const place = (
    node: MindNode,
    depth: number,
    left: number,
    top: number,
    blockHeight: number,
    parentId?: string,
  ): void => {
    const size = dimsOf(node, depth);
    const width = size.width;
    const nodeHeightForNode = size.height;
    /*
     * 手动摆放的节点用自己的坐标，不再参与自动排布。
     *
     * 注意这里**不提前 return**：即使节点被拖到了别处，它的子树仍然要
     * 正常渲染出来（否则拖一下根节点整棵树就没了）。所以只是把自身上下文
     * 里的 left/top 换成固定坐标，子树照旧从新位置往右展开。
     */
    const manual = node.position;
    const isManual = manual !== undefined;
    const self: LayoutNode = {
      id: node.id,
      text: node.text,
      ...(node.edgeLabel !== undefined ? { edgeLabel: node.edgeLabel } : {}),
      ...(node.detached === true ? { detached: true } : {}),
      ...(node.edgeStyle !== undefined ? { edgeStyle: node.edgeStyle } : {}),
      ...(node.edgeWidth !== undefined ? { edgeWidth: node.edgeWidth } : {}),
      ...(node.edgeColor !== undefined ? { edgeColor: node.edgeColor } : {}),
      ...(node.marks !== undefined && node.marks.length > 0
        ? { marks: node.marks.map((key) => markOf(key)?.glyph ?? "").filter((g) => g.length > 0) }
        : {}),
      x: isManual ? manual.x : left,
      y: isManual ? manual.y : top + (blockHeight - nodeHeightForNode) / 2,
      width,
      height: nodeHeightForNode,
      depth,
      collapsed: node.collapsed === true,
      hasChildren: node.children.length > 0,
      title: node.text.length > 0 ? node.text : (node.images?.[0]?.caption ?? "图片节点"),
      hasText: node.text.trim().length > 0,
      ...(node.images !== undefined && node.images.length > 0
        ? {
            images: node.images.map((image) => {
              const display = imageDisplaySize(image);
              return {
                id: image.id,
                type: image.type,
                width: display.width,
                height: display.height,
                ...(image.caption !== undefined ? { caption: image.caption } : {}),
              };
            }),
          }
        : {}),
    };
    if (isManual) self.manual = true;
    nodes.push(self);
    if (parentId !== undefined) parents.set(node.id, parentId);

    if (node.collapsed === true || node.children.length === 0) {
      centers.set(node.id, self.y + nodeHeightForNode / 2);
      return;
    }

    // 子树基准跟随本节点实际位置（手动摆放时就是拖到的那个点）
    const childLeft = self.x + width + gapX;
    let cursor = isManual ? self.y - (blockHeight - nodeHeightForNode) / 2 : top;
    const childIds: string[] = [];
    for (const child of node.children) {
      const childBlock = spanOf(child, depth + 1);
      place(child, depth + 1, childLeft, cursor, childBlock, node.id);
      childIds.push(child.id);
      cursor += childBlock + gapY;
    }

    // 对齐首尾子节点的中心（只对自动布局的节点做；手动摆放的位置是用户的决定）
    if (!isManual) {
      const first = centers.get(childIds[0]);
      const last = centers.get(childIds[childIds.length - 1]);
      if (first !== undefined && last !== undefined) {
        self.y = (first + last) / 2 - nodeHeightForNode / 2;
      }
    }
    centers.set(node.id, self.y + nodeHeightForNode / 2);
  };

  const totalHeight = spanOf(root, 0);
  place(root, 0, margin, margin, totalHeight);

  // 连线：在最终坐标上生成，避免父节点二次调整后连线错位
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const links: LayoutLink[] = [];
  for (const node of nodes) {
    const parentId = parents.get(node.id);
    if (parentId === undefined) continue;
    const parent = byId.get(parentId);
    if (parent === undefined) continue;
    /*
     * 连线被断开（detached）的节点不画线，但**仍然参与布局**：
     * 它有手动坐标，会停在被断开时的位置，层级和子树都不变。
     * 放在布局层判断，画布 / 导出 / 测试就都一致了。
     */
    if (node.detached === true) continue;
    const x1 = parent.x + parent.width;
    const y1 = parent.y + parent.height / 2;
    const x2 = node.x;
    const y2 = node.y + node.height / 2;
    /*
     * 贝塞尔中点（t = 0.5）。
     *
     * 控制点用的是 linkPath 里那套 (midX, y1) / (midX, y2)，
     * 代入 B(0.5) = (P0 + 3P1 + 3P2 + P3) / 8：
     *   x = (x1 + 3·midX + 3·midX + x2) / 8
     *   y = (y1 + 3·y1 + 3·y2 + y2) / 8 = (y1 + y2) / 2
     * 所以 y 就是两端的中点，x 需要用 midX 算。
     */
    const midX = x1 + (x2 - x1) * 0.55;
    const labelX = (x1 + 3 * midX + 3 * midX + x2) / 8;
    const labelY = (y1 + y2) / 2;
    links.push({
      fromId: parent.id,
      toId: node.id,
      ...(node.edgeStyle !== undefined ? { style: node.edgeStyle } : {}),
      ...(node.edgeWidth !== undefined ? { width: node.edgeWidth } : {}),
      ...(node.edgeColor !== undefined ? { color: node.edgeColor } : {}),
      x1,
      y1,
      x2,
      y2,
      depth: node.depth,
      ...(node.edgeLabel !== undefined && node.edgeLabel.length > 0
        ? { label: node.edgeLabel }
        : {}),
      labelX,
      labelY,
    });
  }

  // 画布宽高：从实际节点反推，保证所有方框都在界内
  let maxRight = 0;
  let maxBottom = 0;
  for (const node of nodes) {
    maxRight = Math.max(maxRight, node.x + node.width);
    maxBottom = Math.max(maxBottom, node.y + node.height);
  }

  return {
    nodes,
    links,
    width: maxRight + margin,
    height: Math.max(maxBottom + margin, totalHeight + margin * 2),
  };
}

/**
 * 连线的 SVG 路径（三次贝塞尔）。
 *
 * 控制点取水平方向的 55% 中间点——这样从父节点右边缘出来时先"向右走"，
 * 到子节点左边缘时也是水平进入，视觉上与文字方向一致；
 * 直接用直线会在深树里出现很陡的斜线，读起来像蜘蛛网。
 */
export function linkPath(link: LayoutLink): string {
  const midX = link.x1 + (link.x2 - link.x1) * 0.55;
  return `M ${link.x1} ${link.y1} C ${midX} ${link.y1}, ${midX} ${link.y2}, ${link.x2} ${link.y2}`;
}

/* ------------------------------------------------------------------ *
 * 多主题布局
 * ------------------------------------------------------------------ */

/** 两个主题之间的垂直间距。 */
export const THEME_GAP = 64;

/**
 * 布局多个并列的中心主题。
 *
 * 做法很直接：**每个主题各自按单树布局**，然后把结果纵向错开堆叠。
 * 没有改 layoutTree 的内部算法——它本来就只管一棵树，
 * 在这里组合比在算法里加分支安全得多（不会影响单主题的既有行为）。
 *
 * @param themes - 各个主题（多主题文档的容器根 children）。
 * @param options - 与 layoutTree 相同的选项。
 */
export function layoutForest(
  themes: readonly MindNode[],
  options: Parameters<typeof layoutTree>[1] = {},
): Layout {
  const margin = options.margin ?? LAYOUT.margin;
  const nodes: LayoutNode[] = [];
  const links: LayoutLink[] = [];
  /** 参与自动堆叠的主题里最宽的那个。 */
  let stackWidth = 0;
  /** 自动堆叠的游标。 */
  let cursorY = margin;
  /** 所有节点的右 / 下边界（含被钉住的主题，它们可能落在堆叠区之外）。 */
  let extentX = 0;
  let extentY = 0;

  for (const theme of themes) {
    const sub = layoutTree(theme, options);
    /*
     * 手动摆过位置的主题**钉在原地**，不参与纵向堆叠。
     *
     * 双击空白新建主题时会带上鼠标坐标，期望就是"出现在点的那个地方"。
     * 若照样加 dy 偏移，它会被推到所有主题下方，坐标形同虚设。
     * 拖拽过的主题同理——用户把它挪到哪就待在哪。
     */
    const pinned = theme.position !== undefined;
    const dy = pinned ? 0 : cursorY;

    for (const node of sub.nodes) {
      const placed = dy === 0 ? node : { ...node, y: node.y + dy };
      nodes.push(placed);
      extentX = Math.max(extentX, placed.x + placed.width);
      extentY = Math.max(extentY, placed.y + placed.height);
    }
    for (const link of sub.links) {
      links.push(
        dy === 0 ? link : { ...link, y1: link.y1 + dy, y2: link.y2 + dy, labelY: link.labelY + dy },
      );
    }

    if (!pinned) {
      stackWidth = Math.max(stackWidth, sub.width);
      cursorY += sub.height + THEME_GAP;
    }
  }

  return {
    nodes,
    links,
    // 画布尺寸必须覆盖被钉住的主题，否则它会被裁在可视区外面
    width: Math.max(margin * 2, stackWidth, extentX + margin),
    // 最后一个主题后面不留 gap，否则底部永远多一截空白
    height: Math.max(margin * 2, cursorY - THEME_GAP + margin, extentY + margin),
  };
}
