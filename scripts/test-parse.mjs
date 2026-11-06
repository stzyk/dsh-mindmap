/**
 * Markdown 解析与合并单测：`node --test scripts/test-parse.mjs`
 *
 * 这里的核心风险是**合并时把图片/位置错配到相邻节点**——那种错误
 * 用户很难当场发现，但数据已经毁了。所以重点测"保留"与"匹配"。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMarkdown, entriesToTree, mergeTree } from "../src/core/parse.ts";
import { toMarkdown, toOutline } from "../src/core/markdown.ts";

/** 生成确定性的 id，便于断言。 */
function idGen() {
  let n = 0;
  return () => "new-" + String(++n);
}

/** 造一棵带图片与位置的树。 */
function richTree() {
  return {
    id: "root",
    text: "根",
    children: [
      {
        id: "a",
        text: "分支A",
        position: { x: 300, y: 100 },
        images: [{ id: "img-1", type: "image/png", name: "a.png", width: 100, height: 80 }],
        children: [{ id: "a1", text: "叶子A1", children: [] }],
      },
      { id: "b", text: "分支B", children: [] },
    ],
  };
}

/* ---------------- 解析 ---------------- */

test("解析标题层级", () => {
  const r = parseMarkdown("# 根\n\n## A\n\n### A1\n\n## B\n");
  assert.deepEqual(r.entries.map((e) => [e.text, e.depth]), [
    ["根", 0], ["A", 1], ["A1", 2], ["B", 1],
  ]);
});

test("解析列表层级（2 空格一层）", () => {
  const r = parseMarkdown("- 根\n  - A\n    - A1\n  - B\n");
  assert.deepEqual(r.entries.map((e) => [e.text, e.depth]), [
    ["根", 1], ["A", 2], ["A1", 3], ["B", 2],
  ]);
});

test("解析备注（引用块）", () => {
  const r = parseMarkdown("# 根\n\n## A\n\n> 第一行\n>\n> 第二行\n");
  const a = r.entries.find((e) => e.text === "A");
  assert.equal(a.note, "第一行\n\n第二行");
});

test("解析图片引用", () => {
  const r = parseMarkdown("# 根\n\n![架构图](assets/img-abc.png)\n");
  const root = r.entries[0];
  assert.equal(root.images.length, 1);
  assert.equal(root.images[0].id, "img-abc");
  assert.equal(root.images[0].type, "image/png");
  assert.equal(root.images[0].caption, "架构图");
});

test("解析 jpeg/webp/gif 的扩展名映射", () => {
  const r = parseMarkdown("# 根\n\n![](assets/x.jpg)\n![](assets/y.webp)\n![](assets/z.gif)\n");
  assert.deepEqual(r.entries[0].images.map((i) => i.type), ["image/jpeg", "image/webp", "image/gif"]);
});

test("内嵌 base64 图片不产生新图片引用", () => {
  const r = parseMarkdown("# 根\n\n![alt](data:image/png;base64,AAAA)\n");
  assert.equal(r.entries[0].images.length, 0, "base64 没有 id，不该被当成新图");
});

test("空标题被跳过并记录警告", () => {
  const r = parseMarkdown("# 根\n\n##\n\n## B\n");
  assert.equal(r.entries.length, 2);
  assert.ok(r.warnings.length > 0);
});

/* ---------------- 往返（round-trip） ---------------- */

test("toMarkdown → parseMarkdown 能还原层级", () => {
  const tree = richTree();
  const md = toMarkdown(tree);
  const r = parseMarkdown(md);
  assert.deepEqual(r.entries.map((e) => [e.text, e.depth]), [
    ["根", 0], ["分支A", 1], ["叶子A1", 2], ["分支B", 1],
  ]);
});

test("toOutline → parseMarkdown 能还原层级", () => {
  const tree = richTree();
  const r = parseMarkdown(toOutline(tree));
  // 列表形态根是 depth 1，其余相对更深
  const shape = r.entries.map((e) => [e.text, e.depth]);
  assert.deepEqual(shape, [["根", 1], ["分支A", 2], ["叶子A1", 3], ["分支B", 2]]);
});

test("超过 6 级时导出降级为列表，也能读回来", () => {
  let node = { id: "n1", text: "L1", children: [] };
  let cursor = node;
  for (let i = 2; i <= 8; i += 1) {
    const next = { id: "n" + i, text: "L" + i, children: [] };
    cursor.children.push(next);
    cursor = next;
  }
  const md = toMarkdown(node);
  const r = parseMarkdown(md);
  const texts = r.entries.map((e) => e.text);
  for (let i = 1; i <= 8; i += 1) {
    assert.ok(texts.includes("L" + i), "第 " + String(i) + " 层丢了");
  }
});

/* ---------------- 合并：保留 ---------------- */

test("文字没变时，id / 图片 / 位置全部保留", () => {
  const tree = richTree();
  const md = toMarkdown(tree);
  const r = parseMarkdown(md);
  const merged = mergeTree(tree, r.entries, idGen());
  assert.ok(merged);
  assert.equal(merged.dirty, false, "没改动就不该标记为脏");

  const a = merged.root.children.find((c) => c.text === "分支A");
  assert.equal(a.id, "a", "id 必须保留");
  assert.deepEqual(a.position, { x: 300, y: 100 }, "拖动位置必须保留");
  assert.equal(a.images.length, 1, "图片必须保留");
  assert.equal(a.images[0].id, "img-1");
  assert.equal(a.children[0].id, "a1", "子节点 id 也要保留");
});

test("改一个节点的文字：只有它变，其它保留", () => {
  const tree = richTree();
  const r = parseMarkdown("# 根\n\n## 分支A（改名）\n\n### 叶子A1\n\n## 分支B\n");
  const merged = mergeTree(tree, r.entries, idGen());
  assert.equal(merged.changed, 1);
  assert.equal(merged.added, 0);

  const root = merged.root;
  const renamed = root.children.find((c) => c.text === "分支A（改名）");
  assert.ok(renamed);
  assert.equal(renamed.id, "a", "改名不改 id");
  assert.deepEqual(renamed.position, { x: 300, y: 100 }, "改名不该丢位置");
  assert.equal(renamed.images.length, 1, "改名不该丢图片");

  const b = root.children.find((c) => c.text === "分支B");
  assert.equal(b.id, "b", "没动的节点 id 不变");
});

test("新增节点时，已有节点的图片不会错位到新节点上", () => {
  const tree = richTree();
  // 在分支A 前面插入一个新节点：如果按"下标"匹配，图片会错配
  const r = parseMarkdown("# 根\n\n## 新插入的\n\n## 分支A\n\n### 叶子A1\n\n## 分支B\n");
  const merged = mergeTree(tree, r.entries, idGen());
  assert.equal(merged.added, 1);

  const a = merged.root.children.find((c) => c.text === "分支A");
  assert.equal(a.id, "a");
  assert.equal(a.images.length, 1, "图片必须留在分支A 上");

  const inserted = merged.root.children.find((c) => c.text === "新插入的");
  assert.ok(inserted.id.startsWith("new-"), "新节点应有新 id");
  assert.equal(inserted.images, undefined, "新节点不该继承图片");
});

test("在 Markdown 里显式写图片会替换该节点的图片", () => {
  const tree = richTree();
  const r = parseMarkdown("# 根\n\n## 分支A\n\n![](assets/img-new.png)\n\n### 叶子A1\n\n## 分支B\n");
  const merged = mergeTree(tree, r.entries, idGen());
  const a = merged.root.children.find((c) => c.text === "分支A");
  assert.equal(a.images.length, 1);
  assert.equal(a.images[0].id, "img-new");
});

test("删除节点被正确识别", () => {
  const tree = richTree();
  const r = parseMarkdown("# 根\n\n## 分支B\n");
  const merged = mergeTree(tree, r.entries, idGen());
  assert.equal(merged.removed, 2, "分支A 与 叶子A1 都被删了");
  assert.equal(merged.root.children.length, 1);
});

test("根节点内容被改时 id 仍保留（文档 id 依赖它）", () => {
  const tree = richTree();
  const r = parseMarkdown("# 新根名\n\n## 分支A\n\n### 叶子A1\n\n## 分支B\n");
  const merged = mergeTree(tree, r.entries, idGen());
  assert.equal(merged.root.id, "root", "根 id 必须稳定");
  assert.equal(merged.root.text, "新根名");
});

test("同名兄弟按出现次序区分，不会互串", () => {
  const tree = {
    id: "r",
    text: "根",
    children: [
      { id: "x1", text: "重复", images: [{ id: "i1", type: "image/png", name: "1.png" }], children: [] },
      { id: "x2", text: "重复", images: [{ id: "i2", type: "image/png", name: "2.png" }], children: [] },
    ],
  };
  const r = parseMarkdown("# 根\n\n## 重复\n\n## 重复\n");
  const merged = mergeTree(tree, r.entries, idGen());
  assert.equal(merged.dirty, false, "内容一样不该算改动");
  assert.equal(merged.root.children[0].id, "x1");
  assert.equal(merged.root.children[1].id, "x2");
  assert.equal(merged.root.children[0].images[0].id, "i1");
  assert.equal(merged.root.children[1].images[0].id, "i2");
});

test("空 Markdown 返回 undefined（不把文档清空）", () => {
  assert.equal(mergeTree(richTree(), [], idGen()), undefined);
});

test("备注在合并中被保留与更新", () => {
  const tree = richTree();
  tree.children[0].note = "旧备注";
  const r = parseMarkdown("# 根\n\n## 分支A\n\n> 新备注\n\n### 叶子A1\n\n## 分支B\n");
  const merged = mergeTree(tree, r.entries, idGen());
  const a = merged.root.children.find((c) => c.text === "分支A");
  assert.equal(a.note, "新备注");
});

test("合并后再次导出的 Markdown 与输入一致（幂等）", () => {
  const tree = richTree();
  const md1 = toMarkdown(tree);
  const merged1 = mergeTree(tree, parseMarkdown(md1).entries, idGen());
  const md2 = toMarkdown(merged1.root);
  assert.equal(md2, md1, "合并不该改变导出结果");
});
