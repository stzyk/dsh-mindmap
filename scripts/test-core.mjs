/**
 * 核心逻辑单测：`node --test scripts/test-core.mjs`
 *
 * Node 24 能直接剥离 TS 类型导入 src/core/*.ts，因此不需要先构建。
 * 这里只测纯函数（树操作 / Markdown / 布局），不碰 DOM 与存储——
 * 它们才是"导图"这个东西真正容易出错的地方。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createDoc,
  createNode,
  countNodes,
  insertChild,
  insertSibling,
  maxDepth,
  normalizeDoc,
  normalizeNode,
  pathTo,
  removeNode,
  searchNodes,
  moveSibling,
  indentNode,
  outdentNode,
  toggleCollapse,
  setNote,
  cleanText,
  locate,
  moveNodes,
  cloneNode,
  duplicateNode,
  duplicateNodes,
  setEdgeLabel,
  reparentNode,
  replaceImage,
  MAX_EDGE_LABEL,
  addTheme,
  themesOf,
  collapseToSingleTheme,
  toggleMark,
  detachToTheme,
  addLink,
  removeLink,
  setLinkLabel,
  pruneLinks,
  repointEdge,
  disconnectNode,
  setNodeKind,
  isThemeNode,
  sortSiblingsByPosition,
} from "../src/core/tree.ts";
import { MAX_MARKS } from "../src/core/marks.ts";
import { toMarkdown, toMarkdownForest, toOutline, safeFileName } from "../src/core/markdown.ts";
import { applyStyleToMany, clearStyleMany } from "../src/core/style.ts";
import { layoutTree, layoutForest, estimateWidth, nodeWidth, LAYOUT } from "../src/core/layout.ts";

/** 造一棵固定形状的树：中心 → (分支A → (A1, A2), 分支B)。 */
function sampleTree() {
  return {
    id: "root",
    text: "中心主题",
    children: [
      {
        id: "a",
        text: "分支A",
        children: [
          { id: "a1", text: "叶子 A1", children: [] },
          { id: "a2", text: "叶子 A2", children: [] },
        ],
      },
      { id: "b", text: "分支B", children: [] },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * 树结构
 * ------------------------------------------------------------------ */

test("countNodes / maxDepth 统计整棵树", () => {
  const root = sampleTree();
  assert.equal(countNodes(root), 5);
  assert.equal(maxDepth(root), 3);
});

test("insertChild 插入子节点且不修改原树", () => {
  const root = sampleTree();
  const result = insertChild(root, "b", "新节点");
  assert.ok(result);
  assert.equal(countNodes(result.root), 6);
  assert.equal(countNodes(root), 5, "原树必须保持不变");
  const added = locate(result.root, result.id);
  assert.ok(added);
  assert.equal(added.parent.id, "b");
});

test("insertChild 会自动展开被插入的父节点", () => {
  const root = sampleTree();
  root.children[1].collapsed = true;
  const result = insertChild(root, "b", "子");
  assert.ok(result);
  assert.equal(locate(result.root, "b").node.collapsed, undefined);
});

test("insertSibling 放在目标之后；根节点的兄弟退化为子节点", () => {
  const root = sampleTree();
  const afterA = insertSibling(root, "a", "A 的兄弟");
  assert.ok(afterA);
  assert.deepEqual(
    locate(afterA.root, "root").node.children.map((n) => n.text),
    ["分支A", "A 的兄弟", "分支B"],
  );

  const rootSibling = insertSibling(root, "root", "根的兄弟");
  assert.ok(rootSibling);
  assert.deepEqual(
    locate(rootSibling.root, "root").node.children.map((n) => n.text),
    ["分支A", "分支B", "根的兄弟"],
  );
});

test("removeNode 删除子树并把焦点交给相邻兄弟", () => {
  const root = sampleTree();
  const removed = removeNode(root, "a");
  assert.ok(removed);
  assert.equal(countNodes(removed.root), 2);
  assert.equal(removed.focusId, "b", "下一个兄弟优先");

  const removedLast = removeNode(root, "b");
  assert.equal(removedLast.focusId, "a", "没有下一个就用上一个");
});

test("removeNode 不允许删除根节点", () => {
  assert.equal(removeNode(sampleTree(), "root"), undefined);
});

test("moveSibling 在边界上不动", () => {
  const root = sampleTree();
  const moved = moveSibling(root, "b", -1);
  assert.ok(moved);
  assert.deepEqual(
    locate(moved, "root").node.children.map((n) => n.id),
    ["b", "a"],
  );
  assert.equal(moveSibling(root, "a", -1), undefined, "第一个不能再上移");
  assert.equal(moveSibling(root, "b", 1), undefined, "最后一个不能再下移");
});

test("indentNode 变成前一个兄弟的子节点", () => {
  const root = sampleTree();
  const indented = indentNode(root, "b");
  assert.ok(indented);
  assert.equal(locate(indented, "b").parent.id, "a");
  assert.equal(locate(indented, "b").depth, 2);
  assert.equal(indentNode(root, "a"), undefined, "第一个兄弟无法缩进");
});

test("outdentNode 升级成父节点的下一个兄弟", () => {
  const root = sampleTree();
  const outdented = outdentNode(root, "a1");
  assert.ok(outdented);
  assert.equal(locate(outdented, "a1").parent.id, "root");
  assert.equal(locate(outdented, "a1").index, 1);
});

test("toggleCollapse 翻转折叠状态，根节点不可折叠", () => {
  const root = sampleTree();
  const collapsed = toggleCollapse(root, "a");
  assert.equal(locate(collapsed, "a").node.collapsed, true);
  const expanded = toggleCollapse(collapsed, "a");
  assert.equal(locate(expanded, "a").node.collapsed, undefined);
  assert.equal(toggleCollapse(root, "root"), undefined);
});

test("setNote 写备注，空字符串删除备注", () => {
  const root = sampleTree();
  const withNote = setNote(root, "a", "  记一笔  ");
  assert.equal(locate(withNote, "a").node.note, "记一笔");
  const cleared = setNote(withNote, "a", "");
  assert.equal(locate(cleared, "a").node.note, undefined);
});

test("pathTo 返回从根到目标的完整路径", () => {
  const trail = pathTo(sampleTree(), "a2");
  assert.deepEqual(trail.map((n) => n.id), ["root", "a", "a2"]);
  assert.deepEqual(pathTo(sampleTree(), "不存在"), []);
});

test("searchNodes 命中文字并带出路径", () => {
  const hits = searchNodes(sampleTree(), "叶子");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].path, "中心主题 / 分支A / 叶子 A1");
  assert.deepEqual(searchNodes(sampleTree(), "   "), [], "空查询不返回任何命中");
});

test("cleanText 折叠换行并限长", () => {
  assert.equal(cleanText("  一行\n\n两行  "), "一行 两行");
  assert.equal(cleanText(123), "");
  assert.equal(cleanText("x".repeat(500)).length, 400);
});

/* ------------------------------------------------------------------ *
 * 校验 / 修复
 * ------------------------------------------------------------------ */

test("normalizeDoc 补全缺失字段并能吃下脏数据", () => {
  const doc = normalizeDoc({ title: "  我的图  ", root: { text: "根", children: [{ text: "子" }] } });
  assert.equal(doc.title, "我的图");
  assert.equal(doc.root.text, "根");
  assert.ok(doc.id.startsWith("doc-"));
  assert.ok(doc.root.children[0].id.length > 0, "缺失 id 会被补出来");
  assert.equal(typeof doc.createdAt, "number");
});

test("normalizeNode 截断超深嵌套与超量节点", () => {
  let deep = { id: "d0", text: "0", children: [] };
  let cursor = deep;
  for (let i = 1; i <= 40; i += 1) {
    const next = { id: "d" + i, text: String(i), children: [] };
    cursor.children = [next];
    cursor = next;
  }
  const normalized = normalizeNode(deep);
  assert.ok(maxDepth(normalized) <= 33, "深度被限制在 32 层以内，实际 " + maxDepth(normalized));

  const wide = { id: "w", text: "w", children: Array.from({ length: 6000 }, (_, i) => ({ id: "c" + i, text: "c", children: [] })) };
  const limited = normalizeNode(wide);
  assert.ok(countNodes(limited) <= 5000, "节点总数被限制在 5000 以内");
});

test("normalizeDoc 对非对象输入也返回可用文档", () => {
  const doc = normalizeDoc(null);
  assert.equal(doc.title, "未命名导图");
  assert.ok(doc.root.id.length > 0);
});

/* ------------------------------------------------------------------ *
 * Markdown
 * ------------------------------------------------------------------ */

test("toMarkdown headings 形态：每层多一个 #", () => {
  const md = toMarkdown(sampleTree());
  assert.equal(
    md,
    ["# 中心主题", "", "## 分支A", "", "### 叶子 A1", "", "### 叶子 A2", "", "## 分支B", ""].join("\n"),
  );
});

test("toMarkdown headings 形态：第 7 级起降级为列表", () => {
  let node = createNode("L1");
  let cursor = node;
  for (let i = 2; i <= 8; i += 1) {
    const next = createNode("L" + i);
    cursor.children.push(next);
    cursor = next;
  }
  const md = toMarkdown(node);
  assert.match(md, /^###### L6$/m, "第 6 级仍是 H6");
  assert.match(md, /^- L7$/m, "第 7 级改用列表");
  assert.match(md, /^ {2}- L8$/m, "第 8 级相对第 7 级缩进一层");
});

test("toMarkdown list 形态：整棵树是嵌套无序列表", () => {
  const md = toMarkdown(sampleTree(), { mode: "list" });
  assert.equal(
    md,
    ["- 中心主题", "  - 分支A", "    - 叶子 A1", "    - 叶子 A2", "  - 分支B", ""].join("\n"),
  );
});

test("toMarkdown 备注渲染成引用块", () => {
  const root = sampleTree();
  root.children[0].note = "第一行\n\n第二行";
  const md = toMarkdown(root);
  assert.match(md, /^## 分支A$/m);
  assert.match(md, /^> 第一行$/m);
  assert.match(md, /^>$/m, "空行保持引用块连续");
  assert.match(md, /^> 第二行$/m);

  const withoutNotes = toMarkdown(root, { includeNotes: false });
  assert.doesNotMatch(withoutNotes, /> 第一行/);
});

test("toMarkdown 空文字节点有占位符，不会导出空标题", () => {
  const root = { id: "r", text: "根", children: [{ id: "e", text: "", children: [] }] };
  const md = toMarkdown(root);
  assert.match(md, /## （空节点）/);
});

test("toMarkdown includeTitle 输出文档头，且全篇只有一个 H1", () => {
  const md = toMarkdown(sampleTree(), { includeTitle: true, title: "我的图" });
  assert.ok(md.startsWith("# 我的图\n\n## 中心主题"), "文档标题在前，根节点下沉为 H2");
  assert.equal((md.match(/^# /gm) ?? []).length, 1, "整篇只有一个 H1");
});

test("toOutline 是 list 形态且不含备注", () => {
  const root = sampleTree();
  root.children[1].note = "不该出现";
  const outline = toOutline(root);
  assert.match(outline, /^- 中心主题$/m);
  assert.doesNotMatch(outline, /不该出现/);
});

test("safeFileName 去掉路径分隔符并兜底", () => {
  assert.equal(safeFileName('a/b:c*?"<>|d'), "a-b-c-d");
  assert.equal(safeFileName("   "), "mindmap");
});

/* ------------------------------------------------------------------ *
 * 布局
 * ------------------------------------------------------------------ */

test("layoutTree 生成所有可见节点与连线", () => {
  const layout = layoutTree(sampleTree());
  assert.equal(layout.nodes.length, 5);
  assert.equal(layout.links.length, 4, "每个非根节点一条连线");
  assert.ok(layout.width > 0 && layout.height > 0);
});

test("layoutTree 收起的节点不产生子节点但保留 hasChildren", () => {
  const root = sampleTree();
  root.children[0].collapsed = true;
  const layout = layoutTree(root);
  assert.equal(layout.nodes.length, 3, "A1 / A2 被收起");
  const a = layout.nodes.find((n) => n.id === "a");
  assert.equal(a.collapsed, true);
  assert.equal(a.hasChildren, true);
});

test("layoutTree 子节点整体垂直居中于父节点子树块，且父在子左侧", () => {
  const layout = layoutTree(sampleTree());
  const root = layout.nodes.find((n) => n.id === "root");
  const a = layout.nodes.find((n) => n.id === "a");
  const b = layout.nodes.find((n) => n.id === "b");
  assert.ok(a.x > root.x, "子节点在右侧");
  assert.ok(b.y > a.y, "兄弟按顺序向下排");
  const centerA = a.y + a.height / 2;
  const centerB = b.y + b.height / 2;
  const centerRoot = root.y + root.height / 2;
  assert.ok(Math.abs((centerA + centerB) / 2 - centerRoot) < 1, "父节点位于两个子树块的正中");
});

test("layoutTree 不产生节点重叠", () => {
  const layout = layoutTree(sampleTree());
  const boxes = layout.nodes.map((n) => ({ id: n.id, top: n.y, bottom: n.y + n.height, left: n.x, right: n.x + n.width }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX = a.left < b.right && b.left < a.right;
      const overlapY = a.top < b.bottom && b.top < a.bottom;
      assert.ok(!(overlapX && overlapY), `节点 ${a.id} 与 ${b.id} 重叠了`);
    }
  }
});

test("nodeWidth 夹在最小/最大宽度之间，CJK 比等长 ASCII 更宽", () => {
  assert.equal(nodeWidth(""), LAYOUT.minWidth);
  assert.equal(nodeWidth("很长很长".repeat(50)), LAYOUT.maxWidth);
  assert.ok(estimateWidth("中文字符") > estimateWidth("abcd"), "同为 4 字符时 CJK 更宽");
});

test("layoutTree 深树宽度随深度增长", () => {
  const shallow = layoutTree({ id: "r", text: "根", children: [] });
  let deepRoot = { id: "r2", text: "根", children: [] };
  let cursor = deepRoot;
  for (let i = 0; i < 5; i += 1) {
    const next = { id: "n" + i, text: "层", children: [] };
    cursor.children = [next];
    cursor = next;
  }
  assert.ok(layoutTree(deepRoot).width > shallow.width);
});

/* ------------------------------------------------------------------ *
 * 样式语义护栏
 *
 * 根节点曾经把「文字色」当背景、「页面底色」当前景来做反色高亮，
 * 默认主题下能跑，换肤（data-dsh-skin=xp）之后两个变量不再成对，
 * 渲染成整块纯黑、文字与背景同色。这类错误所有功能断言都抓不到，
 * 只能靠静态检查风格：前景色必须来自 label 系列，背景色必须来自 bg 系列，
 * 不允许交叉使用。
 * ------------------------------------------------------------------ */

import { CSS } from "../src/client/styles.ts";

/** 抠出某条规则的声明体。 */
function ruleBody(css, selector) {
  const index = css.indexOf(selector + " {");
  if (index < 0) return "";
  const end = css.indexOf("}", index);
  return css.slice(index, end);
}

test("样式不允许把 label-* 当作 background（换肤后会变纯黑块）", () => {
  // label-* 是文字色，bg-* 是底色。交叉使用在某个皮肤下必然失去对比度。
  const offenders = [];
  const lines = CSS.split("\n");
  let currentSelector = "";
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const selectorMatch = /^\.mm-[^{]+\{\s*$/.exec(line.trim()) || /^([^{]+)\{$/.exec(line.trim());
    if (selectorMatch) currentSelector = (selectorMatch[1] ?? "").trim();
    // background 属性里出现 label 变量 = 违规
    if (/background[^:]*:\s*[^;]*var\(--dsw-alias-label-/.test(line)) {
      offenders.push(currentSelector + " → " + line.trim());
    }
  }
  assert.deepEqual(offenders, [], "这些规则把文字色当成了背景色：\n" + offenders.join("\n"));
});

test("根节点前景色来自 label 系列，且不再依赖反色变量", () => {
  const body = ruleBody(CSS, '.mm-node[data-root="true"]');
  assert.ok(body.length > 0, "找不到根节点规则");
  assert.match(body, /color:\s*var\(--dsw-alias-label-primary/, "根节点前景必须是 label-primary");
  assert.doesNotMatch(body, /background:\s*var\(--dsw-alias-label-/, "根节点背景不能再用 label");
  assert.doesNotMatch(body, /color:\s*var\(--dsw-alias-bg-/, "根节点前景不能再用 bg 系列");
});

test("节点编辑框显式声明前景色与 caret，不靠 inherit", () => {
  const body = ruleBody(CSS, ".mm-node-input");
  assert.match(body, /color:\s*var\(--dsw-alias-label-primary/, "编辑框必须显式给前景色");
  assert.match(body, /caret-color:\s*currentColor/, "光标颜色必须跟随前景色");
  assert.match(body, /background-color:\s*transparent/, "用长写 background-color，避免被简写重置");
});

/* ------------------------------------------------------------------ *
 * 手动摆放位置
 *
 * 用户要的是"节点能自由拖"，但树的结构不能因此变形——所以位置是
 * 节点上的**可选**字段：有就固定在那，没有就继续自动布局。
 * 这一组测的就是这条边界，尤其"拖了根节点之后子树不能消失"。
 * ------------------------------------------------------------------ */

import {
  setPosition,
  clearPosition,
  clearAllPositions,
  hasManualPositions,
  MAX_COORD,
} from "../src/core/tree.ts";

test("setPosition 写入坐标且不修改原树；clone 保留坐标", () => {
  const root = sampleTree();
  const moved = setPosition(root, "b", 300, 120);
  assert.ok(moved);
  const node = locate(moved, "b").node;
  assert.deepEqual(node.position, { x: 300, y: 120 });
  assert.equal(locate(root, "b").node.position, undefined, "原树不能被改动");

  // 再走一次 cloneNode（经由任意结构操作）坐标必须还在
  const resaved = insertChild(moved, "b", "子");
  assert.deepEqual(locate(resaved.root, "b").node.position, { x: 300, y: 120 });
});

test("setPosition 拒绝非有限值与越界坐标", () => {
  const root = sampleTree();
  assert.equal(setPosition(root, "b", NaN, 10), undefined);
  assert.equal(setPosition(root, "b", 10, Infinity), undefined);
  assert.equal(setPosition(root, "b", MAX_COORD + 1, 0), undefined);
  assert.equal(setPosition(root, "不存在", 1, 2), undefined);
});

test("normalizeDoc 保留合法坐标、丢弃非法坐标", () => {
  const good = normalizeDoc({
    title: "t",
    root: { text: "根", position: { x: 12, y: 34 }, children: [] },
  });
  assert.deepEqual(good.root.position, { x: 12, y: 34 });

  const bad = normalizeDoc({
    title: "t",
    root: { text: "根", position: { x: "12", y: null }, children: [] },
  });
  assert.equal(bad.root.position, undefined, "字符串坐标应被丢弃");

  const huge = normalizeDoc({
    title: "t",
    root: { text: "根", position: { x: MAX_COORD * 10, y: 0 }, children: [] },
  });
  assert.equal(huge.root.position, undefined, "越界坐标应被丢弃，回自动布局");
});

test("layoutTree 使用手动坐标摆节点", () => {
  const root = sampleTree();
  const moved = setPosition(root, "b", 400, 260);
  const layout = layoutTree(moved);
  const b = layout.nodes.find((n) => n.id === "b");
  assert.equal(b.x, 400);
  assert.equal(b.y, 260);
  assert.equal(b.manual, true);

  const a = layout.nodes.find((n) => n.id === "a");
  assert.equal(a.manual, undefined, "没拖过的节点仍是自动布局");
});

test("拖动根节点后子树仍然全部渲染（不能整棵树消失）", () => {
  const root = sampleTree();
  const moved = setPosition(root, "root", 500, 300);
  const layout = layoutTree(moved);
  assert.equal(layout.nodes.length, 5, "5 个节点一个都不能少");
  const rootNode = layout.nodes.find((n) => n.id === "root");
  assert.equal(rootNode.x, 500);
  assert.equal(rootNode.y, 300);
  // 子树跟着父节点往右展开
  for (const childId of ["a", "b"]) {
    const child = layout.nodes.find((n) => n.id === childId);
    assert.ok(child.x > 500, "子节点应在被拖走的父节点右侧");
  }
});

test("手动节点的 y 不会被'对齐子节点中心'覆盖", () => {
  const root = sampleTree();
  // 把 a 拖到一个明显不是自动对齐结果的位置
  const moved = setPosition(root, "a", 300, 500);
  const layout = layoutTree(moved);
  const a = layout.nodes.find((n) => n.id === "a");
  assert.equal(a.y, 500, "用户拖动的位置是决定，不能被布局算法改回去");
});

test("clearPosition 连带清除整棵子树的手动坐标", () => {
  let tree = sampleTree();
  tree = setPosition(tree, "a", 100, 100);
  tree = setPosition(tree, "a1", 200, 200);
  const cleared = clearPosition(tree, "a");
  assert.ok(cleared);
  assert.equal(locate(cleared, "a").node.position, undefined);
  assert.equal(locate(cleared, "a1").node.position, undefined, "子孙也要归位");
});

test("clearAllPositions / hasManualPositions", () => {
  const pristine = sampleTree();
  assert.equal(hasManualPositions(pristine), false, "全新树没有手动坐标");
  assert.equal(hasManualPositions(clearAllPositions(pristine)), false);

  const moved = setPosition(sampleTree(), "a1", 10, 20);
  assert.equal(hasManualPositions(moved), true, "拖过一个节点后应检测到");
  const reset = clearAllPositions(moved);
  assert.equal(hasManualPositions(reset), false);
  assert.equal(layoutTree(reset).nodes.every((n) => n.manual === undefined), true);
});

test("位置不进入 Markdown 输出（拖动不改结构）", () => {
  const plain = sampleTree();
  const moved = setPosition(plain, "a", 999, 888);
  assert.equal(toMarkdown(moved), toMarkdown(plain), "拖动只影响画法，不影响导出的结构");
});

/* ------------------------------------------------------------------ *
 * 节点图片
 * ------------------------------------------------------------------ */

import {
  attachImage,
  detachImage,
  setImageCaption,
  collectImages,
  countImages,
  normalizeNode as _normNode,
} from "../src/core/tree.ts";

const PNG = { id: "img-1", type: "image/png", name: "图一.png", width: 160, height: 90 };

test("attachImage 追加图片且不修改原树", () => {
  const root = sampleTree();
  const next = attachImage(root, "a", PNG);
  assert.ok(next);
  const target = locate(next, "a").node;
  assert.equal(target.images.length, 1);
  assert.equal(target.images[0].id, "img-1");
  assert.equal(locate(root, "a").node.images, undefined, "原树不能被改动");
});

test("attachImage 拒绝重复 id 与超量", () => {
  let tree = sampleTree();
  tree = attachImage(tree, "a", PNG);
  assert.equal(attachImage(tree, "a", PNG), undefined, "同 id 不能重复加");

  let many = sampleTree();
  for (let i = 0; i < 24; i += 1) {
    many = attachImage(many, "a", { ...PNG, id: "img-" + i });
  }
  assert.equal(attachImage(many, "a", { ...PNG, id: "img-over" }), undefined, "单节点上限 24 张");
});

test("detachImage 移除图片，清空后删除字段", () => {
  let tree = sampleTree();
  tree = attachImage(tree, "a", PNG);
  tree = attachImage(tree, "a", { ...PNG, id: "img-2" });

  const one = detachImage(tree, "a", "img-1");
  assert.equal(locate(one, "a").node.images.length, 1);

  const none = detachImage(one, "a", "img-2");
  assert.equal(locate(none, "a").node.images, undefined, "没有图时不该留空数组");
});

test("setImageCaption 写入与清除说明", () => {
  let tree = attachImage(sampleTree(), "a", PNG);
  const withCap = setImageCaption(tree, "a", "img-1", "  架构图  ");
  assert.equal(locate(withCap, "a").node.images[0].caption, "架构图");
  const cleared = setImageCaption(withCap, "a", "img-1", "");
  assert.equal(locate(cleared, "a").node.images[0].caption, undefined);
});

test("collectImages 去重收集全树图片；countImages 计数", () => {
  let tree = attachImage(sampleTree(), "a", PNG);
  tree = attachImage(tree, "b", { ...PNG, id: "img-2" });
  assert.equal(countImages(tree), 2);
  const all = collectImages(tree);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((i) => i.id).sort(), ["img-1", "img-2"]);
});

test("normalizeNode 保留合法图片、丢弃非法图片", () => {
  const good = _normNode({
    id: "n1",
    text: "节点",
    images: [{ id: "img-a", type: "image/png", name: "a.png", width: 10, height: 20 }],
    children: [],
  });
  assert.equal(good.images.length, 1);
  assert.equal(good.images[0].width, 10);

  const bad = _normNode({
    id: "n2",
    text: "节点",
    images: [
      { id: "../../etc/passwd", type: "image/png" }, // 路径穿越
      { id: "ok-id", type: "image/svg+xml" }, // svg 不在白名单
      { id: "ok-id2", type: "image/png", name: "fine.png" },
    ],
    children: [],
  });
  assert.equal(bad.images.length, 1, "只应留下合法那张");
  assert.equal(bad.images[0].id, "ok-id2");
});

test("纯图片节点：文字为空但有图", () => {
  // sampleTree 的节点都有文字；这里显式造一个空文字节点
  const root = { id: "root", text: "根", children: [{ id: "pic", text: "", children: [] }] };
  const tree = attachImage(root, "pic", PNG);
  const pic = locate(tree, "pic").node;
  assert.equal(pic.text.trim().length, 0, "纯图片节点：文字为空");
  assert.equal(pic.images.length, 1, "但有图");
  // 导出时不能被当成"空节点"塞占位符
  const md = toMarkdown(tree, { mode: "list" });
  assert.doesNotMatch(md, /（空节点）/, "纯图片节点不该被写成空节点占位");
});

/* ------------------------------------------------------------------ *
 * Markdown 里的图片
 * ------------------------------------------------------------------ */

test("Markdown 默认用相对路径输出图片", () => {
  const tree = attachImage(sampleTree(), "a", PNG);
  const md = toMarkdown(tree);
  assert.match(md, /!\[图一\.png\]\(assets\/img-1\.png\)/);
});

test("Markdown 说明文字优先作为 alt", () => {
  let tree = attachImage(sampleTree(), "a", PNG);
  tree = setImageCaption(tree, "a", "img-1", "系统架构");
  const md = toMarkdown(tree);
  assert.match(md, /!\[系统架构\]\(assets\/img-1\.png\)/);
});

test("Markdown inline 模式输出 base64 data URI", () => {
  const tree = attachImage(sampleTree(), "a", PNG);
  const md = toMarkdown(tree, {
    images: "inline",
    resolveImage: () => ({ data: "QUJD", type: "image/png" }),
  });
  assert.match(md, /!\[图一\.png\]\(data:image\/png;base64,QUJD\)/);
});

test("Markdown inline 模式下查不到字节则退回路径（不能凭空丢图）", () => {
  const tree = attachImage(sampleTree(), "a", PNG);
  const md = toMarkdown(tree, { images: "inline", resolveImage: () => undefined });
  assert.match(md, /assets\/img-1\.png/, "查不到也要给路径，而不是消失");
});

test("Markdown images:'omit' 完全不输出图片", () => {
  const tree = attachImage(sampleTree(), "a", PNG);
  const md = toMarkdown(tree, { images: "omit" });
  assert.doesNotMatch(md, /!\[/);
});

test("Markdown 列表形态：纯图片节点不产生空圆点", () => {
  const tree = attachImage(sampleTree(), "b", PNG);
  const md = toMarkdown(tree, { mode: "list" });
  assert.doesNotMatch(md, /^\s*-\s*$/m, "不该有空的列表项");
  assert.match(md, /!\[图一\.png\]\(assets\/img-1\.png\)/);
});

/* ------------------------------------------------------------------ *
 * 布局：带图片的节点
 * ------------------------------------------------------------------ */

import { imageDisplaySize, contentSize } from "../src/core/layout.ts";

const IMG = { id: "i1", type: "image/png", name: "a.png", width: 400, height: 300 };

test("imageDisplaySize 等比缩放到上限内", () => {
  const size = imageDisplaySize({ width: 400, height: 300 }, 132);
  assert.ok(size.width <= 132 && size.height <= 132);
  assert.ok(Math.abs(size.width / size.height - 400 / 300) < 0.05, "必须保持宽高比");
});

test("imageDisplaySize 不放大小图", () => {
  const size = imageDisplaySize({ width: 40, height: 30 }, 132);
  assert.equal(size.width, 40);
  assert.equal(size.height, 30);
});

test("contentSize：带图片的节点明显更高", () => {
  const plain = contentSize({ id: "a", text: "文字", children: [] }, 1);
  const withImg = contentSize(
    { id: "b", text: "文字", images: [IMG], children: [] },
    1,
  );
  assert.ok(withImg.height > plain.height + 40, `图片节点应更高：${plain.height} vs ${withImg.height}`);
});

test("纯图片节点：没有文字行，只有图片", () => {
  const picOnly = contentSize({ id: "c", text: "", images: [IMG], children: [] }, 1);
  const withText = contentSize({ id: "d", text: "有字", images: [IMG], children: [] }, 1);
  assert.ok(picOnly.height < withText.height, "纯图片应比图文节点矮");
  assert.ok(picOnly.height > 100, "但仍要容纳图片");
});

test("布局不因图片节点而重叠", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "带图", images: [IMG], children: [] },
      { id: "b", text: "普通", children: [] },
      { id: "c", text: "", images: [{ ...IMG, id: "i2" }], children: [] },
    ],
  };
  const layout = layoutTree(root);
  const boxes = layout.nodes.map((n) => ({ id: n.id, t: n.y, b: n.y + n.height, l: n.x, r: n.x + n.width }));
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const A = boxes[i];
      const B = boxes[j];
      const overlapX = A.l < B.r && B.l < A.r;
      const overlapY = A.t < B.b && B.t < A.b;
      assert.ok(!(overlapX && overlapY), `${A.id} 与 ${B.id} 重叠了`);
    }
  }
});

test("布局结果带出图片显示尺寸供渲染用", () => {
  const layout = layoutTree({ id: "r", text: "根", children: [{ id: "a", text: "图", images: [IMG], children: [] }] });
  const a = layout.nodes.find((n) => n.id === "a");
  assert.equal(a.images.length, 1);
  assert.equal(a.images[0].id, "i1");
  assert.ok(a.images[0].width <= 132);
  assert.equal(a.hasText, true);
});

test("纯图片节点 hasText 为 false", () => {
  const layout = layoutTree({ id: "r", text: "", images: [IMG], children: [] });
  assert.equal(layout.nodes[0].hasText, false);
});

/* ------------------------------------------------------------------ *
 * 标题层级：带文档标题时不能每层多沉两级
 *
 * 这是一个真实 bug：`headingsBody` 递归时把已含 baseDepth 的 depth
 * 当相对深度传下去，导致下一层再加一次 baseDepth，层级呈 1/3/5/7 递增。
 * 表现出来是"带标题导出的文档，层级和画布完全对不上"。
 * ------------------------------------------------------------------ */

test("带文档标题时标题层级逐级递增（不能跳级）", () => {
  const deep = {
    id: "r",
    text: "根",
    children: [
      {
        id: "a",
        text: "A",
        children: [{ id: "a1", text: "A1", children: [{ id: "a2", text: "A2", children: [] }] }],
      },
    ],
  };
  const md = toMarkdown(deep, { includeTitle: true, title: "文档" });
  const levels = md
    .split("\n")
    .map((line) => /^(#{1,6})\s+(.*)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => [m[2].trim(), m[1].length]);

  assert.deepEqual(levels, [
    ["文档", 1],
    ["根", 2],
    ["A", 3],
    ["A1", 4],
    ["A2", 5],
  ]);
});

test("不带文档标题时根就是 H1", () => {
  const tree = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  const md = toMarkdown(tree);
  assert.match(md, /^# 根$/m);
  assert.match(md, /^## A$/m);
});

test("深树超过 6 级后降级为列表，且缩进连续", () => {
  let node = { id: "n1", text: "L1", children: [] };
  let cursor = node;
  for (let i = 2; i <= 9; i += 1) {
    const next = { id: "n" + i, text: "L" + i, children: [] };
    cursor.children.push(next);
    cursor = next;
  }
  const md = toMarkdown(node, { includeTitle: true, title: "文档" });
  // L1 应该是 H2（文档标题占 H1）
  assert.match(md, /^## L1$/m, "带文档标题时根应为 H2");
  assert.match(md, /^###### L5$/m, "第 5 层应是 H6");
  assert.match(md, /^- L6$/m, "第 6 层起降级为列表");
  assert.match(md, /^ {2}- L7$/m, "第 7 层缩进一层");
});

/* ------------------------------------------------------------------ *
 * 多选批量操作
 *
 * 重点是"相对位置必须保留"：多选拖动是整体平移，不是把所有节点
 * 设成同一个坐标（那样一拖就全叠在一起）。
 * ------------------------------------------------------------------ */

test("批量平移保留节点间的相对位置", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", position: { x: 100, y: 100 }, children: [] },
      { id: "b", text: "B", position: { x: 300, y: 100 }, children: [] },
    ],
  };
  const next = moveNodes(root, ["a", "b"], 50, 20, () => undefined);
  assert.deepEqual(next.children[0].position, { x: 150, y: 120 });
  assert.deepEqual(next.children[1].position, { x: 350, y: 120 });
  // 相对距离不变
  assert.equal(
    next.children[1].position.x - next.children[0].position.x,
    200,
    "两个节点的水平间距必须保持不变",
  );
});

test("没有手动位置的节点按自动布局基准平移", () => {
  const root = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  const base = (id) => (id === "a" ? { x: 40, y: 60 } : undefined);
  const next = moveNodes(root, ["a"], 10, 15, base);
  assert.deepEqual(
    next.children[0].position,
    { x: 50, y: 75 },
    "从没拖过的节点必须基于它当前的自动位置，而不是画布原点",
  );
});

test("批量平移不修改原树", () => {
  const root = {
    id: "r",
    text: "根",
    children: [{ id: "a", text: "A", position: { x: 1, y: 2 }, children: [] }],
  };
  moveNodes(root, ["a"], 10, 10, () => undefined);
  assert.deepEqual(root.children[0].position, { x: 1, y: 2 });
});

test("批量平移：非法坐标被拒绝", () => {
  const root = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  assert.equal(moveNodes(root, ["a"], NaN, 0, () => ({ x: 0, y: 0 })), undefined);
  assert.equal(moveNodes(root, ["a"], 0, Infinity, () => ({ x: 0, y: 0 })), undefined);
});

test("批量平移：id 不存在时返回 undefined", () => {
  const root = { id: "r", text: "根", children: [] };
  assert.equal(moveNodes(root, ["nope"], 10, 10, () => ({ x: 0, y: 0 })), undefined);
});

test("批量样式作用到所有选中节点，不波及未选中的", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", children: [] },
      { id: "b", text: "B", children: [] },
      { id: "c", text: "C", children: [] },
    ],
  };
  const next = applyStyleToMany(root, ["a", "b"], { color: "blue" }, cloneNode, locate);
  assert.deepEqual(next.children[0].style, { color: "blue" });
  assert.deepEqual(next.children[1].style, { color: "blue" });
  assert.equal(next.children[2].style, undefined, "没选中的节点不该被改");
  assert.equal(next.style, undefined, "根节点没选中，不该被改");
});

test("批量样式保留各节点原有的其它属性", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", style: { fontSize: 20, bold: true }, children: [] },
      { id: "b", text: "B", style: { fontSize: 11 }, children: [] },
    ],
  };
  const next = applyStyleToMany(root, ["a", "b"], { color: "teal" }, cloneNode, locate);
  assert.deepEqual(next.children[0].style, { fontSize: 20, bold: true, color: "teal" });
  assert.deepEqual(next.children[1].style, { fontSize: 11, color: "teal" });
});

test("批量清除样式只清选中的", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", style: { color: "blue" }, children: [] },
      { id: "b", text: "B", style: { color: "red" }, children: [] },
    ],
  };
  const next = clearStyleMany(root, ["a"], cloneNode, locate);
  assert.equal(next.children[0].style, undefined);
  assert.deepEqual(next.children[1].style, { color: "red" }, "没选中的样式要留着");
});

test("批量样式：一个都没命中时返回 undefined", () => {
  const root = { id: "r", text: "根", children: [] };
  assert.equal(applyStyleToMany(root, ["nope"], { color: "blue" }, cloneNode, locate), undefined);
  assert.equal(clearStyleMany(root, ["nope"], cloneNode, locate), undefined);
});

/* ------------------------------------------------------------------ *
 * 复制节点（含子树）
 *
 * 最关键的约束是 id 必须全部换新：复用原 id 会让两个节点共享身份，
 * 选中、删除、撤销全都会串。这类错误在数据层就已经坏了。
 * ------------------------------------------------------------------ */

test("复制节点会插入一个同级，且子树完整", () => {
  let n = 0;
  const makeId = () => "new-" + String(++n);
  const root = {
    id: "r",
    text: "根",
    children: [
      {
        id: "a",
        text: "A",
        children: [
          { id: "a1", text: "A1", children: [{ id: "a11", text: "A11", children: [] }] },
          { id: "a2", text: "A2", children: [] },
        ],
      },
      { id: "b", text: "B", children: [] },
    ],
  };

  const result = duplicateNode(root, "a", makeId);
  assert.ok(result);

  // 副本紧跟在原节点后面
  assert.equal(result.root.children.length, 3);
  assert.equal(result.root.children[0].id, "a", "原节点还在原位");
  assert.equal(result.root.children[1].text, "A", "副本是第二个");
  assert.equal(result.root.children[2].id, "b", "后面的兄弟没被挤走");

  // 子树深度和结构一致
  const copy = result.root.children[1];
  assert.equal(copy.children.length, 2);
  assert.equal(copy.children[0].children.length, 1);
  assert.equal(copy.children[0].children[0].text, "A11");
});

test("复制出的每个节点都换了新 id（全树 id 唯一）", () => {
  let n = 0;
  const makeId = () => "new-" + String(++n);
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
    ],
  };
  const result = duplicateNode(root, "a", makeId);
  assert.ok(result);

  const ids = [];
  const walk = (node) => {
    ids.push(node.id);
    node.children.forEach(walk);
  };
  walk(result.root);

  assert.equal(new Set(ids).size, ids.length, "不能出现重复 id：" + JSON.stringify(ids));
  // 根 + 原 A + 原 A1 + 副本 A + 副本的 A1 = 5
  assert.equal(ids.length, 5, "复制子树后节点总数应为 5，实际 " + String(ids.length));
});

test("复制保留文字、备注、样式、图片、折叠状态", () => {
  let n = 0;
  const root = {
    id: "r",
    text: "根",
    children: [
      {
        id: "a",
        text: "带属性的节点",
        note: "一段备注",
        collapsed: true,
        style: { color: "blue", fontSize: 16 },
        images: [{ id: "img-1", type: "image/png", name: "x.png", width: 10, height: 10 }],
        children: [],
      },
    ],
  };
  const copy = duplicateNode(root, "a", () => "new-" + String(++n)).root.children[1];
  assert.equal(copy.text, "带属性的节点");
  assert.equal(copy.note, "一段备注");
  assert.equal(copy.collapsed, true);
  assert.deepEqual(copy.style, { color: "blue", fontSize: 16 });
  assert.deepEqual(copy.images.map((i) => i.id), ["img-1"], "图片共用同一份资源");
});

test("复制不修改原树", () => {
  const root = {
    id: "r",
    text: "根",
    children: [{ id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] }],
  };
  const snapshot = JSON.stringify(root);
  duplicateNode(root, "a", () => "x");
  assert.equal(JSON.stringify(root), snapshot);
});

test("根节点不可复制（没有同级）", () => {
  const root = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  assert.equal(duplicateNode(root, "r", () => "x"), undefined);
});

test("不存在的 id 返回 undefined", () => {
  const root = { id: "r", text: "根", children: [] };
  assert.equal(duplicateNode(root, "nope", () => "x"), undefined);
});

test("手动摆放过的节点，副本会偏移一点（不会完全重叠）", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      {
        id: "a",
        text: "A",
        position: { x: 100, y: 200 },
        children: [{ id: "a1", text: "A1", position: { x: 300, y: 200 }, children: [] }],
      },
    ],
  };
  const copy = duplicateNode(root, "a", () => "n").root.children[1];
  assert.deepEqual(copy.position, { x: 128, y: 228 });
  assert.deepEqual(
    copy.children[0].position,
    { x: 328, y: 228 },
    "子树整体偏移，形状不变",
  );
});

test("没有手动位置的节点，副本也不设 position（交给自动布局）", () => {
  const root = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  const copy = duplicateNode(root, "a", () => "n").root.children[1];
  assert.equal(copy.position, undefined);
});

test("批量复制多个节点", () => {
  let n = 0;
  const makeId = () => "new-" + String(++n);
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", children: [] },
      { id: "b", text: "B", children: [] },
    ],
  };
  const result = duplicateNodes(root, ["a", "b"], makeId);
  assert.ok(result);
  assert.equal(result.ids.length, 2);
  // 根下应有 4 个：A, A副本, B, B副本
  assert.equal(result.root.children.length, 4);
  const ids = [];
  const walk = (node) => {
    ids.push(node.id);
    node.children.forEach(walk);
  };
  walk(result.root);
  assert.equal(new Set(ids).size, ids.length, "批量复制后 id 仍必须唯一");
});

test("批量复制：一个都失败时返回 undefined", () => {
  const root = { id: "r", text: "根", children: [] };
  assert.equal(duplicateNodes(root, ["r", "nope"], () => "x"), undefined);
});

/* ------------------------------------------------------------------ *
 * 连线：文字描述 + 改关联
 *
 * 连线是父子关系推导出来的（没有独立的边表），所以"改关联" = 换父节点，
 * "连线文字"挂在子节点上。这里的重点是环检测与标签跟随。
 * ------------------------------------------------------------------ */

test("设置与清除连线文字", () => {
  const root = {
    id: "r",
    text: "根",
    children: [{ id: "a", text: "A", children: [] }],
  };
  const labeled = setEdgeLabel(root, "a", "  依赖   关系 ");
  assert.equal(labeled.children[0].edgeLabel, "依赖 关系", "多余空白被折叠");
  assert.equal(setEdgeLabel(labeled, "a", "").children[0].edgeLabel, undefined, "空串表示清除");
  assert.equal(setEdgeLabel(root, "r", "x"), undefined, "根节点没有连线，不能加文字");
  assert.equal(setEdgeLabel(root, "nope", "x"), undefined);
});

test("连线文字有长度上限", () => {
  const root = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  const long = setEdgeLabel(root, "a", "x".repeat(500));
  assert.equal(long.children[0].edgeLabel.length, MAX_EDGE_LABEL);
});

test("改关联：把节点挂到另一个父节点下，子树一起走", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", edgeLabel: "a 的线", children: [{ id: "a1", text: "A1", children: [] }] },
      { id: "b", text: "B", children: [] },
    ],
  };
  const next = reparentNode(root, "a", "b");
  assert.ok(next);
  assert.equal(next.children.length, 1, "A 从根下面移走了");
  assert.equal(next.children[0].id, "b");
  assert.equal(next.children[0].children[0].id, "a", "A 挂到了 B 下");
  assert.equal(next.children[0].children[0].children[0].id, "a1", "子树跟着走");
  assert.equal(next.children[0].children[0].edgeLabel, "a 的线", "连线文字跟着节点");
});

test("改关联拒绝成环（挂到自己的子孙上）", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [{ id: "a11", text: "A11", children: [] }] }] },
    ],
  };
  assert.equal(reparentNode(root, "a", "a1"), undefined, "直接子节点");
  assert.equal(reparentNode(root, "a", "a11"), undefined, "深层子孙");
  assert.equal(reparentNode(root, "a", "a"), undefined, "自己");
  assert.equal(reparentNode(root, "r", "a"), undefined, "根节点不能移动");
  assert.equal(reparentNode(root, "a", "r"), undefined, "已经挂在同一个父级下");
});

test("改关联不修改原树", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", children: [] },
      { id: "b", text: "B", children: [] },
    ],
  };
  const snapshot = JSON.stringify(root);
  reparentNode(root, "a", "b");
  assert.equal(JSON.stringify(root), snapshot);
});

test("改关联会把折叠的新父级展开（否则节点看起来消失了）", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", children: [] },
      { id: "b", text: "B", collapsed: true, children: [{ id: "b1", text: "B1", children: [] }] },
    ],
  };
  const next = reparentNode(root, "a", "b");
  // A 移走后 B 变成第 0 个，不能按下标取，必须按 id 查
  const b = next.children.find((c) => c.id === "b");
  assert.ok(b);
  assert.equal(b.collapsed, undefined, "挂进去之后必须能看到");
  assert.ok(b.children.some((c) => c.id === "a"), "A 确实挂进去了");
});

test("布局把连线文字带到 link 上，并给出曲线中点", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", edgeLabel: "说明", children: [] },
      { id: "b", text: "B", children: [] },
    ],
  };
  const layout = layoutTree(root);
  const linkA = layout.links.find((l) => l.toId === "a");
  assert.ok(linkA);
  assert.equal(linkA.label, "说明");
  assert.ok(Number.isFinite(linkA.labelX) && Number.isFinite(linkA.labelY), "中点坐标必须是数字");
  // 中点的 y 应落在两端之间
  assert.ok(linkA.labelY >= Math.min(linkA.y1, linkA.y2) && linkA.labelY <= Math.max(linkA.y1, linkA.y2));
  const linkB = layout.links.find((l) => l.toId === "b");
  assert.equal(linkB.label, undefined, "没有文字的连线不带 label");
});

/* ------------------------------------------------------------------ *
 * 多主题
 *
 * 设计：multiTheme 为真时，doc.root 退化成**不渲染的容器**，
 * 它的 children 才是画布上并列的主题。这样所有树操作（增删改、缩进、
 * 撤销、复制）都不用改——它们本来就以"单根"为前提。
 * ------------------------------------------------------------------ */

test("单主题文档升级为多主题：原主题变成第一个", () => {
  const doc = createDoc("测试", "主题一");
  assert.equal(doc.multiTheme, undefined, "默认是单主题");

  const result = addTheme(doc.root, false, "主题二");
  assert.equal(result.root.children.length, 2);
  assert.deepEqual(result.root.children.map((c) => c.text), ["主题一", "主题二"]);
  assert.equal(result.root.text, "", "容器根不该有文字（它不渲染）");
});

test("已经是多主题时，再加主题是追加而不是再套一层", () => {
  const doc = createDoc("测试", "主题一");
  const once = addTheme(doc.root, false, "主题二");
  const twice = addTheme(once.root, true, "主题三");
  assert.equal(twice.root.children.length, 3);
  assert.deepEqual(twice.root.children.map((c) => c.text), ["主题一", "主题二", "主题三"]);
  // 容器只有一层：根自己就是容器（无文字），子节点全是主题、没有嵌套的空容器
  assert.equal(twice.root.text, "", "容器根不该有文字");
  assert.equal(
    twice.root.children.filter((c) => c.text === "").length,
    0,
    "不能再套一层空容器",
  );
});

test("themesOf 在单/多主题下的行为", () => {
  const doc = createDoc("测试", "主题一");
  assert.deepEqual(themesOf(doc.root, false), [], "单主题没有独立主题列表");
  const multi = addTheme(doc.root, false, "主题二");
  assert.equal(themesOf(multi.root, true).length, 2);
});

test("只剩一个主题时可以降回单主题", () => {
  const root = { id: "c", text: "", children: [{ id: "t", text: "唯一主题", children: [] }] };
  const single = collapseToSingleTheme(root, true);
  assert.equal(single.id, "t", "降级后根就是那个主题");
  assert.equal(collapseToSingleTheme(root, false), undefined, "本来就不是多主题");
  const two = { id: "c", text: "", children: [{ id: "a", text: "A", children: [] }, { id: "b", text: "B", children: [] }] };
  assert.equal(collapseToSingleTheme(two, true), undefined, "两个主题不能降级");
});

test("normalizeDoc 保留 multiTheme 并清掉容器文字", () => {
  const doc = normalizeDoc({
    id: "d",
    title: "多主题",
    multiTheme: true,
    root: { id: "c", text: "不该出现的容器文字", children: [{ id: "t", text: "主题", children: [] }] },
  });
  assert.equal(doc.multiTheme, true);
  assert.equal(doc.root.text, "", "容器文字必须清掉，否则会混进 Markdown 导出");
});

test("老文档（没有 multiTheme）保持单主题不变", () => {
  const doc = normalizeDoc({ id: "d", title: "老文档", root: { id: "r", text: "中心主题", children: [] } });
  assert.equal(doc.multiTheme, undefined);
  assert.equal(doc.root.text, "中心主题");
});

test("森林布局：多个主题纵向排开、互不重叠、左对齐", () => {
  const themes = [
    { id: "t1", text: "主题一", children: [{ id: "t1a", text: "子", children: [] }] },
    { id: "t2", text: "主题二", children: [] },
    { id: "t3", text: "主题三", children: [] },
  ];
  const layout = layoutForest(themes);
  const boxes = ["t1", "t2", "t3"].map((id) => layout.nodes.find((n) => n.id === id));
  assert.ok(boxes.every((b) => b !== undefined));
  assert.equal(new Set(boxes.map((b) => b.x)).size, 1, "所有主题左对齐");
  for (let i = 1; i < boxes.length; i += 1) {
    assert.ok(
      boxes[i].y > boxes[i - 1].y + boxes[i - 1].height,
      `主题 ${i} 不能压在前一个主题上`,
    );
  }
  // 容器不在布局里（它不渲染）
  assert.equal(layout.nodes.some((n) => n.id === "c"), false);
});

test("森林布局：宽度取最宽的主题", () => {
  const narrow = layoutForest([{ id: "a", text: "短", children: [] }]);
  const wide = layoutForest([
    { id: "b", text: "短", children: [] },
    { id: "c", text: "很长很长的主题名字", children: [] },
  ]);
  assert.ok(wide.width > narrow.width, "有长主题时整体更宽");
});

test("多主题导出 Markdown：每个主题各成一个 H1", () => {
  const themes = [
    { id: "t1", text: "主题一", children: [{ id: "a", text: "子", children: [] }] },
    { id: "t2", text: "主题二", children: [] },
  ];
  const md = toMarkdownForest(themes);
  assert.match(md, /^# 主题一$/m);
  assert.match(md, /^# 主题二$/m);
  assert.match(md, /^## 子$/m);
});

test("多主题带文档标题时，文档标题独占 H1，主题降为 H2", () => {
  const themes = [
    { id: "t1", text: "主题一", children: [] },
    { id: "t2", text: "主题二", children: [] },
  ];
  const md = toMarkdownForest(themes, { includeTitle: true, title: "文档" });
  assert.match(md, /^# 文档$/m);
  assert.match(md, /^## 主题一$/m, "主题应是 H2，不能和文档标题抢 H1");
  assert.match(md, /^## 主题二$/m);
});

/* ------------------------------------------------------------------ *
 * 替换图片
 *
 * 关键：原地替换，不能"删掉再加一张"——那样图片会跑到最后，
 * 用户只换了一张图，其它图顺序却变了。
 * ------------------------------------------------------------------ */

test("替换图片：原地换掉，顺序和说明都保留", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      {
        id: "a",
        text: "A",
        images: [
          { id: "i1", type: "image/png", name: "1.png", width: 10, height: 10 },
          { id: "i2", type: "image/jpeg", name: "2.jpg", width: 20, height: 20, caption: "说明" },
          { id: "i3", type: "image/gif", name: "3.gif", width: 30, height: 30 },
        ],
        children: [],
      },
    ],
  };
  const next = replaceImage(root, "a", "i2", { id: "new", type: "image/webp", width: 40, height: 40 });
  assert.ok(next);
  const images = next.children[0].images;
  assert.deepEqual(images.map((i) => i.id), ["i1", "new", "i3"], "位置不变，仍在中间");
  assert.equal(images[1].type, "image/webp");
  assert.equal(images[1].width, 40);
  assert.equal(images[1].caption, "说明", "说明是对这张图的描述，换图后仍应保留");
  assert.equal(root.children[0].images[1].id, "i2", "原树不被修改");
});

test("替换图片：不接受和同节点其它图片重复的 id", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      {
        id: "a",
        text: "A",
        images: [
          { id: "i1", type: "image/png", name: "1.png" },
          { id: "i2", type: "image/png", name: "2.png" },
        ],
        children: [],
      },
    ],
  };
  assert.equal(replaceImage(root, "a", "i1", { id: "i2", type: "image/png" }), undefined);
});

test("替换图片：节点或图片不存在时返回 undefined", () => {
  const root = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  assert.equal(replaceImage(root, "a", "nope", { id: "x", type: "image/png" }), undefined);
  assert.equal(replaceImage(root, "nope", "x", { id: "x", type: "image/png" }), undefined);
});

/* ------------------------------------------------------------------ *
 * 节点标识
 *
 * 存 key 而不是 emoji：emoji 随系统字体变化，key 是稳定的，
 * 换图标只改一处、历史数据不用迁移。
 * ------------------------------------------------------------------ */

test("切换标识：加、再加、去掉、清空", () => {
  const root = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  const one = toggleMark(root, "a", "star");
  assert.deepEqual(one.children[0].marks, ["star"]);

  const two = toggleMark(one, "a", "fire");
  assert.deepEqual(two.children[0].marks, ["star", "fire"]);

  const removed = toggleMark(two, "a", "star");
  assert.deepEqual(removed.children[0].marks, ["fire"]);

  const cleared = toggleMark(removed, "a", "fire");
  assert.equal(cleared.children[0].marks, undefined, "全部去掉后字段应删除，不留空数组");
});

test("标识上限：最多 4 个", () => {
  let root = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  for (const key of ["star", "fire", "warn", "ask"]) {
    root = toggleMark(root, "a", key);
  }
  assert.equal(root.children[0].marks.length, MAX_MARKS);
  const overflow = toggleMark(root, "a", "idea");
  assert.equal(overflow.children[0].marks.length, MAX_MARKS, "满了不能再加");
  assert.equal(overflow.children[0].marks.includes("idea"), false);
});

test("未知标识被忽略（手改 JSON 不该塞进乱七八糟的 key）", () => {
  const doc = normalizeDoc({
    title: "x",
    root: { text: "根", children: [{ text: "A", marks: ["star", "bogus", "star", 42, null] }] },
  });
  assert.deepEqual(doc.root.children[0].marks, ["star"], "去重 + 丢掉未知值");
});

test("标识会被复制（clone / 复制子树）", () => {
  const root = {
    id: "r",
    text: "根",
    children: [{ id: "a", text: "A", marks: ["star"], children: [{ id: "a1", text: "A1", children: [] }] }],
  };
  assert.deepEqual(cloneNode(root).children[0].marks, ["star"]);
  const dup = duplicateNode(root, "a", () => "n");
  assert.deepEqual(dup.root.children[1].marks, ["star"], "复制出来的节点也要带标识");
});

test("标识会让节点变宽（否则图标会压到文字上）", () => {
  const plain = { id: "a", text: "重点内容", children: [] };
  const marked = { id: "b", text: "重点内容", marks: ["star", "fire"], children: [] };
  const plainSize = contentSize(plain, 1);
  const markedSize = contentSize(marked, 1);
  assert.ok(markedSize.width > plainSize.width, `${plainSize.width} → ${markedSize.width}`);
  assert.equal(markedSize.height, plainSize.height, "标识是并排的，不该改变高度");
});

test("布局把标识 key 解析成 emoji 给渲染层", () => {
  const layout = layoutTree({
    id: "r",
    text: "根",
    children: [{ id: "a", text: "A", marks: ["star", "fire"], children: [] }],
  });
  assert.deepEqual(layout.nodes.find((n) => n.id === "a").marks, ["⭐", "🔥"]);
  assert.equal(layout.nodes.find((n) => n.id === "r").marks, undefined, "没有标识就没有该字段");
});

/* ------------------------------------------------------------------ *
 * 主题按坐标创建（双击空白处）
 * ------------------------------------------------------------------ */

test("带坐标新建的主题会钉在那个位置", () => {
  const doc = createDoc("测试", "主题一");
  const result = addTheme(doc.root, false, "点出来的", { x: 600, y: 400 });
  const pinned = result.root.children.find((c) => c.id === result.themeId);
  assert.deepEqual(pinned.position, { x: 600, y: 400 });
  // 原主题不受影响
  assert.equal(result.root.children[0].position, undefined);
});

test("钉住的主题不参与纵向堆叠，也不推动其它主题", () => {
  const auto = layoutForest([
    { id: "t1", text: "自动一", children: [] },
    { id: "t2", text: "自动二", children: [] },
  ]);
  const withPinned = layoutForest([
    { id: "t1", text: "自动一", children: [] },
    { id: "t2", text: "自动二", children: [] },
    { id: "p", text: "钉住", position: { x: 600, y: 400 }, children: [] },
  ]);
  const posOf = (layout, id) => {
    const node = layout.nodes.find((n) => n.id === id);
    return { x: node.x, y: node.y };
  };
  // 自动主题的位置完全不受"多了一个钉住的主题"影响
  assert.deepEqual(posOf(withPinned, "t1"), posOf(auto, "t1"));
  assert.deepEqual(posOf(withPinned, "t2"), posOf(auto, "t2"));
  // 钉住的就在自己坐标上
  assert.deepEqual(posOf(withPinned, "p"), { x: 600, y: 400 });
});

test("画布尺寸要覆盖钉在远处的主题（否则会被裁在可视区外）", () => {
  const layout = layoutForest([
    { id: "t1", text: "自动", children: [] },
    { id: "p", text: "钉住", position: { x: 900, y: 700 }, children: [] },
  ]);
  assert.ok(layout.width > 900, `宽度 ${layout.width} 必须覆盖 x=900`);
  assert.ok(layout.height > 700, `高度 ${layout.height} 必须覆盖 y=700`);
});

/* ------------------------------------------------------------------ *
 * 删除连线：子节点升格为自由主题
 * ------------------------------------------------------------------ */

test("删边：子节点连同子树升格成自由主题", () => {
  const root = {
    id: "r",
    text: "中心",
    children: [
      { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
      { id: "b", text: "B", children: [] },
    ],
  };
  const result = detachToTheme(root, false, "a");
  assert.ok(result);
  assert.equal(result.multiTheme, true, "单主题必须升成多主题，否则没有地方放自由主题");
  assert.deepEqual(
    result.root.children.map((c) => c.text),
    ["中心", "A"],
    "A 变成和原主题并列的自由主题",
  );
  // 内容一点不丢
  const detached = result.root.children.find((c) => c.id === "a");
  assert.equal(detached.children[0].id, "a1", "子树跟着走");
  assert.equal(result.root.children[0].children.length, 1, "原主题只剩 B");
});

test("删边：多主题文档里从某个主题摘下子节点", () => {
  const root = {
    id: "c",
    text: "",
    children: [
      { id: "t1", text: "主题一", children: [{ id: "x", text: "X", children: [] }] },
      { id: "t2", text: "主题二", children: [] },
    ],
  };
  const result = detachToTheme(root, true, "x");
  assert.ok(result);
  assert.deepEqual(result.root.children.map((c) => c.text), ["主题一", "主题二", "X"]);
});

test("删边：根节点和主题本身没有上级连线，不能删", () => {
  const single = { id: "r", text: "中心", children: [{ id: "a", text: "A", children: [] }] };
  assert.equal(detachToTheme(single, false, "r"), undefined, "根节点");
  const multi = {
    id: "c",
    text: "",
    children: [{ id: "t1", text: "主题一", children: [] }],
  };
  assert.equal(detachToTheme(multi, true, "t1"), undefined, "主题是容器的一级子节点，没有连线");
  assert.equal(detachToTheme(single, false, "nope"), undefined, "节点不存在");
});

test("删边：升格后去掉手动坐标（否则会和原主题叠在一起）", () => {
  const root = {
    id: "r",
    text: "中心",
    children: [{ id: "a", text: "A", position: { x: 500, y: 500 }, children: [] }],
  };
  const result = detachToTheme(root, false, "a");
  assert.ok(result);
  assert.equal(result.root.children[1].position, undefined);
});

test("删边不修改原树", () => {
  const root = { id: "r", text: "中心", children: [{ id: "a", text: "A", children: [] }] };
  const snapshot = JSON.stringify(root);
  detachToTheme(root, false, "a");
  assert.equal(JSON.stringify(root), snapshot);
});

/* ------------------------------------------------------------------ *
 * 自由连线（关系线）
 * ------------------------------------------------------------------ */

test("自由连线：增删改与去重", () => {
  const links = addLink(undefined, "a", "b");
  assert.equal(links.length, 1);
  assert.equal(addLink(links, "b", "a"), undefined, "同一对节点不能连两次（方向无关）");
  assert.equal(addLink(links, "a", "a"), undefined, "不能连自己");

  const labeled = setLinkLabel(links, links[0].id, "  有关系  ");
  assert.equal(labeled[0].label, "有关系");
  assert.equal(setLinkLabel(labeled, labeled[0].id, "").length, 1, "清空文字但连线还在");
  assert.equal(setLinkLabel(labeled, labeled[0].id, "")[0].label, undefined);

  assert.equal(removeLink(links, links[0].id), undefined, "删光返回 undefined");
  assert.equal(removeLink(links, "nope"), undefined);
});

test("自由连线：端点不存在的会被丢掉（节点删了线不能悬空）", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", children: [] },
      { id: "b", text: "B", children: [] },
    ],
  };
  const doc = normalizeDoc({
    title: "x",
    root,
    links: [
      { from: "a", to: "b" },
      { from: "a", to: "gone" },
      { from: "a", to: "a" },
    ],
  });
  assert.equal(doc.links.length, 1);
  assert.equal(doc.links[0].to, "b");
});

test("自由连线：删节点后 pruneLinks 清掉悬空的", () => {
  const root = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  const links = [
    { id: "l1", from: "a", to: "b" },
    { id: "l2", from: "a", to: "r" },
  ];
  const next = pruneLinks(links, root);
  assert.equal(next.length, 1);
  assert.equal(next[0].id, "l2");
});

test("自由连线不影响树结构", () => {
  const root = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  const before = JSON.stringify(root);
  addLink(undefined, "a", "r");
  assert.equal(JSON.stringify(root), before);
});

/* ------------------------------------------------------------------ *
 * 改接线的另一端
 * ------------------------------------------------------------------ */

test("拖连线尾端：1->2 拖到 3 变成 1->3，2 升格成自由主题", () => {
  const root = {
    id: "r",
    text: "中心",
    children: [
      { id: "n1", text: "1", children: [{ id: "n2", text: "2", children: [] }] },
      { id: "n3", text: "3", children: [] },
    ],
  };
  const result = repointEdge(root, false, "n2", "n3", { x: 300, y: 100 });
  assert.ok(result);
  const find = (node, id) => (node.id === id ? node : node.children.reduce((a, c) => a ?? find(c, id), undefined));
  assert.deepEqual(find(result.root, "n1").children.map((c) => c.id), ["n3"], "1 现在连的是 3");
  assert.equal(find(result.root, "n2").position.y, 100, "2 原地变成自由主题");
});

test("拖连线尾端：拒绝连自己和连到父级本身", () => {
  const root = {
    id: "r",
    text: "中心",
    children: [{ id: "n1", text: "1", children: [{ id: "n2", text: "2", children: [] }] }],
  };
  assert.equal(repointEdge(root, false, "n1", "n1"), undefined, "不能连自己");
  // n2 的父级就是 n1，把 n2 的线改接到 n1 = 自己挂自己
  assert.equal(repointEdge(root, false, "n2", "n1"), undefined);

  /*
   * 反过来是**合法**的：把 1 的线改接到它的子节点 2 上。
   * 结果是 2 移到根下面、1 升格成自由主题，并不构成环——
   * 因为改接的语义是"这条线现在指向 2"，不是"把 2 挂到 1 里面"。
   */
  const ok = repointEdge(root, false, "n1", "n2");
  assert.ok(ok, "改接到自己的子节点是合法的");
});

test("删边后节点保持原位（不会跳到别处）", () => {
  const root = {
    id: "r",
    text: "中心",
    children: [{ id: "a", text: "A", children: [] }],
  };
  const result = detachToTheme(root, false, "a", { x: 640, y: 220 });
  const detached = result.root.children.find((c) => c.id === "a");
  assert.deepEqual(detached.position, { x: 640, y: 220 });
});

/* ------------------------------------------------------------------ *
 * 断开连线：节点留在原位，不变主题
 * ------------------------------------------------------------------ */

test("断开连线：节点仍在原父级下，层级和子树不变", () => {
  const root = {
    id: "r",
    text: "中心",
    children: [
      { id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] },
      { id: "b", text: "B", children: [] },
    ],
  };
  const next = disconnectNode(root, "a");
  assert.ok(next);
  const a = next.children[0];
  assert.equal(a.id, "a", "还在原来的位置（第 0 个孩子）");
  assert.equal(a.detached, true, "标记为已断开");
  // 不钉手动坐标：结构没变，自动布局算出来就是原位
  assert.equal(a.position, undefined, "不应该被钉上手动坐标");
  assert.equal(a.children.length, 1, "子树不动");
  assert.equal(next.children.length, 2, "没有多出一个顶层主题");
});

test("断开连线后布局不再画那条线，但节点仍参与布局", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", detached: true, position: { x: 300, y: 200 }, children: [] },
      { id: "b", text: "B", children: [] },
    ],
  };
  const layout = layoutTree(root);
  assert.equal(layout.links.some((l) => l.toId === "a"), false, "断开的线不画");
  assert.equal(layout.links.some((l) => l.toId === "b"), true, "其它线照常");
  assert.equal(layout.nodes.find((n) => n.id === "a").x, 300, "节点仍在手动坐标上");
});

test("断开连线：根节点和已断开的节点不能再断", () => {
  const root = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  assert.equal(disconnectNode(root, "r"), undefined, "根节点没有上级");
  assert.equal(disconnectNode(root, "nope"), undefined);
});

/* ------------------------------------------------------------------ *
 * 节点种类：主题 / 子节点
 * ------------------------------------------------------------------ */

test("种类：按结构推断（顶层 = 主题）", () => {
  const top = { id: "a", text: "A", children: [] };
  assert.equal(isThemeNode(top, 0), true, "顶层默认是主题");
  assert.equal(isThemeNode(top, 1), false, "深层默认是子节点");
  assert.equal(isThemeNode({ ...top, kind: "theme" }, 3), true, "显式 kind 优先");
  assert.equal(isThemeNode({ ...top, kind: "node" }, 0), false);
});

test("种类：子节点升成主题（单主题文档会升级成多主题）", () => {
  const root = {
    id: "r",
    text: "中心",
    children: [{ id: "a", text: "A", children: [{ id: "a1", text: "A1", children: [] }] }],
  };
  const result = setNodeKind(root, "a", "theme", false, { x: 500, y: 300 });
  assert.ok(result);
  assert.equal(result.multiTheme, true, "必须升成多主题，否则没有顶层并列");
  assert.deepEqual(result.root.children.map((c) => c.id), ["r", "a"], "A 挂到顶层");
  const a = result.root.children.find((c) => c.id === "a");
  assert.equal(a.kind, "theme");
  assert.deepEqual(a.position, { x: 500, y: 300 }, "保留位置");
  assert.equal(a.children.length, 1, "子树跟着走");
});

test("种类：主题降成子节点（变成游离，但不丢）", () => {
  const root = {
    id: "c",
    text: "",
    children: [{ id: "t1", text: "主题一", children: [] }],
  };
  const result = setNodeKind(root, "t1", "node", true, { x: 40, y: 60 });
  assert.ok(result);
  const t1 = result.root.children.find((c) => c.id === "t1");
  assert.equal(t1.kind, "node");
  assert.equal(t1.detached, true, "顶层节点没有父级连线，降级后表现为游离");
  assert.deepEqual(t1.position, { x: 40, y: 60 });
});

/* ------------------------------------------------------------------ *
 * 自动排版：避让重叠 + 按用户顺序
 * ------------------------------------------------------------------ */

test("排版避让：两个手动节点叠在一起会被推开", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "AAA", position: { x: 200, y: 100 }, children: [] },
      { id: "b", text: "BBB", position: { x: 200, y: 110 }, children: [] },
    ],
  };
  const layout = layoutTree(root);
  const a = layout.nodes.find((n) => n.id === "a");
  const b = layout.nodes.find((n) => n.id === "b");
  assert.ok(b.y >= a.y + a.height, "下面的节点被推到不重叠");
});

test("排版避让：推开时整棵子树跟着走", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "AAA", position: { x: 200, y: 100 }, children: [] },
      {
        id: "b",
        text: "BBB",
        position: { x: 200, y: 110 },
        children: [{ id: "b1", text: "B1", position: { x: 400, y: 110 }, children: [] }],
      },
    ],
  };
  const layout = layoutTree(root);
  const b = layout.nodes.find((n) => n.id === "b");
  const b1 = layout.nodes.find((n) => n.id === "b1");
  assert.equal(b1.y - b.y, 0, "子节点和父节点保持相对位置");
});

test("排版顺序：按节点的上下位置重排兄弟，而不是输入顺序", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", position: { x: 0, y: 300 }, children: [] },
      { id: "b", text: "B", position: { x: 0, y: 100 }, children: [] },
      { id: "c", text: "C", position: { x: 0, y: 200 }, children: [] },
    ],
  };
  const next = sortSiblingsByPosition(root);
  assert.ok(next);
  assert.deepEqual(next.children.map((c) => c.id), ["b", "c", "a"]);
  assert.deepEqual(root.children.map((c) => c.id), ["a", "b", "c"], "不改原树");
});

test("排版顺序：顺序没变时不产生新树（不制造无意义撤销步）", () => {
  const root = {
    id: "r",
    text: "根",
    children: [
      { id: "a", text: "A", position: { x: 0, y: 100 }, children: [] },
      { id: "b", text: "B", position: { x: 0, y: 200 }, children: [] },
    ],
  };
  assert.equal(sortSiblingsByPosition(root), undefined);
});

test("kind 与结构保持一致：顶层是主题，子级是节点", () => {
  const multi = normalizeDoc({
    title: "x",
    multiTheme: true,
    root: {
      text: "",
      children: [
        { id: "a", text: "密炼法", kind: "node", children: [{ id: "b", text: "特点", kind: "theme", children: [] }] },
      ],
    },
  });
  assert.equal(multi.root.children[0].kind, "theme", "顶层按结构就是主题");
  assert.equal(multi.root.children[0].children[0].kind, "node", "子级按结构就是节点");
});

test("接回树里会清掉主题标记（否则 Markdown 标题级别错乱）", () => {
  const root = {
    id: "c",
    text: "",
    children: [
      { id: "t1", text: "主题一", children: [{ id: "t2", text: "主题二", children: [] }] },
    ],
  };
  // 把 t2 从 t1 下挪到容器根（变成主题），再挪回 t1 下面
  const promoted = reparentNode(root, "t2", "c");
  assert.ok(promoted);
  const back = reparentNode(promoted, "t2", "t1");
  assert.ok(back);
  const t2 = back.children[0].children[0];
  assert.equal(t2.kind, undefined, "kind 被清掉，交给结构推断");
  assert.equal(t2.detached, undefined, "detached 也清掉");
});
