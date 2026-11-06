/**
 * dsh-mindmap — 导图 → Markdown 转换。
 *
 * 两种输出形态，对应两类真实用途：
 *
 *   headings（默认）
 *     根 = `#`，往下每层多一个 `#`。深度超过 6 级时 Markdown 没有更深的
 *     标题语法，于是从第 7 级起改用嵌套无序列表承接——这样无论树多深，
 *     粘进任何 Markdown 渲染器都是合法的。
 *     适合：把导图变成文章骨架、技术方案目录。
 *
 *   list
 *     整棵树是一份嵌套无序列表，根就是第一行 `- 中心主题`。
 *     适合：粘进大纲工具的文本模式（Workflowy / Obsidian / Notion 的
 *     列表粘贴都会自动还原层级）、也适合喂给模型当结构化输入。
 *
 * 备注（note）在两种形态下都渲染成紧接着标题的引用块 `> 备注`，
 * 多行备注逐行加 `>`。
 */

import type { MindNode, NodeImage } from "./tree.ts";

/** 输出形态。 */
export type MarkdownMode = "headings" | "list";

/** 转换选项。 */
export interface MarkdownOptions {
  /** 输出形态，默认 headings。 */
  mode?: MarkdownMode;
  /** 是否带上备注，默认 true。 */
  includeNotes?: boolean;
  /** 是否在开头输出一级标题（list 形态下也想要一个 `# 文档标题` 时打开）。 */
  includeTitle?: boolean;
  /** 文档标题，配合 includeTitle 使用。 */
  title?: string;
  /**
   * 图片的输出方式。
   *
   *   - `"path"`（默认）：写相对路径 `![说明](assets/xxx.png)`，
   *     配合「导出图片包」一起使用。文件小、适合进仓库。
   *   - `"inline"`：把图片塞成 base64 data URI，.md 单文件即可分享。
   *     图多时文件会很大。
   *   - `"omit"`：不输出图片（只要结构骨架的场合）。
   */
  images?: "path" | "inline" | "omit";
  /** 图片相对路径的前缀，默认 `assets`。 */
  imageBase?: string;
  /**
   * inline 模式下的图片字节查询表：id → `{ data, type }`。
   * 由 Host 在渲染前准备好；缺失的图片退化成路径形式而不是报错。
   */
  resolveImage?: (image: NodeImage) => { data: string; type: string } | undefined;
}

/** 空文字节点的占位符：宁可显示占位符，也不要导出一个空标题把结构搞乱。 */
const EMPTY_PLACEHOLDER = "（空节点）";

/**
 * 把节点文字处理成可以安全嵌进 Markdown 单行的形式。
 *
 * 只做必要的处理：折叠换行、去掉首尾空白、空值替补。
 * 刻意不转义 `*` `_` `` ` `` 等字符——用户写导图时这些字符多半就是
 * 想要的强调或代码样式，全部转义反而会毁掉他本来想表达的东西。
 */
function inline(text: string): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > 0 ? value : EMPTY_PLACEHOLDER;
}

/**
 * 把节点上的图片渲染成 Markdown 图片语法（每张一行）。
 *
 * 三种模式的行为见 MarkdownOptions.images。说明文字为空时用文件名兜底，
 * 因为空的 `![]()` 在多数渲染器里不可读、也不利于无障碍。
 */
function imageLines(node: MindNode, options: MarkdownOptions): string[] {
  const mode = options.images ?? "path";
  if (mode === "omit") return [];
  const images = node.images ?? [];
  if (images.length === 0) return [];

  const base = options.imageBase ?? "assets";
  const lines: string[] = [];
  for (const image of images) {
    const alt = inline(image.caption ?? image.name);
    if (mode === "inline") {
      const resolved = options.resolveImage?.(image);
      if (resolved !== undefined && resolved.data.length > 0) {
        lines.push("![" + alt + "](data:" + resolved.type + ";base64," + resolved.data + ")");
        continue;
      }
      // 查不到字节就退回路径：宁可链接可能失效，也不要凭空丢掉这张图
    }
    lines.push("![" + alt + "](" + base + "/" + image.id + "." + extOf(image.type) + ")");
  }
  return lines;
}

/** MIME → 扩展名（与 Host 的 assets 模块保持一致）。 */
function extOf(type: string): string {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/gif") return "gif";
  if (type === "image/webp") return "webp";
  return "png";
}

/** 把备注渲染成引用块（多行逐行加 `>`）。 */
function quote(note: string): string {
  return note
    .split(/\r?\n/)
    .map((line) => (line.trim().length > 0 ? "> " + line.trim() : ">"))
    .join("\n");
}

/**
 * 标题形态：根到第 6 级用 `#`，更深走列表。
 * @param baseDepth - 输出时整体下沉的级数。带文档标题时传 1：
 *   文档标题自己占 `#`，树的根就从 `##` 开始，避免出现两个 H1。
 */
function headingsBody(root: MindNode, options: MarkdownOptions, baseDepth = 0): string[] {
  const lines: string[] = [];
  const includeNotes = options.includeNotes !== false;
  const maxHeading = 6;

  const emit = (node: MindNode, relativeDepth: number): void => {
    const text = inline(node.text);
    const depth = relativeDepth + baseDepth;
    const pictures = imageLines(node, options);
    if (depth < maxHeading) {
      lines.push("#".repeat(depth + 1) + " " + text);
      if (includeNotes && node.note !== undefined) lines.push("", quote(node.note));
      // 图片紧跟在标题下、子标题前：这是"给这一节配图"最自然的读法
      if (pictures.length > 0) lines.push("", ...pictures);
      // 每个标题块后留一个空行：标题是块级元素，紧贴下一行会被某些渲染器
      // 当成 Setext 标题的延伸；连续空行在最后统一压缩。
      lines.push("");
    } else {
      // 第 7 级及更深：相对它最近的那个标题算缩进，输出嵌套列表。
      // 第 7 级是第 6 级标题的直接子项，因此缩进从 0 开始。
      const level = depth - maxHeading;
      lines.push("  ".repeat(level) + "- " + text);
      if (includeNotes && node.note !== undefined) {
        for (const line of quote(node.note).split("\n")) {
          lines.push("  ".repeat(level + 1) + line);
        }
      }
      for (const picture of pictures) {
        lines.push("  ".repeat(level + 1) + picture);
      }
    }
    /*
     * 递归时传 relativeDepth + 1，**不能传 depth + 1**。
     *
     * depth 里已经加过 baseDepth（"带文档标题时整体下沉一级"）；
     * 若把它当相对深度传下去，下一层会再加一次 baseDepth ——
     * 每层多沉一级，层级呈 1、3、5、7 递增，导出结果与树完全对不上。
     * 实测：带文档标题时根 ##、子节点 ####、孙节点 ######。
     */
    for (const child of node.children) emit(child, relativeDepth + 1);
  };

  emit(root, 0);
  return lines;
}

/** 列表形态：整棵树是嵌套无序列表。 */
function listBody(root: MindNode, options: MarkdownOptions): string[] {
  const lines: string[] = [];
  const includeNotes = options.includeNotes !== false;
  const emit = (node: MindNode, depth: number): void => {
    // 纯图片节点没有文字：不要输出一个空的 "- "，那会渲染成一个孤零零的圆点
    const text = inline(node.text);
    const hasText = node.text.trim().length > 0;
    if (hasText) lines.push("  ".repeat(depth) + "- " + text);
    const pictures = imageLines(node, options);
    const contentIndent = hasText ? depth + 1 : depth;
    if (!hasText && pictures.length === 0) {
      // 既无文字又无图：保留一个占位，避免结构里凭空少一层
      lines.push("  ".repeat(depth) + "- " + EMPTY_PLACEHOLDER);
    }
    if (includeNotes && node.note !== undefined) {
      for (const line of quote(node.note).split("\n")) {
        lines.push("  ".repeat(depth + 1) + line);
      }
    }
    for (const picture of pictures) {
      lines.push("  ".repeat(contentIndent) + picture);
    }
    for (const child of node.children) emit(child, depth + 1);
  };
  emit(root, 0);
  return lines;
}

/**
 * 把一棵导图节点树转换成 Markdown 文本。
 *
 * @param root - 根节点（不会被修改）。
 * @param options - 形态与是否包含备注/标题。
 * @returns 以换行结尾的 Markdown 文本。
 */
/**
 * 多主题导出：每个主题各占一棵树。
 *
 * 做法是**每个主题单独调 toMarkdown 再拼接**，而不是给 headingsBody 加分支——
 * 单主题那条路径一行都不动，行为完全不变。
 *
 * 带文档标题时，文档标题独占 H1，各主题下沉成 H2（否则会出现多个 H1，
 * 渲染器会把它们当成并列的一级章节）。
 *
 * @param themes - 各个主题。
 * @param options - 与 toMarkdown 相同。
 */
export function toMarkdownForest(themes: readonly MindNode[], options: MarkdownOptions = {}): string {
  const hasTitle =
    options.includeTitle === true && typeof options.title === "string" && options.title.trim().length > 0;
  const parts: string[] = [];
  if (hasTitle) parts.push("# " + inline(options.title as string));
  for (const theme of themes) {
    /*
     * 每个主题都要下沉一级（有标题时下沉两级里的那一级），
     * 靠给子节点套一层包装不现实，直接复用 toMarkdown 的 hasTitle 下沉逻辑：
     * 传一个"空标题"进去不优雅，所以这里自己调 headingsBody。
     */
    const mode: MarkdownMode = options.mode === "list" ? "list" : "headings";
    // headingsBody 里 depth+1 才是标题级别：base=1 -> "##"，正好让文档标题独占 H1
    const base = hasTitle ? 1 : 0;
    const body =
      mode === "list"
        ? listBody(theme, options).map((line) => "  " + line)
        : headingsBody(theme, options, base);
    parts.push(body.join("\n"));
  }
  return parts
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd() + "\n";
}

export function toMarkdown(root: MindNode, options: MarkdownOptions = {}): string {
  const mode: MarkdownMode = options.mode === "list" ? "list" : "headings";
  const includeNotes = options.includeNotes !== false;
  const hasTitle =
    options.includeTitle === true && typeof options.title === "string" && options.title.trim().length > 0;
  // 带标题时整棵树下沉一级，让文档标题独占唯一的 H1
  const body =
    mode === "list" ? listBody(root, options) : headingsBody(root, options, hasTitle ? 1 : 0);

  const out: string[] = [];
  if (hasTitle) {
    out.push("# " + inline(options.title as string), "");
  }
  out.push(...body);
  // 收敛连续空行：递归每到一层都可能多插一个空行，最后统一压成一个
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+$/gm, "")
    .trimEnd() + "\n";
}

/**
 * 纯列表形态的快捷入口：给"复制成大纲文本"按钮用。
 * @param root - 根节点。
 * @returns 嵌套无序列表文本。
 */
export function toOutline(root: MindNode): string {
  return toMarkdown(root, { mode: "list", includeNotes: false });
}

/**
 * 供文件名使用的安全化标题。
 * 只保留中英文数字与少数符号，其余替换成 `-`；空结果回落到 `mindmap`。
 */
export function safeFileName(title: string): string {
  const cleaned = title
    // 连续非法字符合并成一个 "-"：`a b:c*?d` 应该得到 `a b-c-d`，而不是一长串横线
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : "mindmap";
}
