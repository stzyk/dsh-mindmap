/**
 * dsh-mindmap — 核心领域模型（Host 与 Client 半区共用）。
 *
 * 这里只放**纯函数**：不碰 DOM、不碰 Node API、不读写存储。
 * 好处有三：
 *   1. 两份产物（lib/index.js / lib/client.js）用同一份定义，树结构与
 *      Markdown 转换永远不会在两边产生分歧；
 *   2. 可以直接用 `node --test scripts/test-core.mjs` 跑单测（Node 24 原生
 *      剥离 TS 类型，无需编译）；
 *   3. Host 侧做"落盘前的结构校验"时复用的就是客户端那份 normalize。
 *
 * 不可变约定：所有写操作都先 clone 再改，调用方拿到的一定是新对象。
 * 这样 React 的 setState 与 Host 的内存缓存都不会因为共享引用而串味。
 */

import { normalizeStyle, type NodeStyle } from "./style.ts";
import { normalizeMarks, toggleMarkIn } from "./marks.ts";
/*
 * 只为"按画布上下顺序插入"算一次布局。
 * layout.ts 只以 `import type` 依赖本文件，运行期没有循环。
 */
import { layoutTree } from "./layout.ts";

/** 一个思维导图节点。 */
export interface MindNode {
  /** 稳定 id（同一文档内唯一，跨文档不要求唯一）。 */
  id: string;
  /** 节点文字，单行；换行在输入时被折叠成空格。 */
  text: string;
  /** 可选备注：不进画布显示，只在导出 Markdown 时作为引用块出现。 */
  note?: string;
  /** 是否收起子节点（true 时子树不参与布局，但仍保留在数据里）。 */
  collapsed?: boolean;
  /**
   * 连到父节点的那条线**是否断开**。
   *
   * 断开后节点仍然留在原来的父级下（结构不变、层级不变、样式不变），
   * 只是不画那条线，并且按手动坐标悬浮在原处。
   *
   * 为什么不把它从树里摘出来：树模型要求每个节点有父级，
   * 摘出来就只能挂到顶层当"主题"——那正是用户不想要的效果
   * （"断开后还是子节点，不要变成主题节点"）。
   */
  detached?: boolean;
  /**
   * 连到父节点那条线的样式。不填 = 跟随文档默认（`MindDoc.linkStyle`）。
   */
  edgeStyle?: "solid" | "dashed";
  /** 连到父节点那条线的粗细（1 / 2 / 3），缺省 1.5。 */
  edgeWidth?: number;
  /** 连到父节点那条线的颜色（hex），缺省跟随主题。 */
  edgeColor?: string;
  /**
   * 节点种类：主题 / 子节点。
   *
   * 缺省按结构推断（顶层 = 主题，其余 = 子节点）；显式设置用于
   * 在属性面板里把某个节点升成主题、或把主题降成子节点。
   */
  kind?: "theme" | "node";
  /**
   * 手动摆放的坐标（相对画布左上角）。
   *
   * 不填 = 交给自动布局（右向树）；一旦用户拖动过就有了固定位置。
   * 层级关系与它无关：这只影响"画在哪"，不影响"挂在哪"，
   * 所以导出的 Markdown 结构不会因为拖动而改变。
   */
  position?: { x: number; y: number };
  /**
   * 附在这个节点上的图片（按添加顺序）。
   *
   * 是个数组而不是单张：一个想法配两张参考图很常见，做成单张再"想加第二张
   * 就得开子节点"反而别扭。渲染时按顺序横排。
   *
   * `text` 为空 + 有图片 = **纯图片节点**，画布上只画图不画文字框。
   */
  images?: NodeImage[];
  /**
   * 节点标识（⭐ 重点、🔥 高频 ……）。key 见 core/marks.ts。
   *
   * 存 key 而不是 emoji 本身：emoji 会随系统字体变化，
   * 而 key 是稳定的——换图标只改一处，历史数据不用迁移。
   */
  marks?: string[];
  /**
   * 这条"从父节点连到本节点"的连线上的文字。
   *
   * 为什么挂在**子节点**上而不是独立建一个"边"实体：连线本身是由父子关系
   * 隐式推导出来的（没有单独的边表），给它单开一张表就要处理"节点删了边怎么办"、
   * "移动节点边跟着走吗"这类一致性问题。挂在子节点上，这些问题自然消失——
   * 边跟着节点走，删节点连带删标签。
   *
   * 根节点没有父，此字段无效（normalize 时会丢掉）。
   */
  edgeLabel?: string;
  /**
   * 外观设置（底色 / 字号 / 粗细 / 圆角 / 边框）。
   *
   * 不填 = 跟随主题与层级默认。只存**预设档位的键名**，不存具体色值——
   * 换色板时能平滑跟过去，也不会因为用户填了个深色底就把文字压没。
   * 见 src/core/style.ts 的 PALETTE 与 NodeStyle。
   */
  style?: NodeStyle;
  /** 子节点，顺序即显示顺序。 */
  children: MindNode[];
}

/**
 * 一张附加到节点上的图片。
 *
 * 只存**元数据**，字节存在 Host 的 assets 目录里（见 src/store.ts）：
 * 把 base64 塞进文档 JSON 会让存储文件迅速膨胀到几十 MB，
 * 每次保存都要重新序列化整份文档，编辑会越来越卡。
 */
export interface NodeImage {
  /** 稳定 id，同时是 assets 目录下的文件名（不含扩展名）。 */
  id: string;
  /** 原始文件名（用于导出时的可读名与下载名）。 */
  name: string;
  /** MIME 类型，决定渲染与导出扩展名。 */
  type: string;
  /** 像素尺寸（Host 端探明后写回，用于布局占位避免抖动）。 */
  width?: number;
  height?: number;
  /** 说明文字：既是 alt，也是 Markdown 的图片说明。 */
  caption?: string;
}

/** 支持的图片 MIME 白名单。 */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** 单张图片字节上限（8 MB）：再大不适合塞进导图，也拖慢保存。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** 单个文档的图片张数上限。 */
export const MAX_IMAGES_PER_DOC = 200;

/**
 * 一条**自由连线**：连接两个节点，但不改变树结构。
 *
 * 为什么和父子连线分开存：
 *   父子连线是**结构**（决定层级、布局、Markdown 大纲），一个节点只能有一个父级；
 *   自由连线是**关系**（"这两块内容有关联"），可以任意多条、双向、跨层级。
 *   把关系塞进树里会破坏"单父"前提，布局和大纲全都要重写。
 *
 * 所以画布上有两种线：
 *   - 实线 = 父子关系（结构性，拖端点会改挂/改接）
 *   - 虚线 = 自由连线（注释性，随便连，不影响大纲）
 */
export interface MindLink {
  id: string;
  /** 起点节点 id。 */
  from: string;
  /** 终点节点 id。 */
  to: string;
  /** 连线上可以写文字。 */
  label?: string;
  /**
   * 线型。缺省跟随文档默认（`MindDoc.linkStyle`）。
   *
   * 自由连线早期一律画成虚线（用来和父子连线区分），但用户反馈
   * "自己拉出来的线为什么是虚线，而且改不了"——所以也给样式开关。
   */
  style?: "solid" | "dashed";
  /** 线宽。 */
  width?: number;
  /** 线色（hex）。 */
  color?: string;
}

/** 一份导图文档。 */
export interface MindDoc {
  id: string;
  title: string;
  /**
   * 连线的默认样式。新加的线跟随它；节点上的 `edgeStyle` 优先。
   */
  linkStyle?: "solid" | "dashed";
  /**
   * 树的根。
   *
   * **单主题模式**下它就是画布上的中心节点；
   * **多主题模式**（multiTheme = true）下它退化为一个不渲染的容器，
   * 它的 children 才是画布上并列的各个中心主题。
   *
   * 为什么用"容器根"而不是把 root 改成数组：树操作（增删改、缩进、
   * 定位、路径高亮、撤销、复制）全部以单根为前提，改成森林数组要动
   * 70 多处调用点和全部测试。容器根让这些逻辑一行都不用改。
   */
  root: MindNode;
  /**
   * 多主题模式：一张画布上并列多个中心主题。
   *
   * 不设时是普通单主题导图（老文档都是这样，不需要迁移）。
   */
  multiTheme?: boolean;
  /**
   * 自由连线（不改变树结构的关系线）。
   *
   * 不设 / 空数组表示没有。老文档不需要迁移。
   */
  links?: MindLink[];
  createdAt: number;
  updatedAt: number;
}

/** 文档列表项（不含树本体，列表页不需要）。 */
export interface MindDocSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 节点总数（含已收起的子树）。 */
  nodeCount: number;
}

/** 节点文本长度上限：防止一次粘贴把画布撑爆。 */
export const MAX_TEXT = 400;
/** 备注长度上限。 */
export const MAX_NOTE = 2000;
/** 连线上文字的字符上限。连线标签是"关系说明"，不该写成长段落。 */
export const MAX_EDGE_LABEL = 120;
/** 文档标题长度上限。 */
export const MAX_TITLE = 120;
/** 单个文档的节点数上限：超过多半是误粘贴，早失败比卡死好。 */
export const MAX_NODES = 5000;
/** 手动坐标的绝对值上限（px）：挡住手改文件写出的天文数字。 */
export const MAX_COORD = 100000;

/* ------------------------------------------------------------------ *
 * id 生成
 * ------------------------------------------------------------------ */

let idSeq = 0;

/**
 * 生成节点 id。
 *
 * 不用 `crypto.randomUUID()`：它在非安全上下文（局域网 http 访问 DSH）里
 * 可能不存在，而插件不该因为访问方式不同就崩。这里用时间戳 + 自增序号 +
 * 随机后缀，同一毫秒内连续创建也不会撞。
 */
export function newId(prefix = "n"): string {
  idSeq = (idSeq + 1) % 100000;
  return (
    prefix +
    "-" +
    Date.now().toString(36) +
    "-" +
    idSeq.toString(36) +
    Math.floor(Math.random() * 1296).toString(36)
  );
}

/** 把任意文本收敛成"单行、去首尾空白、限长"的节点文字。 */
export function cleanText(value: unknown, limit = MAX_TEXT): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

/* ------------------------------------------------------------------ *
 * 构造 / 校验
 * ------------------------------------------------------------------ */

/** 造一个新节点。 */
export function createNode(text: string, children: MindNode[] = []): MindNode {
  return { id: newId(), text: cleanText(text), children };
}

/** 造一份新文档：根节点默认文字由调用方给。 */
export function createDoc(title: string, rootText: string = "中心主题", now = Date.now()): MindDoc {
  const safeTitle = cleanText(title, MAX_TITLE) || "未命名导图";
  return {
    id: newId("doc"),
    title: safeTitle,
    root: createNode(rootText),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 把任意来源（磁盘 JSON / 客户端提交 / 旧版本数据）收敛成合法节点。
 *
 * 严格白名单：只保留认识的字段，深度与节点总数都设上限。任何一处不合法
 * 都不抛错，而是**就地修复**——插件不该因为一份坏数据整份不可用。
 * @param input - 待校验的任意值。
 * @param budget - 剩余可分配节点数（跨递归共享，超限即截断）。
 * @param depth - 当前深度（用于兜底 id 前缀与深度上限）。
 */
export function normalizeNode(input: unknown, budget = { left: MAX_NODES }, depth = 0): MindNode {
  budget.left -= 1;
  const raw = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const id = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : newId();
  const node: MindNode = {
    id,
    text: cleanText(raw.text, MAX_TEXT),
    children: [],
  };
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, MAX_NOTE) : "";
  if (note.length > 0) node.note = note;
  const marks = normalizeMarks(raw.marks);
  if (marks !== undefined) node.marks = marks;
  const edgeLabel =
    typeof raw.edgeLabel === "string" ? raw.edgeLabel.replace(/\s+/g, " ").trim().slice(0, MAX_EDGE_LABEL) : "";
  if (edgeLabel.length > 0) node.edgeLabel = edgeLabel;
  if (raw.collapsed === true) node.collapsed = true;
  if (raw.detached === true) node.detached = true;
  if (raw.kind === "theme" || raw.kind === "node") node.kind = raw.kind;
  if (raw.edgeStyle === "solid" || raw.edgeStyle === "dashed") node.edgeStyle = raw.edgeStyle;
  if (typeof raw.edgeWidth === "number" && Number.isFinite(raw.edgeWidth) && raw.edgeWidth > 0 && raw.edgeWidth <= 6) {
    node.edgeWidth = raw.edgeWidth;
  }
  if (typeof raw.edgeColor === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.edgeColor.trim())) {
    node.edgeColor = raw.edgeColor.trim();
  }
  // 坐标只接受两个有限数；越界（比如手改文件写成 1e9）直接丢弃，回自动布局，
  // 否则节点会跑到画布外面再也没法点回来。
  const pos = raw.position as { x?: unknown; y?: unknown } | null | undefined;
  if (pos !== null && typeof pos === "object") {
    const x = typeof pos.x === "number" && Number.isFinite(pos.x) ? pos.x : undefined;
    const y = typeof pos.y === "number" && Number.isFinite(pos.y) ? pos.y : undefined;
    if (x !== undefined && y !== undefined && Math.abs(x) <= MAX_COORD && Math.abs(y) <= MAX_COORD) {
      node.position = { x, y };
    }
  }

  const rawImages = Array.isArray(raw.images) ? raw.images : [];
  const images: NodeImage[] = [];
  for (const entry of rawImages) {
    if (images.length >= 24) break; // 单节点张数上限：再多画布也没法读
    const img = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const imgId = typeof img.id === "string" ? img.id.trim() : "";
    const type = typeof img.type === "string" ? img.type.trim() : "";
    // id 必须是安全的文件名片段：它会直接拼进磁盘路径
    if (imgId.length === 0 || !/^[A-Za-z0-9._-]{1,80}$/.test(imgId)) continue;
    if (!(IMAGE_TYPES as readonly string[]).includes(type)) continue;
    const image: NodeImage = {
      id: imgId,
      type,
      name: cleanText(typeof img.name === "string" ? img.name : "", 120) || imgId,
    };
    if (typeof img.width === "number" && Number.isFinite(img.width) && img.width > 0) image.width = img.width;
    if (typeof img.height === "number" && Number.isFinite(img.height) && img.height > 0) image.height = img.height;
    const caption = typeof img.caption === "string" ? cleanText(img.caption, 200) : "";
    if (caption.length > 0) image.caption = caption;
    images.push(image);
  }
  if (images.length > 0) node.images = images;

  // 样式：白名单校验，非法值丢弃（不留空对象）
  const style = normalizeStyle(raw.style);
  if (style !== undefined) node.style = style;

  // 深度上限 32：再深也不会有可读性，且能挡住恶意构造的深层嵌套
  if (depth >= 32 || budget.left <= 0) return node;
  const children = Array.isArray(raw.children) ? raw.children : [];
  for (const child of children) {
    if (budget.left <= 0) break;
    node.children.push(normalizeNode(child, budget, depth + 1));
  }
  return node;
}

/** 把任意来源收敛成一份合法文档（id / 时间戳 / 标题都会补全）。 */
/** 把整棵子树标成普通子节点。 */
function markSubtreeAsNodes(node: MindNode): void {
  node.kind = "node";
  for (const child of node.children) markSubtreeAsNodes(child);
}

/**
 * 按实际层级校正每个节点的 kind。
 *
 * 层级语义：
 *   - 单主题：根节点就是主题，它的子级全是普通节点；
 *   - 多主题：根退化成不渲染的容器，它的 children 才是并列的主题。
 */
export function syncKind(root: MindNode, multiTheme: boolean): void {
  root.kind = multiTheme ? "node" : "theme";
  for (const theme of root.children) {
    if (multiTheme) {
      theme.kind = "theme";
      for (const child of theme.children) markSubtreeAsNodes(child);
    } else {
      markSubtreeAsNodes(theme);
    }
  }
}

export function normalizeDoc(input: unknown): MindDoc {
  const raw = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const now = Date.now();
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const updatedAt = typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt;
  const doc: MindDoc = {
    id: typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : newId("doc"),
    title: cleanText(raw.title, MAX_TITLE) || "未命名导图",
    root: normalizeNode(raw.root),
    createdAt,
    updatedAt,
  };
  if (raw.multiTheme === true) doc.multiTheme = true;
  /*
   * 把 kind 拉回与结构一致。
   *
   * 出过的问题：断开连线时节点被升成主题（kind = "theme"），后来重新接回树里，
   * 结构上已经是子节点了，但 kind 还留着 —— 于是 Markdown 按顶层算标题级别
   * （h1）、自动排版按主题单独排，属性面板却显示"子节点"，三处互相矛盾，
   * 而且怎么点都改不回来。
   *
   * kind 本来就只是"结构"的另一个说法，读盘时统一按实际层级校正：
   * 顶层 = 主题，其余 = 子节点。这样三处永远一致。
   */
  syncKind(doc.root, doc.multiTheme === true);
  const links = normalizeLinks(raw.links, doc.root);
  if (links !== undefined) doc.links = links;
  /*
   * 多主题模式下容器根不该有文字（它不渲染）；万一有也清掉，
   * 避免它悄悄出现在 Markdown 导出里。
   */
  if (doc.multiTheme === true) doc.root.text = "";
  else if (doc.root.text.length === 0) doc.root.text = doc.title;
  return doc;
}

/** 文档摘要（列表用）。 */
export function summarize(doc: MindDoc): MindDocSummary {
  return {
    id: doc.id,
    title: doc.title,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    nodeCount: countNodes(doc.root),
  };
}

/* ------------------------------------------------------------------ *
 * 遍历 / 查询
 * ------------------------------------------------------------------ */

/** 前序遍历所有节点。 */
export function walk(node: MindNode, visit: (node: MindNode, depth: number, parent?: MindNode) => void, depth = 0, parent?: MindNode): void {
  visit(node, depth, parent);
  for (const child of node.children) walk(child, visit, depth + 1, node);
}

/** 节点总数（含已收起的子树）。 */
export function countNodes(node: MindNode): number {
  let total = 1;
  for (const child of node.children) total += countNodes(child);
  return total;
}

/** 树的最大深度（根 = 1）。 */
export function maxDepth(node: MindNode): number {
  let deepest = 0;
  for (const child of node.children) deepest = Math.max(deepest, maxDepth(child));
  return deepest + 1;
}

/** 一次查找的结果：节点本体 + 它的父节点与在兄弟中的下标。 */
export interface NodeLocation {
  node: MindNode;
  parent?: MindNode;
  index: number;
  depth: number;
}

/** 按 id 查节点；找不到返回 undefined。 */
export function locate(root: MindNode, id: string): NodeLocation | undefined {
  const found: { value?: NodeLocation } = {};
  walk(root, (node, depth, parent) => {
    if (found.value !== undefined || node.id !== id) return;
    const index = parent === undefined ? 0 : parent.children.indexOf(node);
    found.value = { node, parent, index, depth };
  });
  return found.value;
}

/**
 * 从根到目标节点的路径（含两端）。
 * 用途：画布上的"路径高亮"——选中一个节点时，整条祖先链点亮，
 * 这样在深树里永远知道自己站在哪一格。
 */
export function pathTo(root: MindNode, id: string): MindNode[] {
  const trail: MindNode[] = [];
  const probe = (node: MindNode): boolean => {
    trail.push(node);
    if (node.id === id) return true;
    for (const child of node.children) {
      if (probe(child)) return true;
    }
    trail.pop();
    return false;
  };
  return probe(root) ? trail : [];
}

/* ------------------------------------------------------------------ *
 * 结构操作（全部返回新树，不动入参）
 * ------------------------------------------------------------------ */

/** 深拷贝一棵树（结构化克隆，避免共享引用被后续操作改写）。 */
export function cloneNode(node: MindNode): MindNode {
  const copy: MindNode = { id: node.id, text: node.text, children: node.children.map(cloneNode) };
  if (node.note !== undefined) copy.note = node.note;
  if (node.marks !== undefined && node.marks.length > 0) copy.marks = [...node.marks];
  if (node.edgeLabel !== undefined) copy.edgeLabel = node.edgeLabel;
  if (node.collapsed === true) copy.collapsed = true;
  if (node.detached === true) copy.detached = true;
  if (node.kind !== undefined) copy.kind = node.kind;
  if (node.edgeStyle !== undefined) copy.edgeStyle = node.edgeStyle;
  if (node.edgeWidth !== undefined) copy.edgeWidth = node.edgeWidth;
  if (node.edgeColor !== undefined) copy.edgeColor = node.edgeColor;
  if (node.position !== undefined) copy.position = { x: node.position.x, y: node.position.y };
  if (node.images !== undefined && node.images.length > 0) copy.images = node.images.map((image) => ({ ...image }));
  if (node.style !== undefined) copy.style = { ...node.style };
  return copy;
}

/**
 * 在一个节点的末尾插入子节点。
 * @param root - 当前树（不会被修改）。
 * @param parentId - 目标父节点 id。
 * @param text - 新节点文字。
 * @returns 新树与新节点 id；父节点不存在时返回 undefined。
 */
export function insertChild(
  root: MindNode,
  parentId: string,
  text: string,
): { root: MindNode; id: string } | undefined {
  if (countNodes(root) >= MAX_NODES) return undefined;
  const next = cloneNode(root);
  const target = locate(next, parentId);
  if (target === undefined) return undefined;
  const node = createNode(text);
  target.node.children.push(node);
  // 新加子节点时自动展开父节点：否则用户按了 Tab 却什么都没发生
  delete target.node.collapsed;
  return { root: next, id: node.id };
}

/**
 * 在某个节点之后插入同级节点。
 * 根节点没有兄弟，此时退化为"插入子节点"。
 */
export function insertSibling(
  root: MindNode,
  id: string,
  text: string,
): { root: MindNode; id: string } | undefined {
  if (countNodes(root) >= MAX_NODES) return undefined;
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  const node = createNode(text);
  if (target.parent === undefined) {
    target.node.children.push(node);
    delete target.node.collapsed;
  } else {
    target.parent.children.splice(target.index + 1, 0, node);
  }
  return { root: next, id: node.id };
}

/**
 * 删除节点（连同子树）。
 * 根节点不允许删除——导图必须有一个中心，删空会得到一个无法渲染的空画布。
 * 删掉后把焦点交给"下一个兄弟，没有则上一个兄弟，再没有则父节点"，
 * 这是大纲编辑器的通行手感。
 */
export function removeNode(root: MindNode, id: string): { root: MindNode; focusId: string } | undefined {
  if (root.id === id) return undefined;
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined || target.parent === undefined) return undefined;
  const siblings = target.parent.children;
  siblings.splice(target.index, 1);
  const focus = siblings[target.index] ?? siblings[target.index - 1] ?? target.parent;
  return { root: next, focusId: focus.id };
}

/** 改节点文字。 */
export function setText(root: MindNode, id: string, text: string): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  target.node.text = cleanText(text);
  return next;
}

/** 改节点备注（空字符串 = 删除备注）。 */
export function setNote(root: MindNode, id: string, note: string): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  const value = note.trim().slice(0, MAX_NOTE);
  if (value.length === 0) delete target.node.note;
  else target.node.note = value;
  return next;
}

/** 折叠 / 展开。根节点不折叠（整张图会消失）。 */
export function toggleCollapse(root: MindNode, id: string): MindNode | undefined {
  if (root.id === id) return undefined;
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  if (target.node.collapsed === true) delete target.node.collapsed;
  else target.node.collapsed = true;
  return next;
}

/** 在兄弟之间上移 / 下移。 */
export function moveSibling(root: MindNode, id: string, direction: -1 | 1): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined || target.parent === undefined) return undefined;
  const siblings = target.parent.children;
  const to = target.index + direction;
  if (to < 0 || to >= siblings.length) return undefined;
  const [moved] = siblings.splice(target.index, 1);
  siblings.splice(to, 0, moved);
  return next;
}

/**
 * 缩进：变成前一个兄弟的最后一个子节点。
 * 没有前一个兄弟时无法缩进（会掉出父级），返回 undefined。
 */
export function indentNode(root: MindNode, id: string): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined || target.parent === undefined || target.index === 0) return undefined;
  const targetParent = target.parent;
  const previous = targetParent.children[target.index - 1];
  const [moved] = targetParent.children.splice(target.index, 1);
  previous.children.push(moved);
  delete previous.collapsed;
  return next;
}

/**
 * 取消缩进：升级成父节点的下一个兄弟。
 * 父节点是根时无法取消缩进（根不会有兄弟）。
 */
export function outdentNode(root: MindNode, id: string): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined || target.parent === undefined) return undefined;
  const parentLoc = locate(next, target.parent.id);
  if (parentLoc === undefined || parentLoc.parent === undefined) return undefined;
  const siblings = target.parent.children;
  const [moved] = siblings.splice(target.index, 1);
  parentLoc.parent.children.splice(parentLoc.index + 1, 0, moved);
  return next;
}

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

/** 命中节点（列表 / 搜索用）。 */
export interface SearchHit {
  id: string;
  text: string;
  depth: number;
  path: string;
}

/**
 * 全文搜索节点文字，返回带路径的命中项。
 * 路径用 " / " 连接祖先文字，方便在列表里定位"这句话在树枝的哪一端"。
 */
export function searchNodes(root: MindNode, query: string, limit = 30): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const hits: SearchHit[] = [];
  const trail: string[] = [];
  const probe = (node: MindNode, depth: number): void => {
    trail.push(node.text);
    if (node.text.toLowerCase().includes(needle) && hits.length < limit) {
      hits.push({ id: node.id, text: node.text, depth, path: trail.join(" / ") });
    }
    for (const child of node.children) {
      if (hits.length >= limit) break;
      probe(child, depth + 1);
    }
    trail.pop();
  };
  probe(root, 0);
  return hits;
}

/* ------------------------------------------------------------------ *
 * 手动摆放
 * ------------------------------------------------------------------ */

/**
 * 设置一个节点的固定坐标（拖动结束后调用）。
 * @param root - 当前树（不会被修改）。
 * @param id - 目标节点。
 * @param x - 画布坐标。
 * @param y - 画布坐标。
 * @returns 新树；节点不存在或坐标非法时返回 undefined。
 */
export function setPosition(root: MindNode, id: string, x: number, y: number): MindNode | undefined {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) return undefined;
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  target.node.position = { x: Math.round(x), y: Math.round(y) };
  return next;
}

/**
 * 清除一个节点的手动坐标（回到自动布局），含其所有子孙。
 *
 * 子孙一起清是有意的：用户点"这个节点回到自动布局"时，他期望的是
 * "这一支恢复整齐"，而不是父节点归位、子节点还散在外面。
 */
export function clearPosition(root: MindNode, id: string): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  const wipe = (node: MindNode): void => {
    delete node.position;
    for (const child of node.children) wipe(child);
  };
  wipe(target.node);
  return next;
}

/**
 * 清除整棵树的手动坐标（"重新排版"按钮）。
 *
 * 返回一棵与新树；如果没有节点带坐标，原样返回（调用方可以据此跳过保存）。
 */
export function clearAllPositions(root: MindNode): MindNode {
  const next = cloneNode(root);
  const wipe = (node: MindNode): void => {
    delete node.position;
    for (const child of node.children) wipe(child);
  };
  wipe(next);
  return next;
}

/** 是否有任何节点被手动摆放（用于按钮的禁用态）。 */
export function hasManualPositions(root: MindNode): boolean {
  let found = false;
  walk(root, (node) => {
    if (node.position !== undefined) found = true;
  });
  return found;
}

/* ------------------------------------------------------------------ *
 * 节点图片
 * ------------------------------------------------------------------ */

/** 一张图片是否是"只有图片"的形态：取消图片后节点会变成完全空白。 */
export function isEmptyNode(node: MindNode): boolean {
  return node.text.trim().length === 0;
}

/**
 * 给节点追加一张图片。
 * @param root - 当前树（不会被修改）。
 * @param id - 目标节点。
 * @param image - 图片元数据。
 * @returns 新树；节点不存在或超过张数上限时返回 undefined。
 */
export function attachImage(root: MindNode, id: string, image: NodeImage): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  const list = target.node.images ?? [];
  if (list.length >= 24) return undefined;
  if (list.some((entry) => entry.id === image.id)) return undefined;
  target.node.images = [...list, { ...image }];
  return next;
}

/** 从节点上移除一张图片。清空后删掉字段（没有 images 比 images: [] 更干净）。 */
export function detachImage(root: MindNode, id: string, imageId: string): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined || target.node.images === undefined) return undefined;
  const remaining = target.node.images.filter((entry) => entry.id !== imageId);
  if (remaining.length === 0) delete target.node.images;
  else target.node.images = remaining;
  return next;
}

/** 改某张图片的说明文字。 */
export function setImageCaption(
  root: MindNode,
  nodeId: string,
  imageId: string,
  caption: string,
): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, nodeId);
  if (target === undefined || target.node.images === undefined) return undefined;
  const image = target.node.images.find((entry) => entry.id === imageId);
  if (image === undefined) return undefined;
  const value = cleanText(caption, 200);
  if (value.length === 0) delete image.caption;
  else image.caption = value;
  return next;
}

/** 收集整棵树用到的所有图片（导出图片包、清理孤儿文件都用它）。 */
export function collectImages(root: MindNode): NodeImage[] {
  const found: NodeImage[] = [];
  const seen = new Set<string>();
  walk(root, (node) => {
    for (const image of node.images ?? []) {
      if (seen.has(image.id)) continue;
      seen.add(image.id);
      found.push({ ...image });
    }
  });
  return found;
}

/** 文档里有多少张图片。 */
export function countImages(root: MindNode): number {
  let total = 0;
  walk(root, (node) => {
    total += node.images?.length ?? 0;
  });
  return total;
}

/**
 * 批量平移多个节点的位置（框选后整体拖动）。
 *
 * 为什么要"平移"而不是"设成某个坐标"：多选拖动时用户拖的是**这一组**，
 * 每个节点各自的相对位置必须保留（否则一拖就全叠到一起）。
 * 所以只把同一个位移量加到每个节点上。
 *
 * 没有手动位置的节点：以它当前的自动布局位置为基准加位移——
 * 否则"从没拖过的节点"一被框选拖动就会跳到画布原点。
 *
 * @param root - 当前树（不会被修改）。
 * @param ids - 要平移的节点 id。
 * @param dx - 位移量（画布坐标）。
 * @param dy - 位移量。
 * @param baseOf - 取节点当前自动布局坐标的回调（由布局层提供）。
 * @returns 新树；无有效节点时返回 undefined。
 */
export function moveNodes(
  root: MindNode,
  ids: readonly string[],
  dx: number,
  dy: number,
  baseOf: (id: string) => { x: number; y: number } | undefined,
): MindNode | undefined {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return undefined;
  if (Math.abs(dx) > MAX_COORD || Math.abs(dy) > MAX_COORD) return undefined;
  const next = cloneNode(root);
  let touched = 0;
  for (const id of ids) {
    const target = locate(next, id);
    if (target === undefined) continue;
    const base = target.node.position ?? baseOf(id);
    if (base === undefined) continue;
    const x = Math.round(base.x + dx);
    const y = Math.round(base.y + dy);
    if (Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) continue;
    target.node.position = { x, y };
    touched += 1;
  }
  return touched > 0 ? next : undefined;
}

/* ------------------------------------------------------------------ *
 * 复制节点（含子树）
 * ------------------------------------------------------------------ */

/**
 * 深拷贝一棵子树，并给其中**每个节点**换一个新 id。
 *
 * 为什么必须换 id：id 是节点在同一文档内的唯一标识，选中、撤销栈、
 * 图片归属、Markdown 合并的路径匹配全都依赖它。直接复用原 id 会造成
 * 两个节点 id 相同 —— 选中一个会同时点亮两个，删除一个会连带删掉另一个，
 * 这类问题在数据层就已经坏了，界面上却未必立刻看得出来。
 *
 * 不换的只有图片 id：图片字节按 id 存在磁盘上，两份节点共用同一张图是
 * 正确语义（`collectImages` 按 id 去重，`reconcile` 也不会误删）。
 *
 * @param node - 源节点（不会被修改）。
 * @param makeId - id 生成函数（测试可注入确定性实现）。
 * @param offset - 若提供，给所有节点的 position 加上这个位移。
 */
export function cloneSubtreeWithNewIds(
  node: MindNode,
  makeId: () => string,
  offset?: { dx: number; dy: number },
): MindNode {
  const copy: MindNode = {
    id: makeId(),
    text: node.text,
    children: node.children.map((child) => cloneSubtreeWithNewIds(child, makeId, offset)),
  };
  if (node.note !== undefined) copy.note = node.note;
  if (node.marks !== undefined && node.marks.length > 0) copy.marks = [...node.marks];
  if (node.edgeLabel !== undefined) copy.edgeLabel = node.edgeLabel;
  if (node.collapsed === true) copy.collapsed = true;
  if (node.style !== undefined) copy.style = { ...node.style };
  if (node.images !== undefined && node.images.length > 0) {
    copy.images = node.images.map((image) => ({ ...image }));
  }
  if (node.position !== undefined) {
    copy.position = offset === undefined
      ? { x: node.position.x, y: node.position.y }
      : { x: node.position.x + offset.dx, y: node.position.y + offset.dy };
  }
  return copy;
}

/** 复制时新节点相对原节点的偏移量（画布坐标）。 */
const DUPLICATE_OFFSET = 28;

/**
 * 复制一个节点（连同整棵子树），插入为它的下一个同级。
 *
 * 位置处理：手动摆放过的节点，副本整体偏移一点，否则会**完全重叠**在原节点上，
 * 用户看不出复制成功了。没有手动位置的节点不设 position，交给自动布局重新排。
 *
 * @returns 新树与新节点 id；根节点（没有父级）不可复制，返回 undefined。
 */
export function duplicateNode(
  root: MindNode,
  id: string,
  makeId: () => string = newId,
): { root: MindNode; id: string } | undefined {
  const source = locate(root, id);
  if (source === undefined) return undefined;
  // 根节点没有同级，"复制根"会变成两个根，语义不成立
  if (source.parent === undefined) return undefined;

  // 容量检查：整棵子树都要装得下，不能只看一个节点
  const subtreeSize = countNodes(source.node);
  if (countNodes(root) + subtreeSize > MAX_NODES) return undefined;

  const copy = cloneSubtreeWithNewIds(source.node, makeId, {
    dx: DUPLICATE_OFFSET,
    dy: DUPLICATE_OFFSET,
  });
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined || target.parent === undefined) return undefined;
  target.parent.children.splice(target.index + 1, 0, copy);
  return { root: next, id: copy.id };
}

/**
 * 批量复制多个节点（每个都连同子树）。
 *
 * 逐个复制而不是一次算好所有插入点：每复制一个，父级的 children 下标就会变，
 * 而 `duplicateNode` 每次都重新 `locate`，所以不会错位。
 * 已复制的节点不会再次被复制（避免同一批里重复处理）。
 *
 * @returns 新树与所有新节点 id；一个都没复制成功时返回 undefined。
 */
export function duplicateNodes(
  root: MindNode,
  ids: readonly string[],
  makeId: () => string = newId,
): { root: MindNode; ids: string[] } | undefined {
  let current = root;
  const created: string[] = [];
  for (const id of ids) {
    const result = duplicateNode(current, id, makeId);
    if (result === undefined) continue;
    current = result.root;
    created.push(result.id);
  }
  return created.length > 0 ? { root: current, ids: created } : undefined;
}

/* ------------------------------------------------------------------ *
 * 连线文字
 * ------------------------------------------------------------------ */

/**
 * 设置一条连线上的文字（连线 = 父 -> 本节点）。
 *
 * @param id - 连线指向的那个节点（子节点）。
 * @param text - 文字；空字符串表示清除。
 * @returns 新树；根节点（没有连线）或节点不存在时返回 undefined。
 */
export function setEdgeLabel(root: MindNode, id: string, text: string): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  // 根节点上方没有连线，给它写标签没有意义
  if (target.parent === undefined) return undefined;
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_EDGE_LABEL);
  if (clean.length === 0) delete target.node.edgeLabel;
  else target.node.edgeLabel = clean;
  return next;
}

/* ------------------------------------------------------------------ *
 * 重新挂接父级（拖动连线换关联）
 * ------------------------------------------------------------------ */

/**
 * 把节点（连同子树）挂到另一个父节点下。
 *
 * 这是"拖动连线改关联"的底层操作：连线由父子关系推导，
 * 所以"把线连到别的节点" = 把子节点换一个父节点。
 *
 * 拒绝的情况：
 *   - 目标不存在 / 要移动的是根节点（根没有父级）；
 *   - 挂到自己身上；
 *   - 挂到自己的**子孙**上（会形成环，整棵子树从根上脱落后变成孤岛）。
 *
 * @param index - 插入到新父级的第几个位置；省略则追加到末尾。
 * @returns 新树；不合法时返回 undefined。
 */
export function reparentNode(
  root: MindNode,
  id: string,
  newParentId: string,
  index?: number,
): MindNode | undefined {
  if (id === newParentId) return undefined;
  const source = locate(root, id);
  if (source === undefined || source.parent === undefined) return undefined;
  const target = locate(root, newParentId);
  if (target === undefined) return undefined;
  // 新父级不能在自己的子树里（含自己）
  if (pathTo(root, newParentId).some((node) => node.id === id)) return undefined;
  // 已经是这个父级的直接子节点：没有可做的事，返回 undefined 让调用方提示
  if (source.parent.id === newParentId) return undefined;

  const next = cloneNode(root);
  const moved = locate(next, id);
  if (moved === undefined || moved.parent === undefined) return undefined;
  moved.parent.children.splice(moved.index, 1);

  const parent = locate(next, newParentId);
  if (parent === undefined) return undefined;
  // 换父级后如果父级是折叠的，展开它，否则节点"消失"了（用户会以为丢了）
  delete parent.node.collapsed;
  const at = index === undefined ? parent.node.children.length : Math.max(0, Math.min(index, parent.node.children.length));
  parent.node.children.splice(at, 0, moved.node);
  /*
   * 接回树里之后，"断开的线"和"它是主题"这两个标记都必须清掉。
   *
   * 否则会出现：节点明明已经挂在别人下面了，kind 还写着 theme ——
   * Markdown 按顶层给 h1、排版把它当主题单独排，属性面板却显示"子节点"，
   * 三处互相矛盾且改不回来（用户实测报的就是这个）。
   */
  delete moved.node.detached;
  delete moved.node.kind;
  return next;
}

/* ------------------------------------------------------------------ *
 * 多主题
 * ------------------------------------------------------------------ */

/** 新建一个空主题节点。 */
function newTheme(text: string): MindNode {
  return createNode(text);
}

/**
 * 把单主题文档升级成多主题：当前主题成为第一个，再追加一个新主题。
 *
 * 容器根用**新 id**、旧根保留原 id：旧根可能正被选中，保留它的 id
 * 可以让选中态在转换后继续有效（虽然转换时通常会改选新主题）。
 *
 * @returns 新树（容器根）与新主题 id；已经是多主题时直接追加一个主题。
 */
export function addTheme(
  root: MindNode,
  multiTheme: boolean,
  text: string,
  position?: { x: number; y: number },
): { root: MindNode; themeId: string } {
  const theme = newTheme(text);
  /*
   * 带坐标时把新主题钉在这个位置（双击空白处新建就是这种情况）。
   * 布局层会识别手动坐标、让该主题不参与纵向自动堆叠。
   */
  if (position !== undefined) theme.position = { x: position.x, y: position.y };
  if (multiTheme) {
    const next = cloneNode(root);
    next.children.push(theme);
    return { root: next, themeId: theme.id };
  }
  // 升级：原根变成第一个主题，外面套一个不渲染的容器
  const container: MindNode = {
    id: newId(),
    text: "",
    children: [cloneNode(root), theme],
  };
  return { root: container, themeId: theme.id };
}

/**
 * 把多主题文档降回单主题（只剩一个主题时用）。
 *
 * @returns 新根（就是那个主题）；不是多主题、或主题数不为 1 时返回 undefined。
 */
export function collapseToSingleTheme(root: MindNode, multiTheme: boolean): MindNode | undefined {
  if (!multiTheme) return undefined;
  if (root.children.length !== 1) return undefined;
  return cloneNode(root.children[0]!);
}

/** 多主题文档里的各个主题（单主题时返回空数组）。 */
export function themesOf(root: MindNode, multiTheme: boolean): MindNode[] {
  return multiTheme ? root.children : [];
}

/**
 * 原地替换一张图片（保持位置与顺序不变）。
 *
 * 为什么不是"删掉再加一张"：那样图片会跑到最后，用户明明只换了一张图，
 * 其它图片的顺序却变了。这里只换字节来源（id / type / 尺寸），
 * **顺序和说明文字都保留**——说明是对这张图的描述，换图后通常仍然成立。
 *
 * @param next - 新的图片元数据（id/type/width/height）。
 * @returns 新树；节点或图片不存在时返回 undefined。
 */
export function replaceImage(
  root: MindNode,
  nodeId: string,
  imageId: string,
  next: { id: string; type: string; width?: number; height?: number; name?: string },
): MindNode | undefined {
  const tree = cloneNode(root);
  const target = locate(tree, nodeId);
  if (target === undefined || target.node.images === undefined) return undefined;
  const index = target.node.images.findIndex((entry) => entry.id === imageId);
  if (index < 0) return undefined;
  // 新图不能和同一节点上已有的其它图片撞 id
  if (target.node.images.some((entry, i) => i !== index && entry.id === next.id)) return undefined;
  const old = target.node.images[index]!;
  const replacement: NodeImage = {
    id: next.id,
    type: next.type,
    name: next.name ?? old.name,
  };
  if (next.width !== undefined) replacement.width = next.width;
  if (next.height !== undefined) replacement.height = next.height;
  if (old.caption !== undefined) replacement.caption = old.caption;
  target.node.images[index] = replacement;
  return tree;
}

/* ------------------------------------------------------------------ *
 * 节点标识
 * ------------------------------------------------------------------ */

/**
 * 切换节点上的某个标识（有则去掉，没有则加上）。
 *
 * @returns 新树；节点不存在时返回 undefined。
 *          标识已满时原样返回（调用方通过 `marksFull` 决定是否提示）。
 */
export function toggleMark(root: MindNode, id: string, key: string): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  const marks = toggleMarkIn(target.node.marks, key);
  if (marks === undefined || marks.length === 0) delete target.node.marks;
  else target.node.marks = marks;
  return next;
}

/** 清空节点的所有标识。 */
export function clearMarks(root: MindNode, id: string): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  delete target.node.marks;
  return next;
}

/* ------------------------------------------------------------------ *
 * 删除连线：子节点变成自由主题
 * ------------------------------------------------------------------ */

/**
 * 删除一条连线：把子节点（连同子树）从父级摘下来，升格为一个**自由主题**。
 *
 * 为什么是"升格成主题"而不是"删掉整棵子树"：
 * 用户想表达的是"这条关系不成立了"，节点内容本身还是要的。
 * 直接删子树会把辛苦整理的内容一起丢掉。
 *
 * 单主题文档要先升级成多主题——因为自由主题必须和原主题并列，
 * 而并列的前提就是容器根。这和点「＋ 主题」走的是同一次转换。
 *
 * @returns 新树、新的多主题标记、以及升格后的主题 id；
 *          节点不存在 / 是根节点 / 本来就是主题（没有上级连线）时返回 undefined。
 */
export function detachToTheme(
  root: MindNode,
  multiTheme: boolean,
  childId: string,
  position?: { x: number; y: number },
): { root: MindNode; multiTheme: boolean; themeId: string } | undefined {
  // 单主题：先把当前根包成容器，原主题成为第一个
  let base = root;
  if (!multiTheme) {
    base = { id: newId(), text: "", children: [cloneNode(root)] };
  }

  const next = cloneNode(base);
  const target = locate(next, childId);
  // 没有父级 = 根节点；父级是容器 = 它本来就是个主题，没有可删的连线
  if (target === undefined || target.parent === undefined) return undefined;
  if (target.parent.id === next.id) return undefined;

  target.parent.children.splice(target.index, 1);
  /*
   * 升格成主题后**保持原来的位置**（用户要求 v0.16.0）。
   *
   * 原来这里 delete position，让它回到自动堆叠——结果是"删掉一条线，
   * 节点跳到别的地方去了"，用户会以为点错了。现在由调用方把当前布局坐标
   * 传进来钉住；没传才退回自动布局。
   */
  if (position !== undefined) target.node.position = { x: position.x, y: position.y };
  else delete target.node.position;
  next.children.push(target.node);
  return { root: next, multiTheme: true, themeId: target.node.id };
}

/* ------------------------------------------------------------------ *
 * 改接线的另一端（把这条线指向另一个节点）
 * ------------------------------------------------------------------ */

/**
 * 把一条连线**指向的节点**换掉：`from -> oldChild` 变成 `from -> newChild`。
 *
 * 这就是"拖连线尾端到别的节点"的正确语义（用户反馈 v0.16.0）：
 * 拖的是线头，改的应该是**这条线连到谁**，而不是把原节点搬走。
 * 之前的实现把"被拖的那一端所属的节点"整个挪到落点上，于是
 * `1 -> 2` 拖尾端到 3 变成了 `2 -> 3`，和用户的直觉相反。
 *
 * 原节点（oldChild）会像"删掉连线"一样升格成自由主题，内容不丢。
 *
 * @param position - oldChild 升格后要钉住的位置（传当前布局坐标就能原地不动）。
 * @returns 新树、多主题标记、以及新旧两个节点 id。
 */
export function repointEdge(
  root: MindNode,
  multiTheme: boolean,
  oldChildId: string,
  newChildId: string,
  position?: { x: number; y: number },
): { root: MindNode; multiTheme: boolean; themeId: string; movedId: string } | undefined {
  if (oldChildId === newChildId) return undefined;

  const source = locate(root, oldChildId);
  if (source === undefined || source.parent === undefined) return undefined;
  // 主题是一级子节点，它的"连线"就是主题本身，不能改接
  if (source.parent.id === root.id && multiTheme) return undefined;
  const parentId = source.parent.id;
  if (parentId === newChildId) return undefined;

  const target = locate(root, newChildId);
  if (target === undefined) return undefined;
  /*
   * 环检测的方向别搞反。
   *
   * 我们要把 newChild 挂到 parentId 下面，成环的条件是：
   * **parentId 在 newChild 的子树里**（也就是 newChild 是 parentId 的祖先）。
   * 所以要看 parentId 的祖先链里有没有 newChild。
   *
   * 早先写成了"看 newChild 的祖先链里有没有 parentId"，那是反的：
   * 只要 parentId 是根节点，任何改接都会被拦下（根永远在祖先链里）。
   */
  if (pathTo(root, parentId).some((node) => node.id === newChildId)) return undefined;
  // 新节点不能已经是这个父级的子节点
  if (target.parent !== undefined && target.parent.id === parentId) return undefined;

  // 先把原节点摘下来升格成自由主题
  const detached = detachToTheme(root, multiTheme, oldChildId, position);
  if (detached === undefined) return undefined;

  // 再把新节点挂到原来的父级下
  const next = cloneNode(detached.root);
  const parent = locate(next, parentId);
  const moving = locate(next, newChildId);
  if (parent === undefined || moving === undefined || moving.parent === undefined) return undefined;
  moving.parent.children.splice(moving.index, 1);
  delete parent.node.collapsed;
  parent.node.children.push(moving.node);
  // 换父级后原来的手动坐标不再适用
  delete moving.node.position;

  return {
    root: next,
    multiTheme: detached.multiTheme,
    themeId: oldChildId,
    movedId: newChildId,
  };
}

/* ------------------------------------------------------------------ *
 * 自由连线
 * ------------------------------------------------------------------ */

/** 一份文档最多多少条自由连线（再多画布就没法读了）。 */
export const MAX_LINKS = 500;

/**
 * 规范化自由连线列表。
 *
 * 丢弃的：端点不存在的（节点可能已经被删掉）、自己连自己的、重复的。
 * 这些在删节点时也会主动清理，这里是兜底（比如手改 JSON）。
 */
export function normalizeLinks(input: unknown, root: MindNode): MindLink[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const ids = new Set<string>();
  const walk = (node: MindNode): void => {
    ids.add(node.id);
    for (const child of node.children) walk(child);
  };
  walk(root);

  const out: MindLink[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (out.length >= MAX_LINKS) break;
    const raw = entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const from = typeof raw.from === "string" ? raw.from.trim() : "";
    const to = typeof raw.to === "string" ? raw.to.trim() : "";
    if (from === to) continue;
    // 端点必须都还在
    if (!ids.has(from) || !ids.has(to)) continue;
    // 同一对节点之间只留一条（不管方向）
    const pairKey = from < to ? from + "|" + to : to + "|" + from;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    const id = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id.trim() : newId("lnk");
    const label =
      typeof raw.label === "string" ? raw.label.replace(/\s+/g, " ").trim().slice(0, MAX_EDGE_LABEL) : "";
    const style = raw.style === "solid" || raw.style === "dashed" ? raw.style : undefined;
    const base: MindLink = { id, from, to };
    if (label.length > 0) base.label = label;
    if (style !== undefined) base.style = style;
    if (typeof raw.width === "number" && Number.isFinite(raw.width) && raw.width > 0 && raw.width <= 6) {
      base.width = raw.width;
    }
    if (typeof raw.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(raw.color.trim())) {
      base.color = raw.color.trim();
    }
    out.push(base);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 新增一条自由连线。
 *
 * @returns 新的连线列表；端点不合法 / 已存在 / 数量超限时返回 undefined。
 */
export function addLink(links: readonly MindLink[] | undefined, from: string, to: string): MindLink[] | undefined {
  if (from === to) return undefined;
  const current = links ?? [];
  if (current.length >= MAX_LINKS) return undefined;
  if (current.some((link) => (link.from === from && link.to === to) || (link.from === to && link.to === from))) {
    return undefined;
  }
  return [...current, { id: newId("lnk"), from, to }];
}

/** 删除一条自由连线。 */
export function removeLink(links: readonly MindLink[] | undefined, id: string): MindLink[] | undefined {
  if (links === undefined) return undefined;
  const next = links.filter((link) => link.id !== id);
  if (next.length === links.length) return undefined;
  return next.length > 0 ? next : undefined;
}

/** 设置自由连线上的文字（空串表示清除）。 */
export function setLinkLabel(
  links: readonly MindLink[] | undefined,
  id: string,
  text: string,
): MindLink[] | undefined {
  if (links === undefined) return undefined;
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_EDGE_LABEL);
  let hit = false;
  const next = links.map((link) => {
    if (link.id !== id) return link;
    hit = true;
    const copy: MindLink = { id: link.id, from: link.from, to: link.to };
    if (clean.length > 0) copy.label = clean;
    return copy;
  });
  return hit ? (next.length > 0 ? next : undefined) : undefined;
}

/** 清掉指向已删除节点的自由连线（删节点时调用）。 */
export function pruneLinks(links: readonly MindLink[] | undefined, root: MindNode): MindLink[] | undefined {
  if (links === undefined || links.length === 0) return undefined;
  const ids = new Set<string>();
  const walk = (node: MindNode): void => {
    ids.add(node.id);
    for (const child of node.children) walk(child);
  };
  walk(root);
  const next = links.filter((link) => ids.has(link.from) && ids.has(link.to));
  return next.length > 0 ? next : undefined;
}

/* ------------------------------------------------------------------ *
 * 断开连线（节点留在原地，不变主题）
 * ------------------------------------------------------------------ */

/**
 * 断开一条连线。
 *
 * **节点不出树**：它仍然是原来那个父级的子节点，层级、样式、子树全都不变，
 * 只是不再画那条线，并按给定的当前位置悬浮。
 *
 * 这和"升格成自由主题"是两种不同需求：
 *   - 升格：用户想把这块内容独立出来当一张新图；
 *   - 断开：用户只是觉得"这条关系不成立"，节点本身还留在原来的层级里。
 * 早期实现一律走升格，导致"断一条线，节点跳成主题、层级和样式都变了"。
 *
 * @param position - 节点当前的布局坐标（传进来就能原地不动）。
 * @returns 新树；节点不存在 / 是根节点 / 本来就没有连线时返回 undefined。
 */
export function disconnectNode(
  root: MindNode,
  id: string,
  position?: { x: number; y: number },
): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  // 根节点没有上级连线
  if (target.parent === undefined) return undefined;
  // 已经是顶层（主题）的节点，本来就没有连线
  if (target.parent.id === next.id && next.children.length > 0 && next.text.length === 0) return undefined;
  target.node.detached = true;
  /*
   * 不要钉坐标。
   *
   * 断开连线**不改变树结构**（节点还在原父级的同一个位置），
   * 所以自动布局算出来的坐标和断开前完全一致——钉一个手动坐标反而是多余的，
   * 而且一旦传进来的值和布局有偏差，节点就会跳一下。
   * 原本就有手动坐标的节点保留原坐标。
   */
  void position;
  return next;
}

/**
 * 设置节点种类。
 *
 * @param kind - "theme" 升成顶层主题；"node" 降成普通子节点（悬浮在原处）。
 * @returns 新树与新树的多主题标记；节点不存在时返回 undefined。
 */
export function setNodeKind(
  root: MindNode,
  id: string,
  kind: "theme" | "node",
  multiTheme: boolean,
  position?: { x: number; y: number },
  links?: readonly MindLink[],
): { root: MindNode; multiTheme: boolean } | undefined {
  const source = locate(root, id);
  if (source === undefined) return undefined;

  if (kind === "theme") {
    /*
     * 升成主题 = 挂到容器根的一级。
     * 单主题文档要先升级成多主题（否则没有"顶层并列"这回事）。
     */
    let base = root;
    let multi = multiTheme;
    if (!multi) {
      base = { id: newId(), text: "", children: [cloneNode(root)] };
      multi = true;
    }
    const next = cloneNode(base);
    const target = locate(next, id);
    if (target === undefined) return undefined;
    // 已经在顶层了
    if (target.parent !== undefined && target.parent.id === next.id) {
      const themed = cloneNode(next);
      const again = locate(themed, id);
      if (again !== undefined) {
        again.node.kind = "theme";
        delete again.node.detached;
      }
      return { root: themed, multiTheme: true };
    }
    if (target.parent === undefined) return undefined;
    target.parent.children.splice(target.index, 1);
    delete target.node.detached;
    target.node.kind = "theme";
    if (position !== undefined) target.node.position = { x: position.x, y: position.y };
    next.children.push(target.node);
    return { root: next, multiTheme: true };
  }

  /*
   * 降成普通子节点：**层级由连线决定**。
   *
   *   1. 这个节点已经连着别的节点 → 父级就是那个节点（层级 = 它 +1）；
   *   2. 没有连线 → 它就是 1 级节点，保持顶层，不需要动。
   *
   * 早期版本是"挂到上一个主题下面"，那只是个权宜之计：用户心里
   * 节点之间的从属关系早就由连线表达出来了，硬塞给"上面那个"反而错。
   * 而且层级是结构决定的，改层级必须真的改结构，只改标记没用。
   */
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;

  const isTopLevel = target.parent !== undefined && target.parent.id === next.id;
  if (!isTopLevel) {
    // 已经是普通节点了，只清掉可能残留的标记
    delete target.node.kind;
    delete target.node.detached;
    return { root: next, multiTheme };
  }

  // 找一条连着它的自由连线，用另一端当父级
  const incoming = links?.find((link) => link.to === id);
  const outgoing = links?.find((link) => link.from === id);
  const parentId = incoming !== undefined ? incoming.from : outgoing !== undefined ? outgoing.to : undefined;
  if (parentId === undefined) {
    // 没有连线 = 1 级节点，保持顶层
    return undefined;
  }
  // 防成环：父级不能在自己的子树里
  if (pathTo(next, parentId).some((node) => node.id === id)) return undefined;

  const siblings = target.parent.children;
  siblings.splice(target.index, 1);
  const node = target.node;
  delete node.kind;
  delete node.detached;
  if (position !== undefined) node.position = { x: position.x, y: position.y };
  const hostNode = locate(next, parentId);
  if (hostNode === undefined) return undefined;
  hostNode.node.children.push(node);
  return { root: next, multiTheme };
}

/** 这个节点是不是主题（显式 kind 优先，否则看它是不是顶层一级）。 */
export function isThemeNode(node: MindNode, depth: number): boolean {
  if (node.kind !== undefined) return node.kind === "theme";
  return depth === 0;
}

/**
 * 按节点的实际上下位置重排兄弟顺序。
 *
 * 用户拖过节点之后，看到的上下顺序就是他心里的顺序；
 * 但树里的 children 数组还是"输入时的先后"。自动排版照数组来，
 * 于是排出来和用户摆的对不上——用户会觉得"排版把我的顺序打乱了"。
 *
 * 所以拖动结束后按 y 重排一次：**逻辑顺序跟上视觉顺序**。
 * 只在同一个父级的子节点之间重排，不跨层级、不改变父子关系。
 *
 * @returns 新树；没有节点需要换位时返回 undefined（避免产生无意义的撤销步）。
 */
export function sortSiblingsByPosition(root: MindNode): MindNode | undefined {
  const next = cloneNode(root);
  let changed = false;
  const walk = (node: MindNode): void => {
    if (node.children.length > 1) {
      const order = node.children.map((child, index) => ({ child, index }));
      const sorted = [...order].sort((a, b) => {
        const ay = a.child.position?.y ?? Number.POSITIVE_INFINITY;
        const by = b.child.position?.y ?? Number.POSITIVE_INFINITY;
        // 没有手动位置的保持原相对次序，避免把自动节点搅乱
        if (ay === by) return a.index - b.index;
        return ay - by;
      });
      const reordered = sorted.map((item) => item.child);
      if (reordered.some((child, index) => child !== node.children[index])) {
        node.children = reordered;
        changed = true;
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(next);
  return changed ? next : undefined;
}

/**
 * 设置某条连线（= 某节点的入边）的线型。
 *
 * @param style - "solid" / "dashed"；传 undefined 表示恢复跟随文档默认。
 * @returns 新树；节点不存在或没有入边时返回 undefined。
 */
export function setEdgeStyle(
  root: MindNode,
  id: string,
  style: "solid" | "dashed" | undefined,
): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  // 根节点 / 顶层主题没有入边
  if (target.parent === undefined) return undefined;
  if (style === undefined) delete target.node.edgeStyle;
  else target.node.edgeStyle = style;
  return next;
}

/**
 * 设置某条自由连线的线型。
 *
 * @returns 新的连线列表；连线不存在时返回 undefined。
 */
export function setLinkStyle(
  links: readonly MindLink[] | undefined,
  id: string,
  style: "solid" | "dashed" | undefined,
): MindLink[] | undefined {
  if (links === undefined) return undefined;
  let hit = false;
  const next = links.map((link) => {
    if (link.id !== id) return link;
    hit = true;
    const copy: MindLink = { ...link };
    if (style === undefined) delete copy.style;
    else copy.style = style;
    return copy;
  });
  return hit ? next : undefined;
}

/**
 * 画一条连线时自动建立从属关系。
 *
 * 规则（用户要求）：**连线一建立就自动调整层级**。
 *   - 一端是顶层节点（1 级）、另一端不是 → 把顶层那个挂到另一端下面；
 *   - 两端都是顶层 / 都不是 → 不动（连线只是关系标注）。
 *
 * @returns 新树与被挂靠的节点 id；不该自动挂靠时返回 undefined。
 */
export function attachByLink(
  root: MindNode,
  from: string,
  to: string,
  multiTheme = false,
): { root: MindNode; childId: string; parentId: string } | undefined {
  /*
   * "1 级节点" = **主题**，不是"根的直接子级"。
   *
   * 单主题时只有根自己是主题，它的 children 都是普通节点（深度 1）；
   * 多主题时容器根不渲染，它的 children 才是并列的主题。
   * 搞错这一点的话，单主题文档里连两个普通节点也会被自动挂靠，
   * 自由连线功能就等于没了。
   */
  const isTop = (id: string): boolean => {
    if (!multiTheme) return id === root.id;
    const found = locate(root, id);
    return found !== undefined && found.parent !== undefined && found.parent.id === root.id;
  };
  /*
   * 方向语义：连线是 from -> to，箭头指向谁，谁就是子节点。
   *
   * 所以只要 to 还是顶层（1 级），就把它挂到 from 下面——
   * 两个都是主题时也一样，这正是用户"连线即建立从属"的用法。
   * 反过来，如果 from 是顶层而 to 已经挂在别处，说明线是从子节点拉回主题的，
   * 那就把 from 挂到 to 下面。
   */
  let childId: string;
  let parentId: string;
  if (isTop(to)) {
    childId = to;
    parentId = from;
  } else if (isTop(from)) {
    childId = from;
    parentId = to;
  } else {
    return undefined;
  }
  // 防成环：父级不能在子节点的子树里
  if (pathTo(root, parentId).some((node) => node.id === childId)) return undefined;

  const next = cloneNode(root);
  const moved = locate(next, childId);
  if (moved === undefined || moved.parent === undefined) return undefined;
  moved.parent.children.splice(moved.index, 1);
  const host = locate(next, parentId);
  if (host === undefined) return undefined;
  delete moved.node.kind;
  delete moved.node.detached;

  /*
   * 按**画布上的上下顺序**插进去，而不是一律追加到末尾。
   *
   * 用户看到的是纵向排开的一列，新挂进来的节点如果总跑到最下面，
   * 和他眼里的位置就对不上（"我明明把它放到中间了"）。
   * 先算一次原树的布局拿到各自的 y，再按 y 排序即可。
   */
  const before = layoutTree(root);
  const yOf = new Map(before.nodes.map((node) => [node.id, node.y]));
  host.node.children.push(moved.node);
  host.node.children.sort((a, b) => {
    const ay = yOf.get(a.id);
    const by = yOf.get(b.id);
    // 没有坐标的（理论上不会发生）保持稳定，排在后面
    if (ay === undefined) return by === undefined ? 0 : 1;
    if (by === undefined) return -1;
    return ay - by;
  });
  return { root: next, childId, parentId };
}

/** 连线的可调属性。 */
export interface EdgePatch {
  style?: "solid" | "dashed" | undefined;
  width?: number | undefined;
  color?: string | undefined;
}

/**
 * 批量设置某条连线（= 某节点的入边）的属性。
 *
 * @returns 新树；节点不存在或没有入边时返回 undefined。
 */
export function setEdgeAttrs(root: MindNode, id: string, patch: EdgePatch): MindNode | undefined {
  const next = cloneNode(root);
  const target = locate(next, id);
  if (target === undefined) return undefined;
  if (target.parent === undefined) return undefined;
  const node = target.node;
  if ("style" in patch) {
    if (patch.style === undefined) delete node.edgeStyle;
    else node.edgeStyle = patch.style;
  }
  if ("width" in patch) {
    if (patch.width === undefined) delete node.edgeWidth;
    else node.edgeWidth = patch.width;
  }
  if ("color" in patch) {
    if (patch.color === undefined) delete node.edgeColor;
    else node.edgeColor = patch.color;
  }
  return next;
}

/** 批量设置某条自由连线的属性。 */
export function setLinkAttrs(
  links: readonly MindLink[] | undefined,
  id: string,
  patch: EdgePatch,
): MindLink[] | undefined {
  if (links === undefined) return undefined;
  let hit = false;
  const next = links.map((link) => {
    if (link.id !== id) return link;
    hit = true;
    const copy: MindLink = { ...link };
    if ("style" in patch) {
      if (patch.style === undefined) delete copy.style;
      else copy.style = patch.style;
    }
    if ("width" in patch) {
      if (patch.width === undefined) delete copy.width;
      else copy.width = patch.width;
    }
    if ("color" in patch) {
      if (patch.color === undefined) delete copy.color;
      else copy.color = patch.color;
    }
    return copy;
  });
  return hit ? next : undefined;
}
