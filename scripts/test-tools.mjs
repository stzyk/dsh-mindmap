/**
 * 模型工具层验收测试：`node --test scripts/test-tools.mjs`
 *
 * 为什么单独有这一份：`applyOps` / `treeFromMarkdown` 是**只有模型会走**的代码路径，
 * 画布上的交互一个都不经过它，所以浏览器冒烟永远测不到。
 *
 * v0.34.0 就因此漏了一个致命 bug：`insertChild` / `removeNode` 返回的是
 * `{ root, id }`，而 `applyOps` 直接 `current = next`，于是：
 *   - 第二个操作读到 `node.children` 是 undefined 直接抛错；
 *   - 更糟的是 `store.save({ root: 包装对象 })` 把整棵子树洗掉
 *     （真实事故：一条 remove 让 102 个节点变成 1 个）。
 *
 * 这份测试就是为了让"工具层"也有断言：结构类操作、幂等、失败不落盘、
 * Markdown 建树的根节点、以及 id 回传。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyOps,
  countOf,
  hasNode,
  outlineOf,
  pathTextOf,
  resolveDoc,
  toJsonSchema,
  treeFromMarkdown,
} from "../src/tools.ts";

/* ------------------------------------------------------------------ *
 * 测试用的小工具
 * ------------------------------------------------------------------ */

/** 造一棵确定的小树：root → (a → (a1), b)。 */
function sample() {
  return {
    id: "root",
    text: "根",
    children: [
      { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
      { id: "b", text: "B", children: [] },
    ],
  };
}

/** 把树拍平成 "depth:text" 便于断言。 */
function flat(root) {
  const out = [];
  const walk = (node, depth) => {
    out.push(depth + ":" + node.text);
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** 结构不变量：每个节点都必须有 children 数组、id 是字符串。 */
function assertShape(root, where = "root") {
  assert.equal(typeof root.id, "string", where + " 的 id 必须是字符串");
  assert.ok(Array.isArray(root.children), where + " 的 children 必须是数组");
  for (const child of root.children) assertShape(child, where + "/" + String(child.id));
}

/* ------------------------------------------------------------------ *
 * applyOps：结构类操作（就是踩过坑的那几条）
 * ------------------------------------------------------------------ */

test("applyOps add：挂到指定父节点下，返回的是树而不是包装对象", () => {
  const result = applyOps(sample(), [{ op: "add", id: "a", text: "新节点" }]);
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal(result.applied, 1);
  // 关键断言：返回值本身必须是节点（children 是数组），不是 { root, id }
  assertShape(result.root);
  assert.deepEqual(flat(result.root), ["0:根", "1:A", "2:A1", "2:新节点", "1:B"]);
  // 新节点的 id 要回传（模型靠它继续加子节点，不必再 read 一次）
  assert.equal(result.created.length, 1);
  assert.equal(result.created[0].text, "新节点");
  assert.equal(hasNode(result.root, result.created[0].id), true);
});

test("applyOps add：不给 id 时挂到根下面", () => {
  const result = applyOps(sample(), [{ op: "add", text: "挂根下" }]);
  assert.ok(!("error" in result));
  assert.deepEqual(flat(result.root), ["0:根", "1:A", "2:A1", "1:B", "1:挂根下"]);
});

test("applyOps remove：删掉节点及其子树，树仍然是完整的树", () => {
  const result = applyOps(sample(), [{ op: "remove", id: "a" }]);
  assert.ok(!("error" in result), JSON.stringify(result));
  assertShape(result.root);
  // 整棵 a 子树一起没了，但 b 还在（这正是 v0.34 那个 bug 会洗掉的东西）
  assert.deepEqual(flat(result.root), ["0:根", "1:B"]);
});

test("applyOps remove：不允许删根节点", () => {
  const result = applyOps(sample(), [{ op: "remove", id: "root" }]);
  assert.ok("error" in result);
  assert.match(result.error, /根节点不能删/);
});

test("applyOps update：只改文字，结构不变", () => {
  const result = applyOps(sample(), [{ op: "update", id: "a1", text: "改过" }]);
  assert.ok(!("error" in result));
  assert.deepEqual(flat(result.root), ["0:根", "1:A", "2:改过", "1:B"]);
  assert.equal(result.created.length, 0);
});

test("applyOps move：同级上下挪", () => {
  const up = applyOps(sample(), [{ op: "move", id: "b", direction: "up" }]);
  assert.ok(!("error" in up));
  assert.deepEqual(flat(up.root), ["0:根", "1:B", "1:A", "2:A1"]);
  const down = applyOps(up.root, [{ op: "move", id: "b", direction: "down" }]);
  assert.ok(!("error" in down));
  assert.deepEqual(flat(down.root), ["0:根", "1:A", "2:A1", "1:B"]);
});

test("applyOps reparent：挂到另一个节点下（子树一起搬）", () => {
  const result = applyOps(sample(), [{ op: "reparent", id: "b", parent: "a" }]);
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.deepEqual(flat(result.root), ["0:根", "1:A", "2:A1", "2:B"]);
});

test("applyOps reparent：不能挂到自己身上，也不能成环", () => {
  const self = applyOps(sample(), [{ op: "reparent", id: "a", parent: "a" }]);
  assert.ok("error" in self);
  const cycle = applyOps(sample(), [{ op: "reparent", id: "a", parent: "a1" }]);
  assert.ok("error" in cycle);
});

/* ------------------------------------------------------------------ *
 * applyOps：多个操作串联（模型真实用法）
 * ------------------------------------------------------------------ */

test("applyOps 一次多个操作：add 之后还能继续 add / update（不再中途炸）", () => {
  const ops = [
    { op: "add", id: "b", text: "B1" },
    { op: "add", id: "b", text: "B2" },
    { op: "update", id: "a", text: "A改" },
    { op: "remove", id: "a1" },
  ];
  const result = applyOps(sample(), ops);
  assert.ok(!("error" in result), JSON.stringify(result));
  assertShape(result.root);
  assert.equal(result.applied, 4);
  assert.deepEqual(flat(result.root), ["0:根", "1:A改", "1:B", "2:B1", "2:B2"]);
  assert.equal(result.created.length, 2);
});

test("applyOps 中途失败：返回错误，且不改动原树（调用方据此不落盘）", () => {
  const original = sample();
  const snapshot = JSON.stringify(original);
  const result = applyOps(original, [
    { op: "add", id: "b", text: "先加一个" },
    { op: "update", id: "不存在", text: "x" },
  ]);
  assert.ok("error" in result);
  assert.match(result.error, /第 2 个操作/);
  // 入参树必须原样（纯函数，不就地改）
  assert.equal(JSON.stringify(original), snapshot);
});

test("applyOps 空 ops：applied=0，树原样返回", () => {
  const result = applyOps(sample(), []);
  assert.ok(!("error" in result));
  assert.equal(result.applied, 0);
  assert.deepEqual(flat(result.root), flat(sample()));
});

test("applyOps 参数错误都能说清是第几个操作", () => {
  assert.match(applyOps(sample(), [{ op: "add", id: "a" }]).error, /第 1 个操作：add 缺少 text/);
  assert.match(applyOps(sample(), [{ op: "update" }]).error, /update 缺少 id/);
  assert.match(applyOps(sample(), [{ op: "remove" }]).error, /remove 缺少 id/);
  assert.match(applyOps(sample(), [{ op: "move", id: "a" }]).error, /挪不动|缺少/);
  assert.match(applyOps(sample(), [{ op: "reparent", id: "b" }]).error, /reparent 缺少 parent/);
  assert.match(applyOps(sample(), [{ op: "乱写", id: "a" }]).error, /未知操作/);
  assert.match(applyOps(sample(), [{ op: "add", id: "没有这个", text: "x" }]).error, /找不到父节点/);
});

test("applyOps 不改动入参（纯函数）", () => {
  const tree = sample();
  const before = JSON.stringify(tree);
  applyOps(tree, [{ op: "add", id: "a", text: "x" }]);
  assert.equal(JSON.stringify(tree), before);
});

/* ------------------------------------------------------------------ *
 * treeFromMarkdown：`# 标题` 就是根，不能再套一层
 * ------------------------------------------------------------------ */

test("treeFromMarkdown：单个 H1 就是根（不会出现同名重复节点）", () => {
  const md = "# 培训 Agent\n\n## 1. 目标\n- 边界\n\n## 2. 能力\n- 拆解\n";
  const root = treeFromMarkdown(md, "培训 Agent");
  assert.equal(root.text, "培训 Agent");
  assert.deepEqual(flat(root), ["0:培训 Agent", "1:1. 目标", "2:边界", "1:2. 能力", "2:拆解"]);
  // 关键回归：没有任何一层是"标题的副本"
  assert.equal(root.children.filter((c) => c.text === "培训 Agent").length, 0);
});

test("treeFromMarkdown：H1 文字和 title 不同时，以 H1 为根文字", () => {
  const root = treeFromMarkdown("# 中心主题\n## 子\n", "文档标题");
  assert.equal(root.text, "中心主题");
  assert.deepEqual(flat(root), ["0:中心主题", "1:子"]);
});

test("treeFromMarkdown：纯列表用标题当根（多个 depth 0 条目）", () => {
  const root = treeFromMarkdown("- 甲\n- 乙\n  - 乙一\n", "我的图");
  assert.equal(root.text, "我的图");
  assert.deepEqual(flat(root), ["0:我的图", "1:甲", "1:乙", "2:乙一"]);
});

test("treeFromMarkdown：多个 H1 并列时用标题当根", () => {
  const root = treeFromMarkdown("# 主题一\n## a\n# 主题二\n## b\n", "合集");
  assert.equal(root.text, "合集");
  assert.deepEqual(flat(root), ["0:合集", "1:主题一", "2:a", "1:主题二", "2:b"]);
});

test("treeFromMarkdown：空 Markdown 得到只有标题的根", () => {
  const root = treeFromMarkdown("", "空图");
  assert.equal(root.text, "空图");
  assert.deepEqual(root.children, []);
  assert.equal(countOf(root), 1);
});

test("treeFromMarkdown：只有一行 H1 时根就是它，没有子节点", () => {
  const root = treeFromMarkdown("# 就一个标题\n", "随便");
  assert.equal(root.text, "就一个标题");
  assert.equal(countOf(root), 1);
});

test("treeFromMarkdown：多层标题的层级关系正确", () => {
  const md = "# 根\n## 一\n### 一一\n#### 一一一\n## 二\n";
  const root = treeFromMarkdown(md, "根");
  assert.deepEqual(flat(root), ["0:根", "1:一", "2:一一", "3:一一一", "1:二"]);
});

test("treeFromMarkdown：生成的结构能被 applyOps 继续改（端到端串起来）", () => {
  const root = treeFromMarkdown("# 图\n## 甲\n## 乙\n", "图");
  const added = applyOps(root, [{ op: "add", id: root.children[0].id, text: "甲的娃" }]);
  assert.ok(!("error" in added));
  assert.deepEqual(flat(added.root), ["0:图", "1:甲", "2:甲的娃", "1:乙"]);
});

/* ------------------------------------------------------------------ *
 * outlineOf：模型唯一能看到的"节点 id 来源"
 * ------------------------------------------------------------------ */

test("outlineOf：每行末尾都带 [id]，缩进按层级", () => {
  const text = outlineOf(sample());
  assert.deepEqual(text.split("\n"), [
    "- 根  [root]",
    "  - A  [a]",
    "    - A1  [a1]",
    "  - B  [b]",
  ]);
});

test("outlineOf：空文字节点显示成（空节点），不会渲染成空白行", () => {
  const text = outlineOf({ id: "r", text: "", children: [{ id: "x", text: "", children: [] }] });
  assert.match(text, /（空节点）  \[r\]/);
  assert.match(text, /（空节点）  \[x\]/);
});

test("outlineOf：超过上限会截断并明说", () => {
  const many = { id: "r", text: "根", children: [] };
  for (let i = 0; i < 20; i += 1) many.children.push({ id: "c" + i, text: "c" + i, children: [] });
  const text = outlineOf(many, 5);
  assert.equal(text.split("\n").length, 6); // 5 行节点 + 1 行截断提示
  assert.match(text, /节点过多，已截断/);
});

test("outlineOf 出来的 id 都能在树上找到（模型拿到的 id 必须可用）", () => {
  const tree = sample();
  const ids = outlineOf(tree)
    .split("\n")
    .map((line) => line.match(/\[([^\]]+)\]$/)?.[1])
    .filter(Boolean);
  assert.deepEqual(ids, ["root", "a", "a1", "b"]);
  for (const id of ids) assert.equal(hasNode(tree, id), true, id);
});

/* ------------------------------------------------------------------ *
 * resolveDoc / pathTextOf / countOf
 * ------------------------------------------------------------------ */

function fakeStore(docs) {
  return {
    list: () => docs.map((doc) => ({ nodeCount: 1, updatedAt: 0, ...doc })),
    get: (id) => docs.find((doc) => doc.id === id),
    create: async () => ({ id: "new" }),
    save: async () => ({ id: "new" }),
  };
}

test("resolveDoc：优先按 id 找", () => {
  const store = fakeStore([
    { id: "d1", title: "甲乙丙" },
    { id: "d2", title: "丁" },
  ]);
  assert.deepEqual(resolveDoc(store, "d2", "甲乙丙"), { id: "d2", title: "丁" });
});

test("resolveDoc：没有 id 时标题先精确、再模糊", () => {
  const store = fakeStore([
    { id: "d1", title: "甲乙丙" },
    { id: "d2", title: "丁" },
  ]);
  assert.deepEqual(resolveDoc(store, undefined, "丁"), { id: "d2", title: "丁" });
  assert.deepEqual(resolveDoc(store, undefined, "甲乙"), { id: "d1", title: "甲乙丙" });
});

test("resolveDoc：找不到时返回 undefined（工具据此提示先 list）", () => {
  const store = fakeStore([{ id: "d1", title: "甲乙丙" }]);
  assert.equal(resolveDoc(store, "nope", undefined), undefined);
  assert.equal(resolveDoc(store, undefined, "不存在"), undefined);
  assert.equal(resolveDoc(store, undefined, undefined), undefined);
  assert.equal(resolveDoc(store, undefined, "   "), undefined);
});

test("pathTextOf：给出根到节点的路径文字", () => {
  assert.equal(pathTextOf(sample(), "a1"), "根 / A / A1");
  assert.equal(pathTextOf(sample(), "不存在"), "");
});

test("countOf：算上根节点", () => {
  assert.equal(countOf(sample()), 4);
  assert.equal(countOf({ id: "r", text: "x", children: [] }), 1);
});

/* ------------------------------------------------------------------ *
 * toJsonSchema：工具参数/输出契约（写错上游直接 400）
 * ------------------------------------------------------------------ */

test("toJsonSchema：属性上的 required 收进父级 required 数组", () => {
  const schema = toJsonSchema({
    type: "object",
    properties: {
      title: { type: "string", required: true },
      markdown: { type: "string", required: true },
      id: { type: "string" },
    },
  });
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["title", "markdown"]);
  assert.equal(schema.properties.id.required, undefined);
});

test("toJsonSchema：数组 items 里的 properties 也会被转换", () => {
  const schema = toJsonSchema({
    type: "object",
    properties: {
      ops: {
        type: "array",
        required: true,
        items: {
          type: "object",
          properties: {
            op: { type: "string", required: true },
            id: { type: "string" },
          },
        },
      },
    },
  });
  assert.deepEqual(schema.required, ["ops"]);
  assert.equal(schema.properties.ops.items.type, "object");
  assert.deepEqual(schema.properties.ops.items.required, ["op"]);
  assert.equal(schema.properties.ops.items.properties.id.type, "string");
});

test("toJsonSchema：additionalProperties 原样保留（必须能表达 false）", () => {
  const schema = toJsonSchema({
    type: "object",
    additionalProperties: false,
    properties: { text: { type: "string", required: true } },
  });
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["text"]);
});

/* ------------------------------------------------------------------ *
 * applyOps：批内别名（v0.35.0，实测模型撞上的缺口）
 * ------------------------------------------------------------------ */

test("applyOps 别名：add 起名后，同一批里的后续操作能引用它", () => {
  const ops = [
    { op: "add", id: "b", text: "新小节", as: "新小节" },
    { op: "reparent", id: "新小节", parent: "a" },
  ];
  const result = applyOps(sample(), ops);
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.deepEqual(flat(result.root), ["0:根", "1:A", "2:A1", "2:新小节", "1:B"]);
  // 返回里要带上别名，模型下一批还能对上号
  assert.equal(result.created[0].as, "新小节");
  assert.equal(hasNode(result.root, result.created[0].id), true);
});

test("applyOps 别名：可以继续给新节点加子节点（子树一次搭完）", () => {
  const ops = [
    { op: "add", id: "root", text: "章节", as: "s1" },
    { op: "add", id: "s1", text: "小节", as: "s2" },
    { op: "add", id: "s2", text: "要点" },
    { op: "update", id: "s1", text: "章节（改）" },
  ];
  const result = applyOps(sample(), ops);
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.deepEqual(flat(result.root), [
    "0:根",
    "1:A",
    "2:A1",
    "1:B",
    "1:章节（改）",
    "2:小节",
    "3:要点",
  ]);
  assert.equal(result.created.length, 3);
});

test("applyOps 别名：重名别名直接拒绝（不静默覆盖）", () => {
  const result = applyOps(sample(), [
    { op: "add", id: "b", text: "一", as: "x" },
    { op: "add", id: "b", text: "二", as: "x" },
  ]);
  assert.ok("error" in result);
  assert.match(result.error, /别名 x 重复/);
});

test("applyOps 别名：引用没定义过的别名时给出「找不到」而不是静默乱挂", () => {
  const result = applyOps(sample(), [{ op: "reparent", id: "不存在", parent: "a" }]);
  assert.ok("error" in result);
  assert.match(result.error, /找不到节点/);
});

test("applyOps 别名：空字符串别名等于没起名", () => {
  const result = applyOps(sample(), [{ op: "add", id: "b", text: "x", as: "  " }]);
  assert.ok(!("error" in result));
  assert.equal(result.created[0].as, undefined);
});

test("applyOps 一次真实批处理：建树 + 改名 + 挪位 + 改父级（模型的原场景）", () => {
  const tree = treeFromMarkdown("# 图\n## 甲\n### 甲一\n## 乙\n", "图");
  const jia = tree.children[0];
  const yi = tree.children[1];
  const jiaYi = jia.children[0];
  const ops = [
    { op: "add", id: jiaYi.id, text: "叶子甲", as: "leaf1" },
    { op: "add", id: jiaYi.id, text: "叶子乙", as: "leaf2" },
    { op: "update", id: yi.id, text: "乙（改）" },
    { op: "move", id: yi.id, direction: "up" },
    { op: "add", id: jia.id, text: "新小节", as: "extra" },
    { op: "reparent", id: "extra", parent: yi.id },
  ];
  const result = applyOps(tree, ops);
  assert.ok(!("error" in result), JSON.stringify(result));
  assert.equal(result.applied, 6);
  assert.deepEqual(flat(result.root), [
    "0:图",
    "1:乙（改）",
    "2:新小节",
    "1:甲",
    "2:甲一",
    "3:叶子甲",
    "3:叶子乙",
  ]);
});

test("applyOps 报错文案能分清「节点不存在」和「删根/到头/成环」", () => {
  // 不存在的 id 必须说"找不到节点"，不能说"根节点不可删"——
  // 实测模型看到后者会以为工具把不存在的 id 回落到了根
  assert.match(applyOps(sample(), [{ op: "remove", id: "nope" }]).error, /找不到节点 nope/);
  assert.match(applyOps(sample(), [{ op: "remove", id: "root" }]).error, /根节点不能删/);
  assert.match(applyOps(sample(), [{ op: "move", id: "nope" }]).error, /找不到节点 nope/);
  // 已经在第一个位置还往上挪：要说"到头了"
  assert.match(applyOps(sample(), [{ op: "move", id: "a", direction: "up" }]).error, /已经在最前了/);
  assert.match(applyOps(sample(), [{ op: "move", id: "b", direction: "down" }]).error, /已经在最后了/);
  assert.match(applyOps(sample(), [{ op: "reparent", id: "nope", parent: "a" }]).error, /找不到节点 nope/);
  assert.match(applyOps(sample(), [{ op: "reparent", id: "b", parent: "nope" }]).error, /找不到父节点 nope/);
  assert.match(applyOps(sample(), [{ op: "reparent", id: "a", parent: "a1" }]).error, /不能挂到自己或自己的子孙/);
});
