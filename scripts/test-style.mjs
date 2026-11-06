/**
 * 节点样式单测：`node --test scripts/test-style.mjs`
 *
 * 重点不是"能不能设颜色"，而是：
 *   ① 非法值必须被丢弃（手改 JSON 不该撑爆布局）；
 *   ② 字号必须影响布局（否则大字号的字会溢出方框）；
 *   ③ 色板每一组都得有足够的对比度（这是不用自由取色的理由）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PALETTE,
  FONT_SIZES,
  RADII,
  BORDER_WIDTHS,
  paletteOf,
  normalizeStyle,
  isDefaultStyle,
  effectiveFontSize,
  effectiveBold,
  effectiveStyle,
  applyStyle,
  DEFAULT_RADIUS,
  DEFAULT_BORDER_WIDTH,
  hasCustomStyle,
} from "../src/core/style.ts";
import { CSS } from "../src/client/styles.ts";
import { normalizeNode, cloneNode, locate } from "../src/core/tree.ts";
import { contentSize } from "../src/core/layout.ts";

/* ---------------- 色板 ---------------- */

/** WCAG 相对亮度。 */
function luminance(hex) {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** 对比度。 */
function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

test("色板每一组都有足够对比度（≥ 4.5:1）", () => {
  for (const entry of PALETTE) {
    if (entry.key === "default") continue;
    const ratio = contrast(entry.background, entry.foreground);
    assert.ok(
      ratio >= 4.5,
      `${entry.label}(${entry.key}) 对比度只有 ${ratio.toFixed(2)}，文字会看不清`,
    );
  }
});

test("色板 key 不重复，default 是唯一跟随主题的", () => {
  const keys = PALETTE.map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length, "key 必须唯一");
  const defaults = PALETTE.filter((entry) => entry.background === "");
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].key, "default");
});

test("paletteOf 查得到 / 查不到", () => {
  assert.equal(paletteOf("blue").key, "blue");
  assert.equal(paletteOf("default"), undefined);
  assert.equal(paletteOf("不存在"), undefined);
  assert.equal(paletteOf(undefined), undefined);
});

/* ---------------- 校验 ---------------- */

test("normalizeStyle 只接受预设档位", () => {
  assert.deepEqual(normalizeStyle({ color: "blue", fontSize: 16, bold: true }), {
    color: "blue",
    fontSize: 16,
    bold: true,
  });

  // 非法值全部丢弃
  assert.equal(
    normalizeStyle({ color: "shiny", fontSize: 999, radius: 77, borderWidth: 42 }),
    undefined,
    "全部非法时应返回 undefined",
  );
});

/*
 * v0.13.1 起 bold/italic 允许显式 false。
 *
 * 只存 true 的话"取消根节点的加粗"没法表达：根节点默认加粗，
 * 面板上点 B 只能存 true 或什么都不存，两种都还是加粗。
 */
test("normalizeStyle 保留显式 false（用于取消根节点的默认加粗）", () => {
  assert.deepEqual(normalizeStyle({ bold: true, italic: false }), { bold: true, italic: false });
  assert.deepEqual(normalizeStyle({ bold: false }), { bold: false });
  // 非布尔值仍然丢弃；一个有效字段都不剩时整个样式为 undefined
  assert.equal(normalizeStyle({ bold: "yes", italic: 1 }), undefined);
});

test("normalizeStyle 对非对象输入返回 undefined", () => {
  for (const input of [null, undefined, 42, "blue", []]) {
    assert.equal(normalizeStyle(input), undefined);
  }
});

test("isDefaultStyle 判定", () => {
  assert.equal(isDefaultStyle(undefined), true);
  assert.equal(isDefaultStyle({}), true);
  assert.equal(isDefaultStyle({ color: "default" }), true);
  assert.equal(isDefaultStyle({ color: "blue" }), false);
  assert.equal(isDefaultStyle({ fontSize: 16 }), false);
});

test("normalizeNode 保留合法样式、丢弃非法样式", () => {
  const good = normalizeNode({ id: "n", text: "节点", style: { color: "teal", fontSize: 13 }, children: [] });
  assert.deepEqual(good.style, { color: "teal", fontSize: 13 });

  const bad = normalizeNode({ id: "n", text: "节点", style: { fontSize: 500 }, children: [] });
  assert.equal(bad.style, undefined, "非法字号应被丢弃而不是撑爆布局");
});

test("cloneNode 深拷贝样式（改克隆不影响原树）", () => {
  const node = { id: "n", text: "节点", style: { color: "blue" }, children: [] };
  const copy = cloneNode(node);
  copy.style.color = "red";
  assert.equal(node.style.color, "blue");
});

/* ---------------- 生效值 ---------------- */

test("effectiveFontSize：自定义优先，否则按层级", () => {
  const plain = { id: "a", text: "x", children: [] };
  assert.equal(effectiveFontSize(plain, 0), 13.5, "根节点默认更大");
  assert.equal(effectiveFontSize(plain, 1), 13);

  const big = { id: "b", text: "x", style: { fontSize: 20 }, children: [] };
  assert.equal(effectiveFontSize(big, 0), 20, "自定义字号覆盖层级默认");
  assert.equal(effectiveFontSize(big, 3), 20);
});

test("effectiveBold：根节点默认加粗，可被显式覆盖", () => {
  const plain = { id: "a", text: "x", children: [] };
  assert.equal(effectiveBold(plain, 0), true);
  assert.equal(effectiveBold(plain, 1), false);
  assert.equal(effectiveBold({ id: "c", text: "x", style: { bold: true }, children: [] }, 2), true);
});

test("hasCustomStyle 递归检测", () => {
  assert.equal(hasCustomStyle({ id: "r", text: "x", children: [] }), false);
  assert.equal(
    hasCustomStyle({
      id: "r",
      text: "x",
      children: [{ id: "c", text: "y", style: { color: "blue" }, children: [] }],
    }),
    true,
  );
});

/* ---------------- 布局响应 ---------------- */

test("字号越大，节点越高（文字不会溢出方框）", () => {
  const base = { id: "a", text: "测试文字", children: [] };
  const sizes = FONT_SIZES.map((size) =>
    contentSize({ id: "n" + size, text: "测试文字", style: { fontSize: size }, children: [] }, 1),
  );
  for (let i = 1; i < sizes.length; i += 1) {
    assert.ok(
      sizes[i].height >= sizes[i - 1].height,
      `字号 ${FONT_SIZES[i]} 的高度(${sizes[i].height}) 不应小于 ${FONT_SIZES[i - 1]}(${sizes[i - 1].height})`,
    );
  }
  assert.ok(sizes[sizes.length - 1].height > sizes[0].height, "20px 应明显高于 11px");
});

test("字号越大，节点越宽（长文字同理）", () => {
  const small = contentSize({ id: "s", text: "一段比较长的节点文字", style: { fontSize: 11 }, children: [] }, 1);
  const large = contentSize({ id: "l", text: "一段比较长的节点文字", style: { fontSize: 20 }, children: [] }, 1);
  assert.ok(large.width > small.width, `大字号应更宽：${small.width} vs ${large.width}`);
});

test("加粗让文字更宽（估算路径）", () => {
  const normal = contentSize({ id: "n", text: "加粗对比测试文字", children: [] }, 1);
  const bold = contentSize({ id: "b", text: "加粗对比测试文字", style: { bold: true }, children: [] }, 1);
  assert.ok(bold.width >= normal.width, `加粗不该比常规更窄：${normal.width} vs ${bold.width}`);
});

test("所有预设档位都是正整数/零，不会产生负数尺寸", () => {
  for (const size of FONT_SIZES) assert.ok(size > 0);
  for (const radius of RADII) assert.ok(radius >= 0);
  for (const width of BORDER_WIDTHS) assert.ok(width >= 0);
});

/* ---- 显式 false 必须能取消根节点的默认加粗 ---- */

test("applyStyle 的 false 是取值，不是清除", () => {
  const root = { id: "r", text: "根", children: [{ id: "a", text: "A", children: [] }] };
  const unBold = applyStyle(root, "r", { bold: false }, cloneNode, locate);
  assert.deepEqual(unBold.style, { bold: false }, "false 必须存下来，否则根节点永远取消不掉加粗");
  assert.equal(effectiveStyle(unBold, 0).bold, false);

  // null 仍然是"清除"
  const back = applyStyle(unBold, "r", { bold: null }, cloneNode, locate);
  assert.equal(back.style, undefined, "清除后整个样式为空");
  assert.equal(effectiveStyle(back, 0).bold, true, "回到默认（根加粗）");
});

test("effectiveStyle 给出的是画布上实际生效的值", () => {
  const plain = { id: "a", text: "A", children: [] };
  assert.deepEqual(effectiveStyle(plain, 1), {
    color: "default",
    fontSize: 13,
    bold: false,
    italic: false,
    radius: DEFAULT_RADIUS,
    borderWidth: DEFAULT_BORDER_WIDTH,
  });
  // 根节点默认更大更粗
  const asRoot = effectiveStyle(plain, 0);
  assert.equal(asRoot.fontSize, 13.5);
  assert.equal(asRoot.bold, true);

  // 显式设置优先
  const styled = { id: "b", text: "B", style: { bold: false, fontSize: 20, radius: 0 }, children: [] };
  const eff = effectiveStyle(styled, 0);
  assert.equal(eff.bold, false, "显式 false 覆盖根的默认加粗");
  assert.equal(eff.fontSize, 20);
  assert.equal(eff.radius, 0);
});

test("面板默认值和 CSS 里的 .mm-node 规则一致", () => {
  // 面板显示"当前 6 px 圆角"，画布上也必须真的是 6px，否则用户看到的和画出来的不一致
  assert.match(CSS, new RegExp("border-radius:\\s*" + String(DEFAULT_RADIUS) + "px"));
  assert.match(CSS, new RegExp("border:\\s*" + String(DEFAULT_BORDER_WIDTH) + "px"));
});
