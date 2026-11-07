/**
 * 一致性门禁：构建产物与合同冲突时立即失败。
 *
 * 用法：npm run gates
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const failures = [];
const passes = [];

function check(name, condition, detail = "") {
  if (condition) passes.push(name);
  else failures.push(name + (detail ? " —— " + detail : ""));
}

const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const name = pkg.name;
const patch = await readFile(resolve(root, "cordis.patch.yml"), "utf8");
const hostBundle = await readFile(resolve(root, "lib/index.js"), "utf8");
const clientBundle = await readFile(resolve(root, "lib/client.js"), "utf8");
const clientSrc = await readFile(resolve(root, "src/client/index.tsx"), "utf8");
const storeSrc = await readFile(resolve(root, "src/client/store.ts"), "utf8");
const canvasSrc = await readFile(resolve(root, "src/client/Canvas.tsx"), "utf8");
const stylesSrc = await readFile(resolve(root, "src/client/styles.ts"), "utf8");

// ── 1. package.json 合同 ──────────────────────────────────
check("package.json: type=module", pkg.type === "module");
check("package.json: main=lib/index.js", pkg.main === "lib/index.js");
check("package.json: exports['.']", pkg.exports?.["."] === "./lib/index.js");
check("package.json: exports['./package.json']", pkg.exports?.["./package.json"] === "./package.json");
check("package.json: exports['./client']", pkg.exports?.["./client"] === "./lib/client.js");
check(
  "package.json: exports['./cordis.patch.yml']",
  pkg.exports?.["./cordis.patch.yml"] === "./cordis.patch.yml",
);
check("package.json: dsh.bundle.patch", pkg.dsh?.bundle?.patch === "./cordis.patch.yml");
check("package.json: dsh.client.platform=web", pkg.dsh?.client?.platform === "web");
check(
  "package.json: dsh.client.inject 含 ui-layout",
  Array.isArray(pkg.dsh?.client?.inject) &&
    pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-layout"),
);
check(
  "package.json: files 覆盖产物",
  ["lib/index.js", "lib/client.js", "cordis.patch.yml"].every((file) => (pkg.files ?? []).includes(file)),
);
check("package.json: name=dsh-mindmap", name === "dsh-mindmap");

// ── 2. 禁止声明 @deepseek-ai/* 依赖 ───────────────────────
const declared = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];
// ── CSS 注释里不能出现反引号 ─────────────────────────────
// 反引号会把 styles.ts 的模板字符串提前闭合，整个客户端包直接炸掉。
// 这个坑踩过四次了，加条门禁兜住。
{
  const css = await readFile(resolve(root, "src/client/styles.ts"), "utf8");
  // 只看模板字符串**内部**的行：文件头的 JSDoc 在字符串外面，有反引号也无害
  const startAt = css.indexOf("export const CSS = \`");
  const inner = startAt < 0 ? "" : css.slice(startAt);
  const bad = inner
    .split("\n")
    .map((line, no) => ({ line, no: no + 1 }))
    .filter(({ line }) => /^\s*(\*|\/\*)/.test(line) && line.includes("`"));
  check(
    "styles.ts: CSS 注释里没有反引号",
    bad.length === 0,
    bad.map(({ no, line }) => `第 ${no} 行 ${line.trim().slice(0, 50)}`).join(" | "),
  );
}

// ── 同一选择器不能有互相冲突的规则体 ─────────────────────
// 恢复 CSS 时留下过两份 .mm-free-link，后一份把线型钉成虚线，
// 结果"改样式没反应"。冲突的重复规则是这类 bug 的温床。
{
  const css = await readFile(resolve(root, "src/client/styles.ts"), "utf8");
  // 去掉 (?m) 内联标志：JS 用 m 标志代替
  const ruleRe = new RegExp("^([^\\s/@][^{]*?)\\s*\\{([^{}]*)\\}", "gm");
  const rules = [...css.matchAll(ruleRe)].map((m) => ({
    sel: m[1].trim(),
    body: m[2],
    line: css.slice(0, m.index).split("\n").length,
  }));
  const bySel = new Map();
  for (const rule of rules) {
    if (!bySel.has(rule.sel)) bySel.set(rule.sel, []);
    bySel.get(rule.sel).push(rule);
  }
  const conflicts = [];
  for (const [sel, list] of bySel) {
    if (list.length < 2) continue;
    const props = new Map();
    for (const rule of list) {
      for (const decl of rule.body.split(";")) {
        const at = decl.indexOf(":");
        if (at < 0) continue;
        const key = decl.slice(0, at).trim();
        const value = decl.slice(at + 1).trim();
        if (key.length === 0 || value.length === 0) continue;
        if (props.has(key) && props.get(key).value !== value) {
          conflicts.push(`${sel} 的 ${key}: 行${props.get(key).line}="${props.get(key).value}" vs 行${rule.line}="${value}"`);
        } else if (!props.has(key)) {
          props.set(key, { value, line: rule.line });
        }
      }
    }
  }
  check(
    "styles.ts: 同一选择器没有互相冲突的重复规则",
    conflicts.length === 0,
    conflicts.slice(0, 3).join(" | "),
  );
}

check(
  "package.json: 无 @deepseek-ai/* 依赖",
  declared.every((dep) => !dep.startsWith("@deepseek-ai/")),
  declared.join(", "),
);

// ── 3. 名称一致性铁律 ────────────────────────────────────
check("patch 含 insert", /- insert:/.test(patch));
check("patch id=包名", new RegExp("id:\\s*" + name + "\\b").test(patch));
check("patch name=包名", new RegExp("name:\\s*['\"]?" + name + "['\"]?").test(patch));
check(
  "client ModuleLoader id=包名",
  new RegExp('__ModuleLoader__\\.load\\(\\{\\s*id:\\s*"' + name + '"').test(clientBundle),
  "lib/client.js 里没找到匹配的 ModuleLoader id",
);

// ── 4. Node 半区合同 ─────────────────────────────────────
check("host bundle 导出 apply", /export\s*\{[^}]*\bapply\b/.test(hostBundle) || /\bapply\b/.test(hostBundle));
check("host bundle 导出 inject", /inject/.test(hostBundle));
check("host bundle 含 RPC 通道路径", hostBundle.includes("/mindmap"));
check("host bundle 含 storage 文件名", hostBundle.includes("dsh-mindmap.json"));

// ── 5. Client 半区合同 ───────────────────────────────────
check("client bundle 导出 inject", /exports\.inject\s*=/.test(clientBundle) || /inject\s*:/.test(clientBundle));
check("client bundle 导出 apply", /exports\.apply\s*=/.test(clientBundle) || /apply\s*:/.test(clientBundle));
// 方案 B：导图只在右侧抽屉里，不再占主区域、也不在左侧边栏加入口
check("client src 注册了右侧抽屉 tab", clientSrc.includes('"sidebar.right.pane.tab"'));
check("client src 不再注册 main 插槽", !clientSrc.includes('slots.inject("main"'));
check("client src 不再注册左侧边栏", !clientSrc.includes('"sidebar.panellist"'));
check(
  "面板 id 与侧边栏图标 id 一致",
  /PANEL_ID\s*=\s*"mindmap"/.test(clientSrc),
  "PANEL_ID 必须是 main 的 key 且等于 sidebar.panellist 的 id",
);

// ── 5a. 模型工具层必须有自己的单测 ────────────────────────
// v0.34.0 的 applyOps 把 {root,id} 当成了树，一条 remove 洗掉 102 个节点。
// 画布交互一个都不经过工具层，浏览器冒烟永远测不到它，所以必须有单测。
check(
  "package.json: test 脚本包含 test-tools.mjs",
  String(pkg.scripts?.test ?? "").includes("test-tools.mjs"),
  "工具层（applyOps / treeFromMarkdown）必须有单测，否则改坏了没人发现",
);
check(
  "工具层测试文件存在",
  existsSync(resolve(root, "scripts/test-tools.mjs")),
);
// 结构类操作必须取 .root：insertChild/insertSibling/removeNode 返回的是包装对象
const toolsSrc = await readFile(resolve(root, "src/tools.ts"), "utf8");
check(
  "applyOps 对结构类操作取 .root（不再把包装对象当树）",
  /current = node;/.test(toolsSrc) && /asNode\(next\.root\)/.test(toolsSrc),
  "add/remove 的返回值是 { root, id }，必须取 .root 并校验是节点",
);

// ── 5b. 属性面板是显式开关（v0.34.0 用户要求） ────────────
// 用户要求：点节点、点连线**不再**自动弹属性面板，改用工具栏的「属性」按钮。
// 判据：select() 的函数体里不许出现 styleOpen。
const selectBody = (() => {
  const start = storeSrc.indexOf("    select(id) {");
  if (start < 0) return null;
  const end = storeSrc.indexOf("\n    },", start);
  return end < 0 ? null : storeSrc.slice(start, end);
})();
// 选中可以**收起**面板（点空白/Esc），但绝不能再**打开**它。
const selectOpensPanel =
  selectBody !== null &&
  /styleOpen\s*:\s*true|styleOpen\s*:\s*(id|ids|unique|next|result)\b|styleOpen\s*:\s*[a-z]+\.length/.test(
    selectBody,
  );
check(
  "store: 选中不再自动打开属性面板",
  selectBody !== null && !selectOpensPanel,
  "select() 里又自动打开了 styleOpen —— 面板必须只由「属性」按钮打开（取消选中时可以收起）",
);
check(
  "store: 有 toggleStyle 开关",
  /toggleStyle\(\)\s*{/.test(storeSrc) && storeSrc.includes("state.styleOpen"),
);
check(
  "工具栏有「属性」按钮",
  canvasSrc.includes('data-mm-action="style"') && canvasSrc.includes("store.toggleStyle()"),
);
check(
  "属性面板内容跟随选中（连线优先于节点）",
  clientSrc.includes('data-mm-side="edge-style"') && clientSrc.includes('data-mm-side="style"'),
);

// ── 5c. 连线端点手柄不画圆圈（v0.34.0 用户要求） ──────────
// 元素要留着（拖端点改接的唯一入口），但外观必须透明。
const handleRule = (() => {
  const i = stylesSrc.indexOf(".mm-edge-handle {");
  if (i < 0) return null;
  const j = stylesSrc.indexOf("}", i);
  return j < 0 ? null : stylesSrc.slice(i, j);
})();
check(
  "端点手柄透明（不再画线头线尾的圆圈）",
  handleRule !== null && handleRule.includes("fill: transparent") && !handleRule.includes("stroke: var("),
  "手柄必须保留元素、只去掉外观：fill 写 none 会连指针事件一起失效",
);

// ── 6. React 未被打进 client bundle ──────────────────────
// 平台通过 __ModuleLoader__ 注入 require，React 必须留在外部。
// 判据：bundle 里不应出现 React 内部实现的特征串。
const reactFingerprints = [
  "react.element", // React 内部 element 符号描述
  "Minified React error", // React production 报错前缀
  "react-dom.client", // 内部入口
];
const leaked = reactFingerprints.filter((token) => clientBundle.includes(token));
check("client bundle 未打包 React", leaked.length === 0, "泄漏特征：" + leaked.join(", "));
check(
  "client bundle 通过 require 取 react",
  /require\(\s*["']react["']\s*\)/.test(clientBundle) || clientBundle.includes('require("react")'),
);

// ── 7. 核心逻辑在两份产物里已内联 ────────────────────────
// 两个半区共用 src/core/*.ts，构建后各自内联一份。判据：产物里能看到
// 只有核心模块才会输出的特征字符串。
check("host bundle 内联了 Markdown 转换", hostBundle.includes("（空节点）"));
// client 半区不再内联 Markdown 导出（改由 host 负责），改判解析器特征
check("client bundle 内联了 Markdown 解析", clientBundle.includes("（空节点）") || clientBundle.includes("#"));
check("client bundle 内联了布局引擎", clientBundle.includes("mm-node") || clientBundle.includes("数据"));

// ── 结果 ─────────────────────────────────────────────────
for (const line of passes) console.log("  ok   " + line);
for (const line of failures) console.error("  FAIL " + line);

if (failures.length > 0) {
  console.error("\n门禁未通过：" + String(failures.length) + " 项失败， " + String(passes.length) + " 项通过");
  process.exit(1);
}
console.log("\n门禁通过：" + String(passes.length) + " 项全部 ok");
