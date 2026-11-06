/**
 * Host 存储层验收测试：`node --test scripts/test-store.mjs`
 *
 * 与 test-core.mjs 互补：那边测纯函数，这边测**落盘行为**——
 * 路径解析、读回、原子写、坏数据自愈、去重、时间戳、排序、CRUD、
 * 深拷贝隔离、容量上限、并发写。
 *
 * 安全约定（很重要）：
 *   - 每个 test 自己开一个 mkdtemp 临时目录并把 DSH_HOME 指过去；
 *   - 任何 openStore 调用前都先断言 storageFile() 落在临时目录里
 *     （openAt），所以即使某个 test 写错也不可能碰到 ~/.dsh；
 *   - "回落 ~/.dsh" 那条只断言路径字符串，不调用 openStore；
 *   - 文件末尾的 after() 再兜一次：测试前后真实存储文件的存在性必须一致。
 *
 * 每个用例串行执行（serial）：DSH_HOME 是进程级环境变量，
 * 串行能保证用例之间不会互相踩 env。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";

import { MAX_DOCS, openStore, storageFile } from "../src/store.ts";

/** 真实存储文件（只在断言里出现，绝不写入）。 */
const REAL_FILE = join(homedir(), ".dsh", "storages", "dsh-mindmap.json");
const REAL_FILE_EXISTED_AT_START = existsSync(REAL_FILE);

/* ------------------------------------------------------------------ *
 * 基础设施
 * ------------------------------------------------------------------ */

/** 串行门：让每个用例独占 DSH_HOME。 */
let queue = Promise.resolve();
function serial(body) {
  const run = queue.then(body, body);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 静默 logger（不让存储日志淹掉测试输出）。 */
function quietLogger() {
  return { info() {}, warn() {} };
}

/** 记录日志的 logger：用来断言"坏数据确实走了报警分支"。 */
function recordingLogger() {
  const logs = { info: [], warn: [] };
  return {
    logs,
    logger: {
      info: (...args) => logs.info.push(args),
      warn: (...args) => logs.warn.push(args),
    },
  };
}

/**
 * 开一个临时 home，把 DSH_HOME 指过去，并在用例结束后清理。
 * @returns {{ home: string, dir: string, file: string }}
 */
async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), "dsh-mindmap-store-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    // 先还原 env 再删目录：清理阶段不留下任何指向临时目录的状态
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    // 有的用例会故意把 storages 改成只读（simulate EACCES）；
    // 用例失败时可能来不及恢复，这里先放开权限再删，避免留下删不掉的临时目录。
    await chmod(join(home, "storages"), 0o700).catch(() => {});
    await rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(async () => {
      await chmod(home, 0o700).catch(() => {});
      await rm(home, { recursive: true, force: true, maxRetries: 3 });
    });
  });
  return {
    home,
    dir: join(home, "storages"),
    file: join(home, "storages", "dsh-mindmap.json"),
  };
}

/**
 * openStore 的安全包装：先确认 storageFile() 真的落在临时目录里，
 * 再调用 openStore —— 从结构上杜绝污染真实 ~/.dsh。
 */
async function openAt(home, logger = quietLogger()) {
  const resolved = storageFile();
  const expected = join(home, "storages", "dsh-mindmap.json");
  assert.equal(resolved, expected, `storageFile() 必须落在临时 home 里，实际是 ${resolved}`);
  return openStore(logger);
}

/** 直接往存储文件里塞内容（模拟历史数据 / 被手改的文件 / 坏文件）。 */
async function seed(home, value) {
  const file = join(home, "storages", "dsh-mindmap.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return file;
}

/** 读磁盘上的存储文件（断言落盘内容用）。 */
async function readStorage(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

/** 造 n 份形状合法、id 互异的文档（容量测试用，只写一次盘）。 */
function makeDocs(n, prefix = "seed") {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    title: `文档 ${i}`,
    root: { id: `root-${i}`, text: `根 ${i}`, children: [] },
    createdAt: 1_000 + i,
    updatedAt: 1_000 + i,
  }));
}

/** 目录里残留的临时文件（原子写的中间产物）。 */
async function tempLeftovers(dir) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((name) => name.includes(".tmp-"));
}

/** 目录里的 corrupt 备份文件。 */
async function corruptBackups(dir) {
  return (await readdir(dir)).filter((name) => /^dsh-mindmap\.json\.corrupt-\d+$/.test(name));
}

/* ------------------------------------------------------------------ *
 * 1. 路径解析
 * ------------------------------------------------------------------ */

test("storageFile() 跟随 DSH_HOME，落在 <home>/storages/dsh-mindmap.json", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    assert.equal(storageFile(), join(home, "storages", "dsh-mindmap.json"));

    // 每次调用都重新读 env：换一个 home 立刻跟随
    const other = await mkdtemp(join(tmpdir(), "dsh-mindmap-store-alt-"));
    t.after(() => rm(other, { recursive: true, force: true }));
    process.env.DSH_HOME = other;
    assert.equal(storageFile(), join(other, "storages", "dsh-mindmap.json"));

    process.env.DSH_HOME = home;
    assert.equal(storageFile(), join(home, "storages", "dsh-mindmap.json"));
  }));

test("未设置 DSH_HOME 时回落 ~/.dsh（只断言路径字符串，绝不落盘）", () =>
  serial(async () => {
    const saved = process.env.DSH_HOME;
    const existedBefore = existsSync(REAL_FILE);
    delete process.env.DSH_HOME;
    try {
      assert.equal(storageFile(), REAL_FILE);
      assert.equal(storageFile(), join(homedir(), ".dsh", "storages", "dsh-mindmap.json"));
      // storageFile() 必须是纯字符串计算：调用它不该产生任何文件系统副作用
      assert.equal(existsSync(REAL_FILE), existedBefore, "storageFile() 不应写任何文件");
    } finally {
      if (saved !== undefined) process.env.DSH_HOME = saved;
    }
  }));

test("DSH_HOME 为空白字符串时同样回落 ~/.dsh", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    for (const blank of ["", "   ", "\t\n"]) {
      process.env.DSH_HOME = blank;
      assert.equal(storageFile(), REAL_FILE, `「${JSON.stringify(blank)}」应视为未设置`);
    }
    process.env.DSH_HOME = home;
  }));

/* ------------------------------------------------------------------ *
 * 2. 打开 / 落盘 / 读回
 * ------------------------------------------------------------------ */

test("openStore 自动创建 storages 目录，但打开本身不写文件", (t) =>
  serial(async () => {
    const { home, dir, file } = await withHome(t);
    assert.equal(existsSync(dir), false, "初始状态：目录还不存在");

    const store = await openAt(home);
    assert.equal(existsSync(dir), true, "openStore 会递归创建目录");
    assert.equal(existsSync(file), false, "只读打开不该产生存储文件");
    assert.deepEqual(store.list(), []);
    assert.equal(store.file(), file);
  }));

test("create 落盘后重新 openStore 能读回标题与根节点文字", (t) =>
  serial(async () => {
    const { home, file } = await withHome(t);
    const store = await openAt(home);
    const created = await store.create("周会纪要", "周会");

    assert.equal(store.file(), file);
    assert.equal(existsSync(file), true);

    const reopened = await openAt(home);
    const list = reopened.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
    assert.equal(list[0].title, "周会纪要");
    assert.equal(list[0].nodeCount, 1);

    const doc = reopened.get(created.id);
    assert.ok(doc);
    assert.equal(doc.title, "周会纪要");
    assert.equal(doc.root.text, "周会");
    assert.equal(doc.root.id, created.root.id);
  }));

test("磁盘格式是 {version:1, docs:[...]}，且 docs 里是完整文档", (t) =>
  serial(async () => {
    const { home, file } = await withHome(t);
    const store = await openAt(home);
    const created = await store.create("格式检查", "根");
    const disk = await readStorage(file);
    assert.equal(disk.version, 1);
    assert.ok(Array.isArray(disk.docs));
    assert.equal(disk.docs.length, 1);
    assert.equal(disk.docs[0].id, created.id);
    assert.equal(disk.docs[0].title, "格式检查");
    assert.equal(disk.docs[0].root.text, "根");
    assert.equal(typeof disk.docs[0].createdAt, "number");
    assert.equal(typeof disk.docs[0].updatedAt, "number");
  }));

test("原子写不留垃圾：多次保存后目录里没有 *.tmp-* 残留", (t) =>
  serial(async () => {
    const { home, dir, file } = await withHome(t);
    const store = await openAt(home);

    for (let i = 0; i < 5; i += 1) {
      const doc = await store.create(`文档 ${i}`, `根 ${i}`);
      await store.save({ ...store.get(doc.id), title: `文档 ${i} 改` });
    }

    assert.ok(existsSync(file));
    assert.deepEqual(await tempLeftovers(dir), [], "临时文件必须被 rename/rm 清干净");
    const names = await readdir(dir);
    assert.deepEqual(
      names.filter((name) => !name.startsWith("dsh-mindmap.json")),
      [],
      `目录里只应有存储文件，实际：${names.join(", ")}`,
    );
  }));

/* ------------------------------------------------------------------ *
 * 3. 坏数据自愈
 * ------------------------------------------------------------------ */

test("坏 JSON 自愈：不抛错、返回空列表、原文件备份为 *.corrupt-<时间戳>", (t) =>
  serial(async () => {
    const { home, dir, file } = await withHome(t);
    await seed(home, "not json");

    const { logs, logger } = recordingLogger();
    const store = await openAt(home, logger);

    assert.deepEqual(store.list(), [], "坏数据应该得到空列表，而不是抛错");
    assert.equal(existsSync(file), false, "原文件被移走（改名成备份）");

    const backups = await corruptBackups(dir);
    assert.equal(backups.length, 1, `应恰好有一个 corrupt 备份，实际 ${JSON.stringify(backups)}`);
    const stamp = Number(backups[0].slice("dsh-mindmap.json.corrupt-".length));
    assert.ok(Number.isFinite(stamp) && stamp > Date.now() - 60_000, "备份名里的时间戳应是刚刚");
    assert.equal(await readFile(join(dir, backups[0]), "utf8"), "not json", "备份必须是原文件字节");

    assert.ok(logs.warn.length >= 1, "坏数据必须留下一条 warn 日志");
    assert.ok(
      logs.warn.some((args) => args.some((arg) => typeof arg === "string" && arg.includes("corrupt"))),
      "warn 日志里应带出备份路径",
    );
  }));

test("坏 JSON 自愈后仍能正常新建并重新落盘", (t) =>
  serial(async () => {
    const { home, file } = await withHome(t);
    await seed(home, "{ 这不是 JSON");
    const store = await openAt(home);
    assert.deepEqual(store.list(), []);

    const created = await store.create("恢复之后", "根");
    assert.equal(store.list().length, 1);
    const disk = await readStorage(file);
    assert.equal(disk.version, 1);
    assert.equal(disk.docs.length, 1);
    assert.equal(disk.docs[0].id, created.id);

    const reopened = await openAt(home);
    assert.equal(reopened.get(created.id).title, "恢复之后");
  }));

test("存储文件不存在时从空列表开始，且不产生 corrupt 备份", (t) =>
  serial(async () => {
    const { home, dir, file } = await withHome(t);
    const { logs, logger } = recordingLogger();
    const store = await openAt(home, logger);

    assert.deepEqual(store.list(), []);
    assert.deepEqual(await corruptBackups(dir), [], "ENOENT 不是损坏，不该备份");
    assert.equal(logs.warn.length, 0, "首次启动不该有 warn");
    assert.equal(existsSync(file), false);
  }));

test("非对象 / 脏数据 docs 项被 normalizeDoc 修成合法文档", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    // 任务书里的最小样例 + 几个「字段类型全错」的变体
    await seed(home, {
      version: 1,
      docs: [
        null,
        42,
        { id: "x" },
        // id 是数字、title 是空串、root 是字符串、时间戳类型也不对
        { id: 5, title: "", root: "not-an-object", createdAt: "很久以前", updatedAt: null },
      ],
    });

    const store = await openAt(home);
    const list = store.list();
    assert.equal(list.length, 4, "每个脏项都应该被修复成一份文档，而不是整份丢弃");

    for (const row of list) {
      assert.equal(typeof row.id, "string");
      assert.ok(row.id.length > 0, "修复后的文档必须有 id");
      assert.equal(typeof row.title, "string");
      assert.ok(row.title.length > 0, "修复后的文档必须有 title");
      assert.equal(typeof row.createdAt, "number");
      assert.ok(Number.isFinite(row.createdAt), "createdAt 必须是有限数字");
      assert.equal(typeof row.updatedAt, "number");
      assert.ok(Number.isFinite(row.updatedAt), "updatedAt 必须是有限数字");
      const doc = store.get(row.id);
      assert.ok(doc, `get(${row.id}) 应该能取到修复后的文档`);
      assert.ok(doc.root && typeof doc.root === "object", "修复后的文档必须有 root");
      assert.equal(typeof doc.root.text, "string");
      assert.ok(doc.root.text.length > 0, "root 文字会被 title 兜底");
      assert.ok(Array.isArray(doc.root.children));
    }

    assert.equal(new Set(list.map((row) => row.id)).size, 4, "兜底生成的 id 不能互相撞车");

    const x = store.get("x");
    assert.ok(x);
    assert.equal(x.title, "未命名导图");
    assert.equal(x.root.text, "未命名导图", "空 root 文字应被 title 补上");
  }));

test("深层脏数据（null 子节点 / 非对象子节点 / 超深嵌套 / __proto__）被逐项修复而非整份丢弃", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    let deepChain = { text: "底" };
    for (let i = 0; i < 60; i += 1) deepChain = { text: `层${i}`, children: [deepChain] };

    await seed(home, {
      version: 1,
      docs: [
        {
          id: "dirty-deep",
          title: "脏树",
          root: {
            text: "根",
            children: [null, 42, "字符串", { text: "真节点", children: [null, { children: [{ text: "孙" }] }] }],
          },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "proto",
          __proto__: { polluted: true },
          title: "原型污染探测",
          root: { text: "根", children: [] },
          createdAt: 2,
          updatedAt: 2,
        },
        { id: "deep-chain", title: "超深", root: deepChain, createdAt: 3, updatedAt: 3 },
      ],
    });

    const store = await openAt(home);
    assert.equal(store.list().length, 3, "整份文档都不该因为局部脏而消失");

    const doc = store.get("dirty-deep");
    assert.ok(doc);
    assert.equal(doc.root.text, "根");
    assert.equal(doc.root.children.length, 4, "null / 数字 / 字符串子节点被修成空节点，不丢位");
    for (const child of doc.root.children) {
      assert.equal(typeof child.id, "string");
      assert.ok(child.id.length > 0);
      assert.equal(typeof child.text, "string");
      assert.ok(Array.isArray(child.children));
    }
    assert.equal(doc.root.children[3].text, "真节点");
    assert.equal(doc.root.children[3].children[1].children[0].text, "孙");

    const proto = store.get("proto");
    assert.equal(proto.title, "原型污染探测");
    assert.equal({}.polluted, undefined, "不能通过 __proto__ 污染全局 Object 原型");

    // 60 层嵌套被截到 32 层以内，且不抛错
    let depth = 0;
    let cursor = store.get("deep-chain").root;
    while (cursor.children.length > 0) {
      cursor = cursor.children[0];
      depth += 1;
    }
    assert.ok(depth <= 32, `嵌套深度应被限制在 32 以内，实际 ${depth}`);
  }));

test("docs 里重复 id 只保留第一条", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    await seed(home, {
      version: 1,
      docs: [
        { id: "dup", title: "第一份", root: { text: "一", children: [] }, createdAt: 1, updatedAt: 1 },
        { id: "dup", title: "第二份", root: { text: "二", children: [] }, createdAt: 2, updatedAt: 2 },
      ],
    });

    const store = await openAt(home);
    assert.equal(store.list().length, 1, "同 id 不能在列表里出现两份");
    const doc = store.get("dup");
    assert.equal(doc.title, "第一份", "保留先出现的那条");
    assert.equal(doc.root.text, "一");
  }));

/* ------------------------------------------------------------------ *
 * 4. 时间戳与排序
 * ------------------------------------------------------------------ */

test("save 由服务端盖 updatedAt，createdAt 保留原值", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    const store = await openAt(home);

    const saved = await store.save({
      id: "srv-stamp",
      title: "时钟不可信",
      root: { id: "r", text: "根", children: [] },
      createdAt: 12_345,
      updatedAt: 1,
    });

    assert.ok(saved.updatedAt > Date.now() - 60_000, `updatedAt 应被盖成当前时间，实际 ${saved.updatedAt}`);
    assert.equal(saved.createdAt, 12_345, "createdAt 必须保留原有的值");

    // 落盘之后也必须是服务端时间，而不是客户端提交的 1
    const reopened = await openAt(home);
    const doc = reopened.get("srv-stamp");
    assert.ok(doc.updatedAt > Date.now() - 60_000, `磁盘上的 updatedAt 也应被盖新，实际 ${doc.updatedAt}`);
    assert.equal(doc.createdAt, 12_345);
  }));

test("list() 按 updatedAt 倒序（与插入顺序无关）", (t) =>
  serial(async () => {
    const { home, file } = await withHome(t);
    const store = await openAt(home);

    const a = await store.create("A", "A 根");
    await delay(10);
    const b = await store.create("B", "B 根");

    // 关键：插入顺序是 [A, B]，但 B 更新 —— 排序正确时结果必须反过来。
    // 如果实现退化成 Map 的插入顺序，这条会立刻失败。
    assert.deepEqual(
      store.list().map((row) => row.id),
      [b.id, a.id],
      "最近更新的 B 应排最前，而不是按插入顺序",
    );

    // 落盘顺序同样必须是 updatedAt 倒序，而不是 Map 插入顺序
    let disk = await readStorage(file);
    assert.deepEqual(
      disk.docs.map((doc) => doc.id),
      [b.id, a.id],
      "磁盘上 docs 的顺序也应按 updatedAt 倒序",
    );

    // 重新打开：顺序从磁盘读回来仍然正确
    let reopened = await openAt(home);
    assert.deepEqual(
      reopened.list().map((row) => row.id),
      [b.id, a.id],
      "重新打开后顺序不变",
    );

    // 刷一遍 A，A 应跳到最前（插入顺序仍是 [A, B]，所以这还要求排序不是插入序）
    await delay(10);
    const aDoc = store.get(a.id);
    assert.ok(aDoc);
    const refreshed = await store.save({ ...aDoc, root: { ...aDoc.root, text: "A 根（改）" } });
    assert.ok(refreshed.updatedAt > b.updatedAt, "A 的 updatedAt 应刷新到 B 之后");

    assert.deepEqual(
      store.list().map((row) => row.id),
      [a.id, b.id],
      "保存后的 A 应排第一",
    );

    disk = await readStorage(file);
    assert.deepEqual(
      disk.docs.map((doc) => doc.id),
      [a.id, b.id],
      "落盘顺序也应跟着变",
    );

    reopened = await openAt(home);
    assert.deepEqual(
      reopened.list().map((row) => row.id),
      [a.id, b.id],
      "重新打开后 A 仍排第一",
    );
  }));

test("updatedAt 相同时排序结果稳定（不会互相穿插）", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    const same = Array.from({ length: 5 }, (_, i) => ({
      id: `same-${i}`,
      title: `同刻 ${i}`,
      root: { text: "根", children: [] },
      createdAt: 500,
      updatedAt: 500,
    }));
    await seed(home, { version: 1, docs: same });

    const store = await openAt(home);
    const ids1 = store.list().map((row) => row.id);
    const ids2 = store.list().map((row) => row.id);
    assert.equal(ids1.length, 5);
    assert.deepEqual(ids1, ids2, "同样的数据连续两次 list() 顺序必须一致");
    assert.deepEqual([...ids1].sort(), same.map((d) => d.id).sort(), "不能丢文档");
  }));

/* ------------------------------------------------------------------ *
 * 5. rename / remove
 * ------------------------------------------------------------------ */

test("rename 改标题并持久化；不存在的 id 返回 undefined", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    const store = await openAt(home);
    const created = await store.create("旧标题", "根");

    const renamed = await store.rename(created.id, "新标题");
    assert.ok(renamed);
    assert.equal(renamed.id, created.id);
    assert.equal(renamed.title, "新标题");
    assert.equal(store.get(created.id).title, "新标题");
    assert.equal(store.list()[0].title, "新标题");

    assert.equal(await store.rename("doc-不存在", "随便"), undefined);
    assert.equal(await store.rename("", "随便"), undefined);
    assert.equal(store.list().length, 1, "rename 不存在 id 不该产生文档");

    const reopened = await openAt(home);
    assert.equal(reopened.get(created.id).title, "新标题", "rename 必须落盘");
  }));

test("remove 删除成功返回 true、列表少一个；重复删除返回 false", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    const store = await openAt(home);
    const doomed = await store.create("要删的", "根");
    const keeper = await store.create("留下的", "根");

    assert.equal(await store.remove(doomed.id), true);
    assert.equal(store.list().length, 1);
    assert.equal(store.list()[0].id, keeper.id);
    assert.equal(store.get(doomed.id), undefined);

    assert.equal(await store.remove(doomed.id), false, "删第二次必须是 false");
    assert.equal(await store.remove("从来没有过"), false);

    const reopened = await openAt(home);
    assert.equal(reopened.list().length, 1);
    assert.equal(reopened.get(doomed.id), undefined);
    assert.ok(reopened.get(keeper.id));
  }));

/* ------------------------------------------------------------------ *
 * 6. 深拷贝隔离
 * ------------------------------------------------------------------ */

test("get() 返回深拷贝：改 root.children / root.text 不影响 Host 内部状态", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    await seed(home, {
      version: 1,
      docs: [
        {
          id: "deep",
          title: "深拷贝",
          createdAt: 100,
          updatedAt: 100,
          root: {
            id: "r",
            text: "根",
            children: [
              { id: "c1", text: "子1", children: [{ id: "g1", text: "孙", children: [] }] },
              { id: "c2", text: "子2", children: [] },
            ],
          },
        },
      ],
    });

    const store = await openAt(home);
    const first = store.get("deep");
    assert.ok(first);

    // 调用方（客户端）拿到之后随便改，包括深层节点
    first.title = "被调用方改坏";
    first.root.text = "被调用方改坏";
    first.root.children.push({ id: "evil", text: "注入", children: [] });
    first.root.children[0].text = "被调用方改坏";
    first.root.children[0].children[0].text = "被调用方改坏";

    const second = store.get("deep");
    assert.notEqual(second, first, "两次 get 必须是不同对象");
    assert.notEqual(second.root, first.root);
    assert.equal(second.title, "深拷贝");
    assert.equal(second.root.text, "根");
    assert.equal(second.root.children.length, 2, "不能被塞进新节点");
    assert.equal(second.root.children[0].text, "子1");
    assert.equal(second.root.children[0].children[0].text, "孙");

    assert.equal(store.list()[0].title, "深拷贝", "列表也不受影响");
  }));

test("create() / save() 的返回值同样是副本", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    const store = await openAt(home);
    const created = await store.create("副本", "根文字");

    created.title = "被改坏";
    created.root.text = "被改坏";
    created.root.children.push({ id: "evil", text: "注入", children: [] });

    const again = store.get(created.id);
    assert.equal(again.title, "副本");
    assert.equal(again.root.text, "根文字");
    assert.equal(again.root.children.length, 0);

    const saved = await store.save({ ...again, title: "保存后的标题" });
    saved.root.text = "被改坏";
    assert.equal(store.get(created.id).root.text, "根文字", "save 的返回值也不能反向污染内存");
  }));

/* ------------------------------------------------------------------ *
 * 7. 容量上限
 * ------------------------------------------------------------------ */

test("达到 MAX_DOCS 后 create 抛错，错误信息里含上限数字", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    // 一次写入 MAX_DOCS 份文档，避免 200 次原子写拖慢验收
    await seed(home, { version: 1, docs: makeDocs(MAX_DOCS) });

    const store = await openAt(home);
    assert.equal(store.list().length, MAX_DOCS, `${MAX_DOCS} 份全量加载`);

    await assert.rejects(
      () => store.create("第 201 份"),
      (error) => {
        assert.ok(error instanceof Error, "必须抛 Error");
        assert.ok(
          error.message.includes(String(MAX_DOCS)),
          `错误信息里应含上限数字 ${MAX_DOCS}，实际：「${error.message}」`,
        );
        assert.match(error.message, /上限/, "错误信息应明确说清是上限");
        return true;
      },
    );

    assert.equal(store.list().length, MAX_DOCS, "被拒绝之后数量不变");
    const reopened = await openAt(home);
    assert.equal(reopened.list().length, MAX_DOCS);
  }));

test("MAX_DOCS-1 时仍可 create；满额后新 id 的 save 被拒、已有 id 的 save 仍可更新", (t) =>
  serial(async () => {
    const { home } = await withHome(t);
    await seed(home, { version: 1, docs: makeDocs(MAX_DOCS - 1) });
    const store = await openAt(home);
    assert.equal(store.list().length, MAX_DOCS - 1);

    const last = await store.create("最后一份", "根");
    assert.equal(store.list().length, MAX_DOCS, "边界上最后一份应该能建");

    await assert.rejects(
      () =>
        store.save({
          id: "brand-new",
          title: "溢出",
          root: { text: "根", children: [] },
          createdAt: 1,
          updatedAt: 1,
        }),
      (error) => {
        assert.ok(error.message.includes(String(MAX_DOCS)));
        return true;
      },
    );

    // 已有的文档更新不受容量限制影响
    const updated = await store.save({ ...store.get(last.id), title: "更新已有", updatedAt: 1 });
    assert.equal(updated.title, "更新已有");
    assert.ok(updated.updatedAt > Date.now() - 60_000);
    assert.equal(store.list().length, MAX_DOCS);
  }));

/* ------------------------------------------------------------------ *
 * 8. 并发
 * ------------------------------------------------------------------ */

test("并发 save 不互相覆盖：不 await 连发后全部落盘", (t) =>
  serial(async () => {
    const { home, dir } = await withHome(t);
    const store = await openAt(home);

    const inputs = Array.from({ length: 12 }, (_, i) => ({
      id: `concurrent-${i}`,
      title: `并发 ${i}`,
      root: { id: `cr-${i}`, text: `根 ${i}`, children: [{ id: `cn-${i}`, text: `子 ${i}`, children: [] }] },
      createdAt: 1,
      updatedAt: 1,
    }));

    // 故意不逐个 await：写盘队列必须自己串起来
    const pending = inputs.map((input) => store.save(input));
    const results = await Promise.all(pending);
    assert.equal(results.length, 12);

    const reopened = await openAt(home);
    assert.equal(reopened.list().length, 12, "12 份并发保存的文档必须全部在盘上");
    for (const input of inputs) {
      const doc = reopened.get(input.id);
      assert.ok(doc, `${input.id} 丢失了`);
      assert.equal(doc.title, input.title);
      assert.equal(doc.root.text, input.root.text);
      assert.equal(doc.root.children[0].text, input.root.children[0].text);
    }
    assert.deepEqual(await tempLeftovers(dir), []);
  }));

test("并发 create 全部落盘且 id 不重复", (t) =>
  serial(async () => {
    const { home, dir } = await withHome(t);
    const store = await openAt(home);

    const made = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.create(`并发新建 ${i}`, `根 ${i}`)),
    );
    assert.equal(new Set(made.map((doc) => doc.id)).size, 8, "并发新建的 id 不能撞");

    const reopened = await openAt(home);
    assert.equal(reopened.list().length, 8);
    for (const doc of made) {
      const found = reopened.get(doc.id);
      assert.ok(found, `${doc.id} 丢失了`);
      assert.equal(found.title, doc.title);
      assert.equal(found.root.text, doc.root.text);
    }
    assert.deepEqual(await tempLeftovers(dir), []);
  }));

test("磁盘上超过 MAX_DOCS 份时：不抛错，加载被截到上限，create 仍被拒", (t) =>
  serial(async () => {
    const { home, file } = await withHome(t);
    const overflow = MAX_DOCS + 7;
    await seed(home, { version: 1, docs: makeDocs(overflow, "over") });

    // 插件不能因为历史数据超量而起不来
    const store = await openAt(home);
    assert.equal(store.list().length, MAX_DOCS, `加载应被截到 ${MAX_DOCS} 份`);

    await assert.rejects(
      () => store.create("再来一份"),
      (error) => {
        assert.ok(error.message.includes(String(MAX_DOCS)));
        return true;
      },
    );
    assert.equal(existsSync(file), true);
  }));

test("[回归] 超量加载后写盘不删除磁盘上超出的文档（曾会静默丢数据）", (t) =>
    serial(async () => {
      const { home, file } = await withHome(t);
      const overflow = MAX_DOCS + 7;
      const original = makeDocs(overflow, "over");
      await seed(home, { version: 1, docs: original });

      const store = await openAt(home);
      assert.equal(store.list().length, MAX_DOCS);

      // 只做一个与那 7 份无关的无害操作
      await store.rename("over-0", "改个名");

      const disk = await readStorage(file);
      assert.equal(
        disk.docs.length,
        overflow,
        `磁盘上的 ${overflow} 份文档一份都不该消失，实际只剩 ${disk.docs.length} 份`,
      );
      const survived = new Set(disk.docs.map((doc) => doc.id));
      assert.ok(survived.has("over-200"), "超出上限的文档也不该被静默删除");
    }),
);

/* ------------------------------------------------------------------ *
 * 9. 故障恢复（已知缺陷回归位）
 * ------------------------------------------------------------------ */

test("[回归] 磁盘写失败后队列不被毒化：恢复可写后仍能继续保存", (t) =>
    serial(async () => {
      const { home, dir } = await withHome(t);
      const store = await openAt(home);
      await store.create("第一份", "根");

      let failed = false;
      try {
        // 让目录不可写 → 下一次 flush 必须失败（这一步本身是正确行为）
        await chmod(dir, 0o500);
        await assert.rejects(() => store.create("写不进去", "根"));

        // 恢复可写：期望能继续写，实际这里仍然抛 EACCES
        await chmod(dir, 0o700);
        const recovered = await store.create("恢复后", "根");
        assert.ok(recovered.id, "目录已恢复可写，保存不该继续失败");

        const reopened = await openAt(home);
        assert.ok(reopened.get(recovered.id), "恢复后的文档必须落盘");
      } catch (error) {
        failed = true;
        throw new Error(
          "写队列被一次失败永久毒化：目录恢复 0700 后 create 仍然失败（" +
            String(error?.code ?? error?.message ?? error) +
            "）。期望：失败只影响那一次调用；实际：该 store 实例后续所有写都失败。",
        );
      } finally {
        await chmod(dir, 0o700).catch(() => {});
        if (!failed) {
          // 通过时无需额外动作
        }
      }
    }),
);

test("[回归] 写盘失败后内存不留幽灵文档（内存与磁盘不分叉）", (t) =>
    serial(async () => {
      const { home, dir } = await withHome(t);
      const store = await openAt(home);
      const first = await store.create("第一份", "根");

      let phantomId;
      try {
        await chmod(dir, 0o500);
        // 捕获 id 不可能（调用 reject 了），所以按标题比对
        await assert.rejects(() => store.create("没写进去", "根"));
      } finally {
        await chmod(dir, 0o700).catch(() => {});
      }

      // 期望：写失败的文档不该留在内存里。实际：留了一份幽灵文档。
      const titles = store.list().map((row) => row.title);
      assert.deepEqual(
        titles,
        ["第一份"],
        `写盘失败的文档不该出现在 list() 里，实际：${JSON.stringify(titles)}`,
      );

      // 而且它与磁盘一致（重新打开后内容和内存一致，不会凭空少一份）
      const reopened = await openAt(home);
      assert.deepEqual(
        reopened.list().map((row) => row.title),
        titles,
        "内存与磁盘必须一致，否则重启会悄悄丢数据",
      );
      assert.ok(reopened.get(first.id));
    }),
);

/* ------------------------------------------------------------------ *
 * 兜底：整轮测试结束后，真实 ~/.dsh 必须原封不动
 * ------------------------------------------------------------------ */

after(() => {
  assert.equal(
    existsSync(REAL_FILE),
    REAL_FILE_EXISTED_AT_START,
    "验收测试污染了真实 ~/.dsh，这是硬性禁止的",
  );
});