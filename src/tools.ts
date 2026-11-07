/**
 * dsh-mindmap — 模型可调用的工具（Host 半区）。
 *
 * 让对话能直接读写导图：读结构、生成新图、增量修改。
 *
 * 设计取舍：
 *   - **读**返回带节点 id 的缩进文本。AI 必须能看到 id，否则只能靠文字猜，
 *     改错节点是必然的。
 *   - **改**用增量操作而不是整棵树替换：能精确定位、能只撤销这一步。
 *   - **生成**接受 Markdown 大纲，复用现有的 parseMarkdown——AI 对 Markdown
 *     天然熟练，比让它输出 JSON 树可靠得多。
 */

import { parseMarkdown } from "./core/parse.ts";
import {
  insertChild,
  insertSibling,
  locate,
  moveSibling,
  pathTo,
  removeNode,
  reparentNode,
  setText,
  type MindNode,
} from "./core/tree.ts";
import { safeFileName } from "./core/markdown.ts";

/** 文档存储的最小接口（和 store.ts 的实现对齐，异步）。 */
export interface ToolStore {
  /** 摘要里的字段是 nodeCount，不是 nodes（写错会显示 undefined）。 */
  list(): Array<{ id: string; title: string; nodeCount: number; updatedAt: number }>;
  get(id: string): { id: string; title: string; root: MindNode } | undefined;
  create(title: string, rootText?: string): Promise<{ id: string }>;
  save(input: unknown): Promise<{ id: string }>;
}

/** 一次增量修改。 */
export interface MindOp {
  op: "add" | "update" | "remove" | "move" | "reparent";
  /** 目标节点 id（add 时为父节点，可省略表示根）。 */
  id?: string;
  /** add / update 的文字。 */
  text?: string;
  /** move 的方向。 */
  direction?: "up" | "down";
  /** reparent 的新父节点 id。 */
  parent?: string;
  /**
   * add 时给新节点起的**本批次临时名字**。
   *
   * 新节点 id 是随机串，调用前不可能知道，所以"加一个节点再把它挂到别处"
   * 这种顺序操作没法用 id 串起来（实测模型只能拆成两次调用）。
   * 起了别名就能在同一批 ops 里继续引用它。
   */
  as?: string;
}

/** 把树渲染成带 id 的缩进文本，供模型阅读。 */
export function outlineOf(root: MindNode, maxNodes = 800): string {
  const lines: string[] = [];
  let count = 0;
  const walk = (node: MindNode, depth: number): void => {
    if (count >= maxNodes) return;
    count += 1;
    const text = node.text.length > 0 ? node.text : "（空节点）";
    lines.push("  ".repeat(depth) + "- " + text + "  [" + node.id + "]");
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  if (count >= maxNodes) lines.push("…（节点过多，已截断）");
  return lines.join("\n");
}

/**
 * 把一次修改应用到树上，返回新树 / 错误说明 / 新建的节点 id。
 *
 * ⚠️ 这里有个**必须分清**的返回约定，v0.35.0 之前踩过：
 *
 *   - `insertChild` / `insertSibling` 返回 `{ root, id }`
 *   - `removeNode` 返回 `{ root, focusId }`
 *   - `setText` / `moveSibling` / `reparentNode` 返回 `MindNode`
 *
 * 早先四个分支一律写 `current = next`，于是 add / remove 把**包装对象**
 * 当成了树继续往下传：下一个操作读到 `node.children` 是 undefined 就抛错，
 * 更糟的是 `store.save({ root: 包装对象 })` 会把整棵子树洗掉
 * （实测：一条 remove 让 102 个节点变成 1 个）。
 *
 * 现在：结构类操作统一取 `.root`，并且每一步都校验结果确实是节点，
 * 一旦不像节点就立刻返回错误——**宁可这次改不成，也不能把树写坏**。
 */
export function applyOps(
  root: MindNode,
  ops: readonly MindOp[],
):
  | { root: MindNode; applied: number; created: Array<{ id: string; text: string; as?: string }> }
  | { error: string } {
  let current = root;
  let applied = 0;
  const created: Array<{ id: string; text: string; as?: string }> = [];
  /*
   * 本批次内的临时别名 → 真实节点 id。
   *
   * 为什么需要：`add` 生成的新节点 id 是随机串，模型在调用前拿不到，
   * 于是"给甲加个子节点、再把这个新节点挂到乙下面"这类顺序操作只能拆成
   * 两次工具调用（实测模型就是这么绕过去的）。有了别名，一次调用就能表达。
   */
  const aliases = new Map<string, string>();
  /** 节点是否存在（用来把"找不到节点"和"删不掉/挪不动"区分开）。 */
  const exists = (id: string): boolean => locate(current, id) !== undefined;
  const resolveRef = (ref: string | undefined): string | undefined => {
    if (ref === undefined) return undefined;
    return aliases.get(ref) ?? ref;
  };

  /** 结果必须是"有 children 数组的节点"，否则说明上游返回了包装对象。 */
  const asNode = (value: unknown): MindNode | undefined => {
    if (value === null || typeof value !== "object") return undefined;
    const node = value as { id?: unknown; children?: unknown };
    if (typeof node.id !== "string" || !Array.isArray(node.children)) return undefined;
    return value as MindNode;
  };

  for (const [index, op] of ops.entries()) {
    const at = "第 " + String(index + 1) + " 个操作";
    if (op.op === "add") {
      const text = (op.text ?? "").trim();
      if (text.length === 0) return { error: at + "：add 缺少 text" };
      const parentId = resolveRef(op.id);
      // 不给 id 时挂到根下面（insertSibling 对根会自动退化成"加子节点"）
      const next =
        parentId === undefined ? insertSibling(current, current.id, text) : insertChild(current, parentId, text);
      if (next === undefined) return { error: at + "：找不到父节点 " + String(op.id) };
      const node = asNode(next.root);
      if (node === undefined) return { error: at + "：内部错误（插入结果不是节点）" };
      current = node;
      const alias = (op.as ?? "").trim();
      if (alias.length > 0) {
        if (aliases.has(alias)) return { error: at + "：别名 " + alias + " 重复了" };
        aliases.set(alias, next.id);
      }
      created.push(alias.length > 0 ? { id: next.id, text, as: alias } : { id: next.id, text });
      applied += 1;
      continue;
    }
    if (op.op === "update") {
      if (op.id === undefined) return { error: at + "：update 缺少 id" };
      const next = setText(current, resolveRef(op.id)!, op.text ?? "");
      if (next === undefined) return { error: at + "：找不到节点 " + op.id };
      const node = asNode(next);
      if (node === undefined) return { error: at + "：内部错误（改文字结果不是节点）" };
      current = node;
      applied += 1;
      continue;
    }
    if (op.op === "remove") {
      if (op.id === undefined) return { error: at + "：remove 缺少 id" };
      const targetId = resolveRef(op.id)!;
      // 先分清两种失败：节点不存在 / 想删根。混成一句会把模型带沟里
      //（实测它看到"根节点不可删"以为工具把不存在的 id 回落到了根）。
      if (!exists(targetId)) return { error: at + "：找不到节点 " + op.id };
      if (targetId === current.id) return { error: at + "：根节点不能删（导图必须有一个中心）" };
      const next = removeNode(current, targetId);
      if (next === undefined) return { error: at + "：删不掉 " + op.id };
      const node = asNode(next.root);
      if (node === undefined) return { error: at + "：内部错误（删除结果不是节点）" };
      current = node;
      applied += 1;
      continue;
    }
    if (op.op === "move") {
      if (op.id === undefined) return { error: at + "：move 缺少 id" };
      const dir = op.direction === "down" ? 1 : -1;
      const targetId = resolveRef(op.id)!;
      if (!exists(targetId)) return { error: at + "：找不到节点 " + op.id };
      const next = moveSibling(current, targetId, dir);
      if (next === undefined) {
        return { error: at + "：" + op.id + " 已经在最" + (dir === 1 ? "后" : "前") + "了，挪不动" };
      }
      const node = asNode(next);
      if (node === undefined) return { error: at + "：内部错误（移动结果不是节点）" };
      current = node;
      applied += 1;
      continue;
    }
    if (op.op === "reparent") {
      if (op.id === undefined) return { error: at + "：reparent 缺少 id" };
      if (op.parent === undefined) return { error: at + "：reparent 缺少 parent（新父节点 id）" };
      const targetId = resolveRef(op.id)!;
      const parentId = resolveRef(op.parent)!;
      if (!exists(targetId)) return { error: at + "：找不到节点 " + op.id };
      if (!exists(parentId)) return { error: at + "：找不到父节点 " + op.parent };
      const next = reparentNode(current, targetId, parentId);
      if (next === undefined) return { error: at + "：不能挂到自己或自己的子孙下面" };
      const node = asNode(next);
      if (node === undefined) return { error: at + "：内部错误（改父级结果不是节点）" };
      current = node;
      applied += 1;
      continue;
    }
    return { error: at + "：未知操作 " + String((op as { op?: string }).op) };
  }

  return { root: current, applied, created };
}

/** 从 Markdown 建树。 */
export function treeFromMarkdown(markdown: string, title: string): MindNode {
  // parseMarkdown 返回 { entries, warnings }，不是数组
  const { entries } = parseMarkdown(markdown);
  const parsed = entries;
  if (parsed.length === 0) {
    return { id: "root", text: title, children: [] };
  }
  /*
   * parseMarkdown 返回的是扁平条目（带 depth），这里拼回树。
   *
   * 根节点怎么定（v0.35.0 修）：
   *   - 只有**一个** depth 0 条目时，它就是根——Markdown 里那行 `# 标题`
   *     本来就代表中心主题。早先一律套一层合成根，于是 `# 培训 Agent`
   *     变成"标题根 → 同名子节点 → 各章节"，凭空多一层重复节点。
   *   - 多个 depth 0 条目（比如整篇是无序列表、或并列多个 H1）才用
   *     合成根，标题当中心主题。
   */
  const topLevel = parsed.filter((entry) => entry.depth === 0);
  let rest = parsed;
  let rootText = title;
  if (topLevel.length === 1 && parsed[0] !== undefined && parsed[0].depth === 0) {
    const head = parsed[0];
    if (head.text.length > 0) rootText = head.text;
    rest = parsed.slice(1);
  }
  const root: MindNode = { id: "root", text: rootText, children: [] };
  const stack: Array<{ depth: number; node: MindNode }> = [{ depth: -1, node: root }];
  let serial = 0;
  for (const entry of rest) {
    const node: MindNode = { id: "n" + String(serial++), text: entry.text, children: [] };
    while (stack.length > 1 && stack[stack.length - 1]!.depth >= entry.depth) stack.pop();
    const parent = stack[stack.length - 1]!.node;
    parent.children.push(node);
    stack.push({ depth: entry.depth, node });
  }
  return root;
}

/** 节点总数。 */
export function countOf(root: MindNode): number {
  let n = 0;
  const walk = (node: MindNode): void => {
    n += 1;
    for (const child of node.children) walk(child);
  };
  walk(root);
  return n;
}

/** 找一份文档：给了 id 就用 id，否则按标题模糊匹配。 */
export function resolveDoc(
  store: ToolStore,
  id: string | undefined,
  title: string | undefined,
): { id: string; title: string } | undefined {
  if (id !== undefined && id.length > 0) {
    const found = store.list().find((doc) => doc.id === id);
    return found === undefined ? undefined : { id: found.id, title: found.title };
  }
  if (title !== undefined && title.trim().length > 0) {
    const needle = title.trim();
    const exact = store.list().find((doc) => doc.title === needle);
    if (exact !== undefined) return { id: exact.id, title: exact.title };
    const loose = store.list().find((doc) => doc.title.includes(needle) || needle.includes(doc.title));
    if (loose !== undefined) return { id: loose.id, title: loose.title };
  }
  return undefined;
}

/** 文件名（导出用）。 */
export { safeFileName };

/** 节点 id 是否存在。 */
export function hasNode(root: MindNode, id: string): boolean {
  return locate(root, id) !== undefined;
}

/** 从根到某节点的路径（用于提示 AI 上下文）。 */
export function pathTextOf(root: MindNode, id: string): string {
  const trail = pathTo(root, id);
  return trail.map((node) => node.text).join(" / ");
}

/**
 * 把工具的 DSL 参数/输出描述转成**标准 JSON Schema**。
 *
 * DSH 的 `defineTool` 会做这件事，但它是宿主内部的包，插件不该直接依赖。
 * 不转换的后果很严重：DSL 里的 `required: true` 会原样发给模型侧，
 * 那不是合法的 JSON Schema，上游直接 400（code 1210「API 调用参数不合法」）。
 *
 * 转换规则（和 defineTool 一致）：
 *   - 属性上的 `required: true` → 收进父级的 `required: [...]` 数组
 *   - 其余键原样保留（type / description / enum / items / properties …）
 */
export function toJsonSchema(spec: Record<string, unknown>): Record<string, unknown> {
  const convert = (node: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === "required") continue;
      if (key === "properties" && value !== null && typeof value === "object") {
        const props: Record<string, unknown> = {};
        for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
          if (child === null || typeof child !== "object") continue;
          const childSpec = child as Record<string, unknown>;
          if (childSpec.required === true) required.push(name);
          props[name] = convert(childSpec);
        }
        out.properties = props;
        continue;
      }
      if (key === "items" && value !== null && typeof value === "object") {
        out.items = convert(value as Record<string, unknown>);
        continue;
      }
      out[key] = value;
    }
    if (required.length > 0) out.required = required;
    return out;
  };
  return convert(spec);
}
