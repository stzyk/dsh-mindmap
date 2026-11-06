/**
 * dsh-mindmap — 存储层（Host 半区）。
 *
 * 落盘位置：`$DSH_HOME/storages/dsh-mindmap.json`
 * （默认 `~/.dsh/storages/dsh-mindmap.json`），与 profile 的其它插件存储同目录。
 *
 * 三条硬约束，都是踩过坑才这么写的：
 *   1. **永不因为坏数据加载失败**：读不到 = 空列表；解析失败 = 把原文件
 *      备份成 *.corrupt-<ts> 后从空列表继续。插件不该让宿主起不来。
 *   2. **原子写**：先写临时文件再 rename，读者永远看不到半截 JSON。
 *   3. **串行写**：并发保存不互相覆盖，磁盘顺序 = 内存顺序。
 *
 * 容量上给文档数设了上限（MAX_DOCS）。超了拒绝新建并给出明确错误，
 * 而不是让一个 JSON 文件无限膨胀到每次保存都要序列化几兆。
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  MAX_TITLE,
  cleanText,
  newId,
  normalizeDoc,
  summarize,
  type MindDoc,
  type MindDocSummary,
} from "./core/tree.ts";

/** 存储文件名（落在 DSH_HOME/storages 下）。 */
export const STORAGE_NAME = "dsh-mindmap.json";

/** 文档数上限。 */
export const MAX_DOCS = 200;

/** 磁盘文件格式。 */
interface StorageFile {
  version: 1;
  docs: unknown[];
}

/** 解析存储文件路径：跟随 DSH_HOME，回落 ~/.dsh。 */
export function storageFile(): string {
  const home = process.env.DSH_HOME?.trim();
  const rootDir = home !== undefined && home.length > 0 ? home : join(homedir(), ".dsh");
  return join(rootDir, "storages", STORAGE_NAME);
}

/** 存储句柄：内存里是一份完整的文档 Map，写盘串行。 */
export interface MindStore {
  file(): string;
  /** 全部文档摘要（按 updatedAt 倒序）。 */
  list(): MindDocSummary[];
  /** 取一份完整文档（深拷贝，调用方随便改）。 */
  get(id: string): MindDoc | undefined;
  /** 新建文档。超过 MAX_DOCS 时抛错。 */
  create(title: string, rootText?: string): Promise<MindDoc>;
  /** 整份保存（客户端提交完整树）。 */
  save(input: unknown): Promise<MindDoc>;
  /** 改标题。 */
  rename(id: string, title: string): Promise<MindDoc | undefined>;
  /** 删除。 */
  remove(id: string): Promise<boolean>;
}

/**
 * 打开存储。
 * @param logger - 宿主 logger（可缺省；缺失时回落 console）。
 */
export async function openStore(logger?: {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}): Promise<MindStore> {
  const file = storageFile();
  const dir = join(file, "..");
  const log = logger ?? {
    info: (...args: unknown[]) => console.info("[mindmap]", ...args),
    warn: (...args: unknown[]) => console.warn("[mindmap]", ...args),
  };

  const docs = new Map<string, MindDoc>();

  /**
   * 超量加载时被截断的文档。
   *
   * 为什么要留着：磁盘上有 207 份、内存只装得下 200 份时，如果下一次写盘
   * 只把内存里的 200 份写回去，另外 7 份就被**永久删除**了——而且用户只是
   * 改了个标题，根本没要求删任何东西。这些文档不参与内存操作，但每次写盘
   * 原样带回磁盘。
   */
  const overflow: MindDoc[] = [];

  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    log.warn("无法创建存储目录", dir, error);
  }

  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<StorageFile> | null;
    const rows = Array.isArray(parsed?.docs) ? parsed.docs : [];
    for (const row of rows) {
      const doc = normalizeDoc(row);
      // 同 id 只保留第一个：手改文件导致的重复 id 不该让列表里出现两份
      if (docs.has(doc.id)) continue;
      if (docs.size >= MAX_DOCS) {
        overflow.push(doc);
        continue;
      }
      docs.set(doc.id, doc);
    }
    log.info(
      "已加载 " +
        String(docs.size) +
        " 份导图（" +
        file +
        "）" +
        (overflow.length > 0 ? "；另有 " + String(overflow.length) + " 份超出上限，保留在磁盘上不参与编辑" : ""),
    );
    if (overflow.length > 0) {
      log.warn(
        "导图数量超过上限 " +
          String(MAX_DOCS) +
          "，多出的 " +
          String(overflow.length) +
          " 份不会显示，但会原样保留在磁盘上。删掉一些导图后重启即可重新看到它们。",
      );
    }
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "ENOENT") {
      log.info("暂无存储文件，从空列表开始（" + file + "）");
    } else {
      const backup = file + ".corrupt-" + String(Date.now());
      try {
        await rename(file, backup);
      } catch {
        /* 备份失败不阻断启动 */
      }
      log.warn("存储文件无法解析，已备份为 " + backup);
    }
  }

  /** 用给定 Map 就地替换内存中的文档集合（保持 Map 引用不变）。 */
  const replaceDocs = (source: Map<string, MindDoc>): void => {
    for (const key of [...docs.keys()]) docs.delete(key);
    for (const [key, value] of source) docs.set(key, value);
  };

  /**
   * 串行写队列。
   *
   * 关键细节：连续写盘的**排队**与写给调用方的**结果**必须分开。
   *
   * 早先的写法是 `writeChain = writeChain.then(write)` 并把 writeChain 返回给
   * 调用方 —— 一次 EACCES 之后 writeChain 变成 rejected，后续每次 .then 都
   * 在已失败的 promise 上继续失败，这个 store 实例的所有保存**永久**失效，
   * 连磁盘恢复可写也救不回来。
   *
   * 现在：queue 只是"上一单做完没有"，自身永远不 rejected（用 catch 吞掉
   * 错误）；真正的错误通过每单自己的 deferred 返回给对应调用方。
   */
  let queue: Promise<void> = Promise.resolve();

  /** 产生一次写盘并返回它的结果 promise（失败只影响这一次）。 */
  const flush = (): Promise<void> => {
    const run = queue.then(async () => {
      const payload: StorageFile = {
        version: 1,
        // 超量文档原样写回：它们不参与编辑，但绝不能因为一次无关操作被删
        docs: [...docs.values(), ...overflow].sort((a, b) => b.updatedAt - a.updatedAt),
      };
      const body = JSON.stringify(payload, null, 2);
      const temp = file + ".tmp-" + String(process.pid) + "-" + String(Date.now());
      try {
        await writeFile(temp, body, "utf8");
        await rename(temp, file);
      } finally {
        // 失败时也要清掉临时文件，否则多次失败会攒一堆 .tmp-*
        await rm(temp, { force: true }).catch(() => undefined);
      }
    });

    // 队列只关心"这一单结束了吗"，不关心成败 —— 失败绝不能传染给下一单
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /**
   * 串行化的"改内存 + 落盘"，失败回滚。
   *
   * 两个不变量：
   *   1. **失败不影响下一次**：队列自身永不 rejected（见 flush 的说明）。
   *   2. **失败不留下幽灵状态**：先在草稿 Map 上改，落盘成功才替换内存；
   *      中途失败就把内存还原成改动前的快照。
   *
   * 整个「读快照 → 改草稿 → 落盘 → 切内存」必须在同一条串行链上完成，
   * 否则两个并发 commit 会各自基于同一个旧快照算草稿，后完成的那个把
   * 先完成的改动整份覆盖掉。`commitChain` 就是这把锁。
   *
   * @param mutate - 在草稿 Map 上应用修改。
   */
  let commitChain: Promise<void> = Promise.resolve();

  const commit = (mutate: (draft: Map<string, MindDoc>) => void): Promise<void> => {
    const run = commitChain.then(async () => {
      const snapshot = new Map(docs);
      const draft = new Map(docs);
      mutate(draft);
      // 落盘期间读到的必须是新状态；失败时按 snapshot 还原
      replaceDocs(draft);
      try {
        await flush();
      } catch (error) {
        replaceDocs(snapshot);
        throw error;
      }
    });
    commitChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    file(): string {
      return file;
    },

    list(): MindDocSummary[] {
      return [...docs.values()].map(summarize).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    get(id: string): MindDoc | undefined {
      const found = docs.get(id);
      // 交给调用方的必须是副本：否则 Host 内存里的树会被序列化逻辑悄悄改掉
      return found === undefined ? undefined : structuredClone(found);
    },

    async create(title: string, rootText?: string): Promise<MindDoc> {
      const now = Date.now();
      const safeTitle = cleanText(title, MAX_TITLE) || "未命名导图";
      const doc = normalizeDoc({
        id: newId("doc"),
        title: safeTitle,
        root: { text: cleanText(rootText ?? safeTitle, MAX_TITLE) || safeTitle, children: [] },
        createdAt: now,
        updatedAt: now,
      });
      await commit((draft) => {
        // 上限在草稿上判：两个 create 并发时，后者看到的是前者已占的名额
        if (draft.size >= MAX_DOCS) {
          throw new Error("导图数量已达上限 " + String(MAX_DOCS) + " 份，请先删除一些不再需要的导图");
        }
        draft.set(doc.id, doc);
      });
      return structuredClone(doc);
    },

    async save(input: unknown): Promise<MindDoc> {
      const incoming = normalizeDoc(input);
      let saved: MindDoc | undefined;
      await commit((draft) => {
        const existing = draft.get(incoming.id);
        if (existing === undefined && draft.size >= MAX_DOCS) {
          // 客户端带了本地新建的文档（离线创建 / 刚点新建还没落盘）：也受上限约束
          throw new Error("导图数量已达上限 " + String(MAX_DOCS) + " 份");
        }
        saved = {
          ...incoming,
          createdAt: existing?.createdAt ?? incoming.createdAt,
          // 保存时间以服务端为准：客户端时钟不可信，排序会因此错乱
          updatedAt: Date.now(),
        };
        draft.set(saved.id, saved);
      });
      return structuredClone(saved as MindDoc);
    },

    async rename(id: string, title: string): Promise<MindDoc | undefined> {
      const existing = docs.get(id);
      if (existing === undefined) return undefined;
      const next: MindDoc = {
        ...existing,
        title: cleanText(title, MAX_TITLE) || existing.title,
        updatedAt: Date.now(),
      };
      await commit((draft) => {
        draft.set(id, next);
      });
      return structuredClone(next);
    },

    async remove(id: string): Promise<boolean> {
      if (!docs.has(id)) return false;
      await commit((draft) => {
        draft.delete(id);
      });
      return true;
    },
  };
}
