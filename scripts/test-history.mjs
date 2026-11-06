/**
 * 撤销 / 重做栈单测：`node --test scripts/test-history.mjs`
 *
 * 历史栈是"撤销功能"里最容易出隐蔽错误的地方：栈指针错一位，
 * 撤销就变成"回到未来"或者无限重复同一状态。这里逐条钉死语义。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHistory, sameTree, MAX_HISTORY } from "../src/client/history.ts";
import { insertChild, setText, attachImage } from "../src/core/tree.ts";

/** 造一棵可辨识的树。 */
function tree(marker) {
  return { id: "root", text: marker, children: [] };
}

test("初始状态不可撤销", () => {
  const h = createHistory();
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
  assert.equal(h.undo(), undefined);
  assert.equal(h.redo(), undefined);
});

test("reset 设定起点后可撤销一步", () => {
  const h = createHistory();
  h.reset(tree("初始"), "root");
  h.push(tree("改了"), "root");
  assert.equal(h.canUndo(), true);

  const step = h.undo();
  assert.equal(step.root.text, "初始");
  assert.equal(h.canUndo(), false, "撤销到底");
  assert.equal(h.canRedo(), true);
});

test("undo 返回的是副本，改动它不影响栈内状态", () => {
  const h = createHistory();
  h.reset(tree("A"), "root");
  h.push(tree("B"), "root");

  const step = h.undo();
  step.root.text = "被外部改坏";
  // 再撤销一次拿到的仍应是 A
  h.redo();
  const again = h.undo();
  assert.equal(again.root.text, "A");
});

test("redo 回到撤销前的状态", () => {
  const h = createHistory();
  h.reset(tree("1"), "root");
  h.push(tree("2"), "root");
  h.push(tree("3"), "root");

  h.undo();
  h.undo();
  assert.equal(h.canRedo(), true);
  const step = h.redo();
  assert.equal(step.root.text, "2");
  h.redo();
  assert.equal(h.canRedo(), false);
});

test("新操作会清空 redo 分支", () => {
  const h = createHistory();
  h.reset(tree("1"), "root");
  h.push(tree("2"), "root");
  h.undo();
  assert.equal(h.canRedo(), true);

  h.push(tree("另一个分支"), "root");
  assert.equal(h.canRedo(), false, "新操作后不能再重做旧分支");
});

test("内容相同的树不重复入栈", () => {
  const h = createHistory();
  const a = tree("相同");
  h.reset(a, "root");
  h.push(structuredClone(a), "root");
  assert.equal(h.size(), 1, "内容没变不该占一步");
  assert.equal(h.canUndo(), false);
});

test("深度上限：超出丢最老的", () => {
  const h = createHistory({ maxSteps: 5 });
  h.reset(tree("0"), "root");
  for (let i = 1; i <= 20; i += 1) {
    h.push(tree(String(i)), "root");
  }
  assert.equal(h.size(), 5, "最多保留 maxSteps 步");

  // 一路撤销到底，最早只能回到保留范围内的那一步
  let last;
  while (h.canUndo()) last = h.undo();
  assert.ok(last !== undefined);
  assert.equal(last.root.text, "16", "丢的是最老的，保留最近的");
});

test("默认上限是 100", () => {
  const h = createHistory();
  h.reset(tree("0"), "root");
  for (let i = 1; i <= 150; i += 1) h.push(tree(String(i)), "root");
  assert.equal(h.size(), MAX_HISTORY);
});

test("reset 清空两侧", () => {
  const h = createHistory();
  h.reset(tree("A"), "root");
  h.push(tree("B"), "root");
  h.undo();
  assert.equal(h.canRedo(), true);

  h.reset(tree("新文档"), "root");
  assert.equal(h.canUndo(), false);
  assert.equal(h.canRedo(), false);
});

/* ---------------- 与真实树操作配合 ---------------- */

test("真实编辑序列：加子节点 → 改文字 → 逐步撤销回原状", () => {
  const h = createHistory();
  const original = tree("根");
  h.reset(original, "root");

  const added = insertChild(original, "root", "子1");
  h.push(added.root, added.id);

  const renamed = setText(added.root, added.id, "改过的子节点");
  h.push(renamed, added.id);

  assert.equal(h.size(), 3);

  const back1 = h.undo();
  assert.equal(back1.root.children[0].text, "子1", "先撤掉改名");

  const back2 = h.undo();
  assert.equal(back2.root.children.length, 0, "再撤掉新增");

  assert.equal(h.canUndo(), false);
  assert.equal(back2.root.text, "根");
});

test("撤销能恢复被删除的图片元数据", () => {
  const h = createHistory();
  const before = tree("节点");
  h.reset(before, "root");

  const withImage = attachImage(before, "root", {
    id: "img-x",
    type: "image/png",
    name: "x.png",
    width: 10,
    height: 10,
  });
  h.push(withImage, "root");
  assert.equal(withImage.children.length, 0);
  assert.equal(withImage.images.length, 1);

  const back = h.undo();
  assert.equal(back.root.images, undefined, "撤销后图片元数据消失");
});

test("拖动产生的坐标变更也能撤销", () => {
  const h = createHistory();
  const plain = tree("根");
  h.reset(plain, "root");

  const moved = { ...plain, position: { x: 100, y: 200 } };
  h.push(moved, "root");
  assert.deepEqual(h.undo().root.position, undefined);
});

/* ---------------- sameTree ---------------- */

test("sameTree 逐字段比较", () => {
  const base = { id: "r", text: "根", children: [] };
  assert.equal(sameTree(base, structuredClone(base)), true);

  assert.equal(sameTree(base, { ...base, text: "改了" }), false);
  assert.equal(sameTree(base, { ...base, note: "备注" }), false);
  assert.equal(sameTree(base, { ...base, collapsed: true }), false);
  assert.equal(sameTree(base, { ...base, position: { x: 1, y: 2 } }), false);

  const withChild = { ...base, children: [{ id: "c", text: "子", children: [] }] };
  assert.equal(sameTree(base, withChild), false);
  assert.equal(sameTree(withChild, structuredClone(withChild)), true);

  const withImg = { ...base, images: [{ id: "i", type: "image/png", name: "n" }] };
  const otherImg = { ...base, images: [{ id: "i", type: "image/png", name: "n", caption: "说明" }] };
  assert.equal(sameTree(withImg, otherImg), false, "说明文字不同也算不同");
});

test("深层子树差异能被发现", () => {
  const deep = (text) => ({
    id: "r",
    text: "根",
    children: [{ id: "a", text: "A", children: [{ id: "b", text, children: [] }] }],
  });
  assert.equal(sameTree(deep("同"), deep("同")), true);
  assert.equal(sameTree(deep("同"), deep("不同")), false, "深层差异不能漏");
});

/* ---------------- 样式也必须算作"变化" ---------------- */

test("只改样式也算变化（否则撤销键会一直是灰的）", () => {
  const plain = { id: "r", text: "根", children: [] };
  const styled = { ...plain, style: { color: "blue" } };
  assert.equal(sameTree(plain, styled), false, "加样式必须被识别为变化");

  const h = createHistory();
  h.reset(plain, "root");
  h.push(styled, "root");
  assert.equal(h.canUndo(), true, "改样式后必须能撤销");

  const back = h.undo();
  assert.equal(back.root.style, undefined, "撤销后样式应恢复");
});

test("样式的每个字段都能区分", () => {
  const base = { id: "r", text: "根", children: [], style: { color: "blue" } };
  for (const patch of [
    { color: "red" },
    { color: "blue", fontSize: 16 },
    { color: "blue", bold: true },
    { color: "blue", italic: true },
    { color: "blue", radius: 8 },
    { color: "blue", borderWidth: 2 },
  ]) {
    const changed = { ...base, style: { ...base.style, ...patch } };
    assert.equal(sameTree(base, changed), false, "样式变化没被识别：" + JSON.stringify(patch));
  }
});

test("样式完全相同时仍判为无变化（不会产生多余历史）", () => {
  const a = { id: "r", text: "根", children: [], style: { color: "blue", fontSize: 16, bold: true } };
  const b = structuredClone(a);
  assert.equal(sameTree(a, b), true);
});

/* ---------------- 连线文字也要算作"变化" ---------------- */

test("只改连线文字也算变化（否则撤销键会一直是灰的）", () => {
  const plain = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  const labeled = {
    ...plain,
    children: [{ id: "a", text: "A", edgeLabel: "关系说明", children: [] }],
  };
  assert.equal(sameTree(plain, labeled), false, "加连线文字必须被识别为变化");

  const h = createHistory();
  h.reset(plain, "a");
  h.push(labeled, "a");
  assert.equal(h.canUndo(), true, "改连线文字后必须能撤销");
  assert.equal(h.undo().root.children[0].edgeLabel, undefined, "撤销后标签应恢复");
});

/* ---------------- multiTheme 必须跟着撤销一起回滚 ---------------- */

test("撤销新增主题时，多主题标记也要回滚", () => {
  /*
   * 只回滚树不回滚标记的后果：得到"多主题标记 + 单主题树"的坏状态——
   * 多主题模式下根节点是不渲染的容器，于是真正的根节点凭空消失。
   */
  const single = { id: "r", text: "中心主题", children: [] };
  const container = {
    id: "c",
    text: "",
    children: [
      { id: "r", text: "中心主题", children: [] },
      { id: "t2", text: "第二个主题", children: [] },
    ],
  };

  const h = createHistory();
  h.reset(single, "r", false);
  h.push(container, "t2", true);

  const back = h.undo();
  assert.ok(back);
  assert.equal(back.multiTheme, false, "撤销后必须回到单主题");
  assert.equal(back.root.id, "r", "根节点回到中心节点");

  const again = h.redo();
  assert.ok(again);
  assert.equal(again.multiTheme, true, "重做后回到多主题");
  assert.equal(again.root.children.length, 2);
});

test("只有 multiTheme 变了也要入栈", () => {
  const tree = { id: "r", text: "中心主题", children: [] };
  const h = createHistory();
  h.reset(tree, "r", false);
  h.push(tree, "r", true);
  assert.equal(h.canUndo(), true, "标记变了就是一次真实变化，不能因为树相同就跳过");
});
