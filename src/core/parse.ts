/**
 * dsh-mindmap — Markdown → 导图树 的反向解析与合并。
 *
 * 这是"用 Markdown 编辑导图"最难的一块，难点不在解析语法，而在**合并**：
 * 用户在右侧改了两个标题的字，左侧画布必须只更新那两个节点，
 * 其它节点的图片、手动拖动位置、折叠状态、稳定 id 都得原样保留。
 *
 * 合并策略（按优先级）：
 *   1. **同路径同文字** → 复用原节点（连 id 带图片位置全部保留）；
 *   2. **同路径不同文字** → 只改文字，其余字段保留；
 *   3. **新路径** → 新建节点；
 *   4. **消失的路径** → 删除。
 *
 * "路径"是「祖先文字序列」而不是下标。为什么不用下标：用户在第 3 个标题
 * 前面插了一个新标题，后续所有下标都会平移；按下标匹配会把整棵树的图片
 * 全部错位到相邻节点上——这种错误用户很难发现，但数据已经毁了。
 *
 * 支持解析的结构（与 toMarkdown 的输出对称）：
 *   - ATX 标题 `#` .. `######`，层级即深度
 *   - 嵌套无序列表 `-`，按缩进算层级（2 空格一层）
 *   - 引用块 `>` → 当备注
 *   - 图片 `![alt](src)` → 图片引用（path 模式）或内嵌（inline 模式忽略）
 *
 * 明确不做的：表格、代码块、链接以外的行内语法一律当普通文字处理。
 * 导图节点本来就只有单行文字，多花哨的语法它也表达不了。
 */

import { MAX_NODES, cleanText, type MindNode, type NodeImage } from "./tree.ts";

/** 解析出来的一个条目（还没变成节点树）。 */
export interface ParsedEntry {
  /** 文字内容。 */
  text: string;
  /** 层级：0 = 根。 */
  depth: number;
  /** 备注（来自引用块）。 */
  note?: string;
  /** 图片引用。 */
  images: Array<{ id: string; type: string; caption?: string }>;
}

/** 解析结果。 */
export interface ParseResult {
  entries: ParsedEntry[];
  /** 解析过程中的警告（比如空标题被跳过）。 */
  warnings: string[];
}

/** 从 `assets/xxx.png` 这样的路径里反推图片 id。 */
function imageIdFromSrc(src: string): { id: string; type: string } | undefined {
  // 内嵌 base64：没有 id，跳过（合并时保留原图，不新建）
  if (src.startsWith("data:")) return undefined;
  const file = src.split("/").pop() ?? "";
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const id = file.slice(0, dot);
  const ext = file.slice(dot + 1).toLowerCase();
  const type =
    ext === "jpg" || ext === "jpeg" ? "image/jpeg"
    : ext === "gif" ? "image/gif"
    : ext === "webp" ? "image/webp"
    : ext === "png" ? "image/png"
    : "";
  if (type === "" || !/^[A-Za-z0-9._-]{1,80}$/.test(id)) return undefined;
  return { id, type };
}

/**
 * 解析 Markdown 为条目列表。
 *
 * 标题与列表可以混用：标题建立层级，列表在其下继续嵌套。
 * 这是为了兼容 `toMarkdown` 在超过 6 级时自动降级成列表的行为——
 * 我们自己导出的东西必须能被自己读回来。
 *
 * @param markdown - 输入文本。
 * @returns 条目列表与警告。
 */
export function parseMarkdown(markdown: string): ParseResult {
  const lines = markdown.split(/\r?\n/);
  const entries: ParsedEntry[] = [];
  const warnings: string[] = [];

  /** 最近一个标题在各层级上的"当前条目"，用于把列表挂到正确的父级下。 */
  let lastAtDepth: ParsedEntry[] = [];

  /**
   * 当前这一段列表的基准深度（父级深度）。
   * undefined 表示还没进入列表；遇到标题或空行时重置。
   */
  let listBase: number | undefined;

  /** 正在累积的引用块（备注）。 */
  let quoteBuffer: string[] = [];
  let quoteTarget: ParsedEntry | undefined;

  const flushQuote = (): void => {
    if (quoteTarget !== undefined && quoteBuffer.length > 0) {
      const note = quoteBuffer.join("\n").trim();
      if (note.length > 0) quoteTarget.note = note;
    }
    quoteBuffer = [];
    quoteTarget = undefined;
  };

  /** 记录一个条目到栈上。 */
  const push = (entry: ParsedEntry): void => {
    entries.push(entry);
    // 截断到本层级，再放进去：depth 变浅时上层自然失效
    lastAtDepth = lastAtDepth.slice(0, entry.depth);
    lastAtDepth[entry.depth] = entry;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");

    // 空行：结束引用块
    if (line.trim().length === 0) {
      flushQuote();
      listBase = undefined;
      continue;
    }

    // 引用块（备注）
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote !== null) {
      if (quoteTarget === undefined) {
        // 引用紧跟在某个条目后面吗？找最后一个条目
        quoteTarget = entries[entries.length - 1];
      }
      quoteBuffer.push(quote[1] ?? "");
      continue;
    }
    flushQuote();

    // 图片行：`![alt](src)`，可以单独一行
    const imageLine = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (imageLine !== null) {
      const parsed = imageIdFromSrc(imageLine[2] ?? "");
      const target = entries[entries.length - 1];
      if (target === undefined) {
        warnings.push("图片前面没有任何节点，已忽略：" + line.trim());
      } else if (parsed !== undefined) {
        const caption = (imageLine[1] ?? "").trim();
        target.images.push({
          id: parsed.id,
          type: parsed.type,
          ...(caption.length > 0 ? { caption } : {}),
        });
      }
      continue;
    }

    // ATX 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const depth = heading[1].length - 1; // # = 根（depth 0）
      const text = cleanText(stripInlineImages(heading[2] ?? ""));
      if (text.length === 0) {
        warnings.push("跳过一个空标题（第 " + String(depth + 1) + " 级）");
        continue;
      }
      push({ text, depth, images: [] });
      listBase = undefined;
      continue;
    }

    // 无序列表项
    const listItem = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (listItem !== null) {
      const indent = (listItem[1] ?? "").replace(/\t/g, "  ").length;
      const text = cleanText(stripInlineImages(listItem[2] ?? ""));
      if (text.length === 0) continue;
      /*
       * 列表的基准层级必须在**这一段列表开始时**固定下来。
       *
       * 早先每行都读 lastAtDepth.length，而 push() 会往栈里塞列表项本身，
       * 于是长度一路变大：baseDepth 跟着涨，层级就越算越深
       * （`- 根 / - A / - A1` 会解析成 1 / 3 / 6 层）。
       * 现在用 listBase 记住"当前这段列表的父级深度"，遇到标题或空行才重置。
       */
      if (listBase === undefined) {
        listBase = lastAtDepth.length > 0 ? lastAtDepth.length : 1;
      }
      const depth = listBase + Math.floor(indent / 2);
      push({ text, depth, images: [] });
      continue;
    }

    // 其它内容：当成当前最后一条的续行（导图节点是单行，多余内容丢弃并记警告）
    if (entries.length > 0) {
      warnings.push("忽略了无法识别的一行：" + line.trim().slice(0, 40));
    } else {
      warnings.push("开头的非标题内容被忽略：" + line.trim().slice(0, 40));
    }
  }
  flushQuote();

  return { entries, warnings };
}

/** 去掉行内图片语法，只留文字（图片单独成行处理，混在文字里的丢弃）。 */
function stripInlineImages(text: string): string {
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, "").trim();
}

/**
 * 把条目列表还原成节点树（新建，不合并）。
 *
 * 深度回退时往回找父级：条目 depth 比前一个浅，说明回到了祖先层。
 */
export function entriesToTree(entries: ParsedEntry[]): MindNode | undefined {
  if (entries.length === 0) return undefined;

  // 虚拟根：第一个条目如果是 depth 0 就取代它
  const first = entries[0]!;
  const root: MindNode = {
    id: "",
    text: first.text,
    children: [],
    ...(first.note !== undefined ? { note: first.note } : {}),
    ...(first.images.length > 0 ? { images: first.images.map(toNodeImage) } : {}),
  };

  /** 栈：stack[d] 是当前 depth=d 的节点。 */
  const stack: Array<MindNode | undefined> = [root];
  let count = 1;

  for (let i = 1; i < entries.length; i += 1) {
    if (count >= MAX_NODES) break;
    const entry = entries[i]!;
    const depth = Math.max(1, entry.depth);
    const node: MindNode = {
      id: "",
      text: entry.text,
      children: [],
      ...(entry.note !== undefined ? { note: entry.note } : {}),
      ...(entry.images.length > 0 ? { images: entry.images.map(toNodeImage) } : {}),
    };
    // 找最近的、depth 比它小的祖先
    let parentDepth = depth - 1;
    while (parentDepth > 0 && stack[parentDepth] === undefined) parentDepth -= 1;
    const parent = stack[parentDepth] ?? root;
    parent.children.push(node);
    stack[depth] = node;
    // 更深层的栈失效
    stack.length = depth + 1;
    count += 1;
  }

  return root;
}

/** 条目里的图片引用 → 节点图片元数据（宽高未知，交给布局给默认尺寸）。 */
function toNodeImage(ref: { id: string; type: string; caption?: string }): NodeImage {
  return {
    id: ref.id,
    type: ref.type,
    name: ref.id + "." + (ref.type === "image/jpeg" ? "jpg" : ref.type.replace("image/", "")),
    ...(ref.caption !== undefined ? { caption: ref.caption } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * 合并
 * ------------------------------------------------------------------ */

/** 合并结果。 */
export interface MergeResult {
  root: MindNode;
  /** 新增节点数。 */
  added: number;
  /** 删除节点数。 */
  removed: number;
  /** 文字被修改的节点数。 */
  changed: number;
  /** 结构是否真的有变化（false 时调用方可以跳过写回与历史记录）。 */
  dirty: boolean;
}

/**
 * 把解析结果合并进现有树。
 *
 * 匹配用「路径」（祖先文字序列 + 自己在同层内的次序），而不是下标：
 * 下标在插入/删除时会整体平移，会把图片错配到相邻节点上。
 *
 * 同一路径下出现重复文字时（用户写了两个同名兄弟），用出现次序区分，
 * 保证多次编辑后仍是同一个节点。
 *
 * @param existing - 当前树。
 * @param entries - 解析出来的新结构。
 * @param makeId - 新节点的 id 生成函数（测试里可注入确定值）。
 */
export function mergeTree(
  existing: MindNode,
  entries: ParsedEntry[],
  makeId: () => string,
): MergeResult | undefined {
  const parsed = entriesToTree(entries);
  if (parsed === undefined) return undefined;

  let added = 0;
  let removed = 0;
  let changed = 0;

  /**
   * 把旧树建成「路径 → 节点」索引。
   *
   * 路径 = 逐级的 `文字#同层同名次序`，用 NUL 连接（文字里不会出现 NUL，
   * 不会与路径分隔符冲突）。用文字而不是下标做键，是为了让"在前面插入
   * 一个新节点"不会让后面所有节点的图片错配到相邻节点上。
   */
  const index = new Map<string, MindNode>();
  const buildKey = (trail: string[]): string => trail.join("\u0000");

  index.set(buildKey([existing.text + "#1"]), existing);
  const indexChildren = (list: MindNode[], prefix: string[]): void => {
    const counters = new Map<string, number>();
    for (const child of list) {
      const n = (counters.get(child.text) ?? 0) + 1;
      counters.set(child.text, n);
      const segment = child.text + "#" + String(n);
      index.set(buildKey([...prefix, segment]), child);
      indexChildren(child.children, [...prefix, segment]);
    }
  };
  indexChildren(existing.children, [existing.text + "#1"]);

  /**
   * 第二级索引：父级路径 + 序号 → 旧节点。
   * 用于"这一行的文字被改了"时，仍然认出它是原来那个节点。
   */
  /** 已经被合并过程认领的旧节点 id（防止一个旧节点被匹配两次）。 */
  const claimedOld = new Set<string>();

  /**
   * 解析结果里仍然存在的"路径+文字"集合。
   * 用来判断"某个旧节点的文字是不是真的被改掉了"——
   * 如果它还存在于新结构里，说明只是位置变了，不该走位置兜底。
   */
  const textStillPresent = new Set<string>();
  const markPresent = (node: MindNode, trail: string[]): void => {
    const key = buildKey([...trail, node.text + "#1"]);
    textStillPresent.add(key);
    for (const child of node.children) markPresent(child, [...trail, node.text + "#1"]);
  };

  const bySiblingIndex = new Map<string, MindNode>();
  const indexSiblings = (list: MindNode[], prefix: string[]): void => {
    for (let i = 0; i < list.length; i += 1) {
      const child = list[i]!;
      bySiblingIndex.set(buildKey([...prefix, "@" + String(i)]), child);
      indexSiblings(child.children, [...prefix, child.text + "#1"]);
    }
  };
  indexSiblings(existing.children, [existing.text + "#1"]);

  /**
   * 合并过程：拿解析树与旧树对撞。
   *
   * 匹配分两级，顺序很重要：
   *   ① **同路径同文字** —— 最可靠，内容没动；
   *   ② **同路径同位置** —— 用户把这一行的文字改了。
   *
   * 为什么必须有第二级：只按文字匹配的话，"改一句文字"会被当成
   * 「删掉旧节点 + 新建一个节点」，于是那个节点上的图片、拖动位置、
   * 折叠状态全部丢失。而"改文字"恰恰是编辑导图最高频的动作——
   * 这个 bug 会让用户每改一次字就丢一次图。
   *
   * 位置匹配只在**同一父级、同一序号**上兜底，不会跨父级串。
   */
  const merge = (target: MindNode, trail: string[], positionInParent: number, isRoot: boolean): MindNode => {
    const baseKey = [...trail, target.text + "#1"];
    /*
     * ① 同路径同文字。
     *
     * 必须排除"已被认领"的节点：两个同名兄弟会算出同一个路径键，
     * 若不加判，它们会双双匹配到第一个旧节点 —— 结果两个节点 id 重复、
     * 第二个旧节点被误判为"已删除"。实测出现过，数据是坏的。
     *
     * 路径键里其实已经带了"同层同名次序"（text#1 / text#2），但那个
     * 次序是**按旧树**算的；新结构里两个同名节点都会先算出 text#1，
     * 所以这里再用 claimedOld 兜一道，第一次匹配之后第二次就落到位置兜底。
     */
    const key = buildKey(baseKey);
    let old = index.get(key);
    if (old !== undefined && claimedOld.has(old.id)) {
      old = undefined;
      // 第二个及以后的同名节点：尝试取下一条同文字记录
      for (let n = 2; n <= 64; n += 1) {
        const alt = index.get(buildKey([...trail, target.text + "#" + String(n)]));
        if (alt === undefined) break;
        if (!claimedOld.has(alt.id)) {
          old = alt;
          break;
        }
      }
    }

    /*
     * ② 同路径同位置 —— 只在"这一格原本有个节点、且它没在别处被认领"时兜底。
     *
     * 单纯按序号匹配会出事：用户在列表前面插入一个新节点，新节点占住
     * 序号 0，就把原来 0 号节点的图片错配到自己身上，同时原节点也还
     * 活着（它的文字仍能通过 ① 匹配）——结果是两个节点 id 重复、
     * 图片凭空多了一份。这是实测踩到的真实 bug。
     *
     * 加两道闸：
     *   - 这个旧节点必须还没被任何人认领（claimedOld）；
     *   - 旧节点在同一父级下的**文字**在新结构里必须已经不存在
     *     （否则说明它只是被"挪后了"，不是"改了名"）。
     */
    if (old === undefined && !isRoot) {
      const siblingKey = buildKey([...trail, "@" + String(positionInParent)]);
      const candidate = bySiblingIndex.get(siblingKey);
      if (
        candidate !== undefined &&
        !claimedOld.has(candidate.id) &&
        !textStillPresent.has(buildKey([...trail, candidate.text + "#1"]))
      ) {
        old = candidate;
      }
    }

    const merged: MindNode = {
      id: old?.id ?? (isRoot ? existing.id : makeId()),
      text: target.text,
      children: [],
    };
    if (old !== undefined) claimedOld.add(old.id);

    if (target.note !== undefined) merged.note = target.note;
    else if (old?.note !== undefined) merged.note = old.note;

    if (old?.position !== undefined) merged.position = { ...old.position };
    if (old?.collapsed === true) merged.collapsed = true;
    // 图片：Markdown 里显式写了就用新的；没写就沿用旧的（关键：改文字不该丢图）
    if (target.images !== undefined && target.images.length > 0) merged.images = target.images;
    else if (old?.images !== undefined) merged.images = old.images.map((image) => ({ ...image }));

    if (old === undefined) added += 1;
    else if (old.text !== target.text) changed += 1;

    /*
     * 递归合并子级时，trail 要按**匹配到的那棵树**来拼。
     *
     * 正常情况下新旧文字一样，拼谁都一样。但父节点被改名时（走了位置兜底、
     * merged.id === old.id），子节点在旧索引里的路径是挂在**旧父文字**下的；
     * 若仍用新文字拼 trail，子节点一个都匹配不上 —— 于是整棵子树被当成
     * "全删 + 全新建"，图片和拖动位置在子树里全丢。实测就是这样丢的。
     */
    const childTrail = old !== undefined ? [...trail, old.text + "#1"] : [...trail, target.text + "#1"];
    for (let i = 0; i < target.children.length; i += 1) {
      merged.children.push(merge(target.children[i]!, childTrail, i, false));
    }
    return merged;
  };

  markPresent(parsed, []);

  const root = merge(parsed, [], 0, true);

  // 统计被删掉的：旧树里没被任何新节点认领的
  const claimed = new Set<string>();
  const collectIds = (node: MindNode): void => {
    claimed.add(node.id);
    for (const child of node.children) collectIds(child);
  };
  collectIds(root);
  const countOld = (node: MindNode): void => {
    if (!claimed.has(node.id)) removed += 1;
    for (const child of node.children) countOld(child);
  };
  countOld(existing);

  return {
    root,
    added,
    removed,
    changed,
    dirty: added > 0 || removed > 0 || changed > 0,
  };
}
