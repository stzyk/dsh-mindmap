/**
 * dsh-mindmap — 思维导图（Host 半区）。
 *
 * 职责：
 * 1. **文档存储的权威**：所有导图存在 `$DSH_HOME/storages/dsh-mindmap.json`，
 *    原子写 + 串行队列，刷新页面、换浏览器、重启进程都不会丢。
 * 2. **UI 通道**：/mindmap 前缀路由，线格式与 connection RPC 一致
 *    （client-request / server-response 封套），供浏览器半区读写文档。
 * 3. **命令行**：`/mindmap list | show <id> | markdown <id> [list] | new <标题> | rm <id>`。
 *    不开网页也能看导图、把它导出成 Markdown 贴进会话。
 *
 * 为什么不把导图存 localStorage：用户在会话里可能想把导图内容直接喂给模型，
 * 存 Host 才能被命令读到；而且换个浏览器打开就没了的东西，不配叫"保存"。
 *
 * 零 npm 依赖：只用 Node 内建模块与注入服务。
 */

import { toMarkdown, type MarkdownMode } from "./core/markdown.ts";
import { MAX_DOCS, openStore, storageFile, type MindStore } from "./store.ts";
import { openAssetStore, type AssetStore } from "./assets.ts";
import { collectImages, countImages, MAX_IMAGES_PER_DOC } from "./core/tree.ts";

/** 客户端 fetch 的通道前缀，必须与 src/client/index.tsx 中的 CHANNEL 一致。 */
export const CHANNEL = "/mindmap";

/** 重新导出，方便测试与外部引用。 */
export { storageFile, MAX_DOCS };

/**
 * Cordis 严格注入。
 *
 * connection：鉴权围栏（requestRejection）；
 * webServer：注册 /mindmap 路由；
 * commands：/mindmap 斜杠命令。
 *
 * 路由用 ctx.inject(["connection","webServer"]) 的作用域注入直接
 * webServer.register，而不是 connection.rpc.handle —— 后者内部经
 * owner.effect(() => owner.webServer.register(route)) 注册，而 webServer
 * 提供在插件树的兄弟分支上，嵌套作用域解析不到它，实测必抛
 * "cannot get property webServer without inject"，路由根本不注册。
 */
export const inject = ["connection", "webServer", "commands"];

/** webServer 收到的请求（结构化最小类型，避免依赖平台包类型）。 */
interface IncomingLike {
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
  headers?: Record<string, string | string[] | undefined>;
  method?: string;
}

/** webServer 回包句柄。 */
interface OutgoingLike {
  writeHead(code: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

/** webServer 路由面。 */
interface WebServerLike {
  register(route: {
    kind: "prefix" | "exact";
    path: string;
    handler(req: IncomingLike, res: OutgoingLike): Promise<void> | void;
  }): unknown;
}

/** Host 半区可用服务（结构化最小类型）。 */
interface HostServices {
  logger?: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  effect(fn: () => unknown, label?: string): unknown;
  inject(deps: string[], callback: (scoped: HostServices) => void): void;
  connection?: {
    requestRejection?(request: IncomingLike): number | undefined;
  };
  webServer?: WebServerLike;
  commands?: {
    register(definition: {
      name: string;
      description: string;
      input?: { hint: string };
      handler: (invocation: { rawInput: string; signal?: AbortSignal }) => Promise<unknown> | unknown;
    }): unknown;
  };
}

/** RPC 成功封套。 */
interface RpcOk {
  ok: true;
  value: unknown;
}
/** RPC 失败封套。 */
interface RpcFail {
  ok: false;
  error: { code: string; message: string; details: Record<string, unknown> };
}

/**
 * 安全 logger。
 *
 * cordis 的 `ctx.logger` 只有在 apply() 执行那一刻已就绪才可用；未就绪时它是
 * undefined，`logger?.warn(...)` 会把整条告警**静默吞掉**——开发番茄钟插件时
 * 真实踩过：路由注册失败被 try/catch 接住，告警走的就是这条静默路径，
 * 启动日志干干净净，直到浏览器实测 405 才暴露。所以这里 logger 缺失一律回落
 * console.error，并且每次调用都重新解析。
 */
function safeLogger(ctx: HostServices): { info(...args: unknown[]): void; warn(...args: unknown[]): void } {
  const emit = (level: "info" | "warn", args: unknown[]): void => {
    const live = ctx.logger;
    if (live !== undefined) {
      try {
        if (level === "info") live.info(...args);
        else live.warn(...args);
        return;
      } catch {
        /* logger 自身抛错不能带崩业务路径 */
      }
    }
    const consoleLike = (globalThis as { console?: Console }).console;
    consoleLike?.error("[mindmap][" + level + "]", ...args);
  };
  return { info: (...args) => emit("info", args), warn: (...args) => emit("warn", args) };
}

/** 从 /mindmap/<method> 里取出方法名。 */
export function methodOf(url: string | undefined, prefix: string): string {
  const path = (url ?? "").split("?")[0] ?? "";
  if (!path.startsWith(prefix)) return "";
  return path.slice(prefix.length).replace(/^\/+/, "").replace(/\/+$/, "");
}

/** 注册 Host 半区。 */
export function apply(ctx: HostServices): void {
  const logger = safeLogger(ctx);

  ctx.effect(() => {
    let disposed = false;
    let storeHandle: MindStore | undefined;
    let disposeRpc: unknown;
    let disposeCommand: unknown;

    const ready = openStore(logger).then((opened) => {
      if (disposed) return undefined;
      storeHandle = opened;
      return opened;
    });

    /** 图片资产存储：与文档同目录下的 assets 子目录。 */
    let assets: AssetStore | undefined;
    const assetReady = ready.then(async (opened) => {
      if (opened === undefined) return undefined;
      // storages/dsh-mindmap.json → storages/
      const storagesDir = opened.file().replace(/[\\/][^\\/]+$/, "");
      const opened_assets = await openAssetStore(storagesDir, logger);
      assets = opened_assets;
      return opened_assets;
    });

    /**
     * 收集所有文档仍在引用的图片 id。
     *
     * 每次删除文档/节点后重算一遍：这个集合不大（几十上百个 id），
     * 但能保证「删 A 文档时不会顺手删掉 B 文档还在用的图」。
     */
    const referencedImageIds = (store: MindStore): Set<string> => {
      const ids = new Set<string>();
      for (const summary of store.list()) {
        const doc = store.get(summary.id);
        if (doc === undefined) continue;
        for (const image of collectImages(doc.root)) ids.add(image.id);
      }
      return ids;
    };

    const ok = (value: unknown): RpcOk => ({ ok: true, value });
    const fail = (code: string, message: string): RpcFail => ({ ok: false, error: { code, message, details: {} } });

    const need = async (): Promise<MindStore | undefined> => {
      const opened = await ready;
      return opened === undefined ? undefined : opened;
    };

    /** RPC 端点。客户端与 /mindmap 命令共用同一份实现。 */
    const endpoints: Record<string, (payload: Record<string, unknown>) => Promise<RpcOk | RpcFail>> = {
      async ping() {
        const store = await need();
        if (store === undefined) return fail("disposed", "插件已卸载");
        return ok({ name: "dsh-mindmap", time: Date.now(), file: store.file(), count: store.list().length });
      },

      async "docs.list"() {
        const store = await need();
        if (store === undefined) return fail("disposed", "插件已卸载");
        return ok({ docs: store.list(), file: store.file(), maxDocs: MAX_DOCS });
      },

      async "docs.get"(payload) {
        const store = await need();
        if (store === undefined) return fail("disposed", "插件已卸载");
        const id = typeof payload.id === "string" ? payload.id : "";
        const doc = store.get(id);
        if (doc === undefined) return fail("not-found", "找不到这份导图：" + id);
        return ok({ doc });
      },

      async "docs.create"(payload) {
        const store = await need();
        if (store === undefined) return fail("disposed", "插件已卸载");
        try {
          const doc = await store.create(
            typeof payload.title === "string" ? payload.title : "",
            typeof payload.rootText === "string" ? payload.rootText : undefined,
          );
          logger.info("新建导图「" + doc.title + "」");
          return ok({ doc, docs: store.list() });
        } catch (error) {
          return fail("limit", (error as Error).message);
        }
      },

      async "docs.save"(payload) {
        const store = await need();
        if (store === undefined) return fail("disposed", "插件已卸载");
        const doc = payload.doc;
        if (doc === null || typeof doc !== "object") return fail("bad-input", "缺少 doc 字段");
        try {
          const saved = await store.save(doc);
          return ok({ doc: saved, docs: store.list() });
        } catch (error) {
          return fail("limit", (error as Error).message);
        }
      },

      async "docs.rename"(payload) {
        const store = await need();
        if (store === undefined) return fail("disposed", "插件已卸载");
        const id = typeof payload.id === "string" ? payload.id : "";
        const title = typeof payload.title === "string" ? payload.title : "";
        const doc = await store.rename(id, title);
        if (doc === undefined) return fail("not-found", "找不到这份导图：" + id);
        return ok({ doc, docs: store.list() });
      },

      async "docs.remove"(payload) {
        const store = await need();
        const assetStore = await assetReady;
        if (store === undefined) return fail("disposed", "插件已卸载");
        const id = typeof payload.id === "string" ? payload.id : "";

        // 删文档前先记下它用了哪些图片，以及每张图的类型
        // （文档删完就取不到了，类型是删文件需要的）
        const doomed = new Map<string, string>();
        const doc = store.get(id);
        if (doc !== undefined) {
          for (const image of collectImages(doc.root)) doomed.set(image.id, image.type);
        }

        const removed = await store.remove(id);
        if (!removed) return fail("not-found", "找不到这份导图：" + id);

        // 只删「别的文档确实没在用」的那些：同一张图可能被多份导图引用，
        // 无脑删会让另一份变成裂图。
        if (assetStore !== undefined && doomed.size > 0) {
          const stillReferenced = referencedImageIds(store);
          let cleaned = 0;
          for (const [imageId, type] of doomed) {
            if (stillReferenced.has(imageId)) continue;
            await assetStore.remove({ id: imageId, type });
            cleaned += 1;
          }
          if (cleaned > 0) logger.info("删除导图时清理了 " + String(cleaned) + " 张独占图片");
        }

        return ok({ removed: id, docs: store.list() });
      },

      /** 存一张图片：客户端把字节 base64 过来，Host 校验后落盘。 */
      async "assets.put"(payload) {
        const store = await need();
        const assetStore = await assetReady;
        if (store === undefined || assetStore === undefined) return fail("disposed", "插件已卸载");

        const id = typeof payload.id === "string" ? payload.id : "";
        const type = typeof payload.type === "string" ? payload.type : "";
        const base64 = typeof payload.data === "string" ? payload.data : "";
        if (base64.length === 0) return fail("bad-input", "缺少图片数据");

        let bytes: Buffer;
        try {
          bytes = Buffer.from(base64, "base64");
        } catch {
          return fail("bad-input", "图片数据不是合法 base64");
        }

        const result = await assetStore.put(id, type, new Uint8Array(bytes));
        if (!result.ok) return fail("bad-image", result.reason);
        return ok({ image: result.image, dir: assetStore.dir() });
      },

      /** 读一张图片：返回 base64 + MIME，浏览器用 blob URL 渲染。 */
      async "assets.get"(payload) {
        const assetStore = await assetReady;
        if (assetStore === undefined) return fail("disposed", "插件已卸载");
        const id = typeof payload.id === "string" ? payload.id : "";
        const type = typeof payload.type === "string" ? payload.type : "";
        const found = await assetStore.get({ id, type });
        if (found === undefined) return fail("not-found", "找不到这张图片");
        return ok({
          data: Buffer.from(found.bytes).toString("base64"),
          type: found.type,
        });
      },

      /** 删一张图片。 */
      async "assets.remove"(payload) {
        const assetStore = await assetReady;
        if (assetStore === undefined) return fail("disposed", "插件已卸载");
        const id = typeof payload.id === "string" ? payload.id : "";
        const type = typeof payload.type === "string" ? payload.type : "";
        await assetStore.remove({ id, type });
        return ok({ removed: id });
      },

      /**
       * 导出图片包：把一份文档用到的所有图片按名字打包返回。
       *
       * 为什么不让浏览器逐张下载：一次导出十几张图会触发浏览器的
       * "多文件下载"拦截，而且用户还得自己归到一个目录里。
       * 这里直接返回 {文件名: base64} 映射，由前端合成一次下载提示。
       */
      async "assets.export"(payload) {
        const store = await need();
        const assetStore = await assetReady;
        if (store === undefined || assetStore === undefined) return fail("disposed", "插件已卸载");
        const id = typeof payload.id === "string" ? payload.id : "";
        const doc = store.get(id);
        if (doc === undefined) return fail("not-found", "找不到这份导图：" + id);

        const images = collectImages(doc.root);
        const files: Array<{ name: string; data: string; type: string }> = [];
        for (const image of images) {
          const found = await assetStore.get(image);
          if (found === undefined) continue;
          files.push({
            name: image.name,
            type: found.type,
            data: Buffer.from(found.bytes).toString("base64"),
          });
        }
        return ok({ files, count: files.length });
      },

      /** 图片诊断：目录里有多少文件、文档里引用多少张（排查"图不见了"用）。 */
      async "assets.info"() {
        const store = await need();
        const assetStore = await assetReady;
        if (store === undefined || assetStore === undefined) return fail("disposed", "插件已卸载");
        const referenced = new Set<string>();
        let total = 0;
        for (const summary of store.list()) {
          const doc = store.get(summary.id);
          if (doc === undefined) continue;
          total += countImages(doc.root);
          for (const image of collectImages(doc.root)) referenced.add(image.id);
        }
        return ok({
          dir: assetStore.dir(),
          files: await assetStore.count(),
          referenced: referenced.size,
          total,
        });
      },

      /** 服务端导出：命令与"下载 .md"都用它，保证两边字节一致。 */
      async "docs.markdown"(payload) {
        const store = await need();
        if (store === undefined) return fail("disposed", "插件已卸载");
        const id = typeof payload.id === "string" ? payload.id : "";
        const doc = store.get(id);
        if (doc === undefined) return fail("not-found", "找不到这份导图：" + id);
        const mode: MarkdownMode = payload.mode === "list" ? "list" : "headings";
        const markdown = toMarkdown(doc.root, {
          mode,
          includeNotes: payload.includeNotes !== false,
          includeTitle: payload.includeTitle === true,
          title: doc.title,
        });
        return ok({ markdown, title: doc.title, mode });
      },
    };

    /** 未知方法 / 抛错都收敛成 RpcFail。 */
    const dispatch = async (endpoint: string, payload: Record<string, unknown>) => {
      const handler = endpoints[endpoint];
      if (handler === undefined) return fail("unknown-method", "未知方法：" + endpoint);
      try {
        return await handler(payload);
      } catch (error) {
        logger.warn("端点 " + endpoint + " 抛错", error);
        return fail("internal", (error as Error).message);
      }
    };

    // ---- RPC 通道 ----
    ctx.inject(["connection", "webServer"], (web) => {
      if (disposed) return;
      const webServer = web.webServer;
      const conn = web.connection;
      if (webServer === undefined || typeof webServer.register !== "function") {
        logger.warn("webServer 不可用，导图存储通道未注册");
        return;
      }
      if (conn === undefined || typeof conn.requestRejection !== "function") {
        logger.warn("connection.requestRejection 不可用，导图存储通道未注册");
        return;
      }
      disposeRpc = web.effect(
        () =>
          webServer.register({
            kind: "prefix",
            path: CHANNEL,
            async handler(req: IncomingLike, res: OutgoingLike) {
              const rejection = conn.requestRejection?.(req);
              if (rejection !== undefined) {
                res.writeHead(rejection);
                res.end(rejection === 401 ? "unauthorized" : "forbidden");
                return;
              }
              const chunks: Buffer[] = [];
              try {
                for await (const chunk of req) chunks.push(chunk as Buffer);
              } catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "failed to read request body" }));
                return;
              }
              let rpcId = "";
              let method = "";
              let payload: Record<string, unknown> = {};
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
                rpcId = typeof parsed.rpcId === "string" ? parsed.rpcId : "";
                method = typeof parsed.method === "string" ? parsed.method : "";
                payload =
                  parsed.payload !== null && typeof parsed.payload === "object"
                    ? (parsed.payload as Record<string, unknown>)
                    : {};
              } catch {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "body is not JSON" }));
                return;
              }
              const result = await dispatch(method, payload);
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ type: "server-response", rpcId, result }));
            },
          }),
        "mindmap rpc channel",
      );
      logger.info("导图存储通道已注册：" + CHANNEL);
    });

    // ---- 命令 ----
    if (ctx.commands !== undefined && typeof ctx.commands.register === "function") {
      disposeCommand = ctx.commands.register({
        name: "mindmap",
        description: "思维导图：列出 / 查看 / 导出成 Markdown（画图在左侧面板「思维导图」里）",
        input: { hint: "list | show <id> | markdown <id> [headings|list] | new <标题> | rm <id>" },
        async handler(invocation) {
          const store = await need();
          if (store === undefined) return { kind: "error", text: "插件已卸载" };
          const raw = String(invocation?.rawInput ?? "").trim();
          const verb = (raw.split(/\s+/)[0] ?? "").toLowerCase();
          const rest = raw.slice(verb.length).trim();

          if (verb === "" || verb === "list" || verb === "ls") {
            const docs = store.list();
            if (docs.length === 0) {
              return {
                kind: "success",
                text: [
                  "还没有任何导图。",
                  "在左侧面板点「思维导图」进去新建，或者：",
                  "  /mindmap new 我的第一张图",
                  "存储位置：" + store.file(),
                ].join("\n"),
              };
            }
            return {
              kind: "success",
              text: [
                "共 " + String(docs.length) + " 份导图（" + store.file() + "）：",
                ...docs.map((doc) => {
                  const when = new Date(doc.updatedAt).toLocaleString();
                  return "  " + doc.id + "  " + doc.title + "  (" + String(doc.nodeCount) + " 节点, " + when + ")";
                }),
                "",
                "用 /mindmap show <id> 看结构，/mindmap markdown <id> 导出 Markdown。",
              ].join("\n"),
            };
          }

          if (verb === "new") {
            try {
              const doc = await store.create(rest);
              return {
                kind: "success",
                text: "已新建导图「" + doc.title + "」（" + doc.id + "）。\n到左侧面板「思维导图」里打开它继续加节点。",
              };
            } catch (error) {
              return { kind: "error", text: (error as Error).message };
            }
          }

          if (verb === "rm" || verb === "delete") {
            const removed = await store.remove(rest);
            return removed
              ? { kind: "success", text: "已删除：" + rest }
              : { kind: "error", text: "找不到这份导图：" + rest };
          }

          if (verb === "show") {
            const doc = store.get(rest);
            if (doc === undefined) return { kind: "error", text: "找不到这份导图：" + rest };
            // show 用 list 形态：它就是给人看结构的，比一堆 # 更适合终端
            return { kind: "success", text: "「" + doc.title + "」\n\n" + toMarkdown(doc.root, { mode: "list" }) };
          }

          if (verb === "markdown" || verb === "md") {
            const [id, modeToken] = rest.split(/\s+/);
            const doc = store.get(id ?? "");
            if (doc === undefined) return { kind: "error", text: "找不到这份导图：" + (id ?? "") };
            const mode: MarkdownMode = modeToken === "list" ? "list" : "headings";
            return {
              kind: "success",
              text: toMarkdown(doc.root, {
                mode,
                includeNotes: true,
                includeTitle: true,
                title: doc.title,
              }),
            };
          }

          return {
            kind: "error",
            text: [
              "未知子命令「" + verb + "」。可用：",
              "  /mindmap list                          列出全部导图",
              "  /mindmap show <id>                     用大纲看结构",
              "  /mindmap markdown <id> [headings|list] 导出 Markdown（默认 headings）",
              "  /mindmap new <标题>                    新建一份",
              "  /mindmap rm <id>                       删除一份",
            ].join("\n"),
          };
        },
      });
    }

    /*
     * 启动对账：把磁盘上不再被任何文档引用的图片删掉。
     *
     * 为什么需要：删节点、删文档都只改了 JSON，图片字节还在。用户反复
     * 增删几十张图之后，assets 目录只涨不跌。这里在读完全部文档后做一次
     * 全量对账，代价是一次 readdir，可以接受。
     *
     * 失败不能影响插件加载：图片清理是个后台杂务，出问题最多留几个孤儿文件。
     */
    void (async () => {
      try {
        const store = await ready;
        const assetStore = await assetReady;
        if (store === undefined || assetStore === undefined || disposed) return;
        const referenced = referencedImageIds(store);
        const removed = await assetStore.reconcile(referenced);
        if (removed > 0) logger.info("启动时清理了 " + String(removed) + " 个孤儿图片文件");
      } catch (error) {
        logger.warn("启动图片对账失败（不影响使用）", error);
      }
    })();

    logger.info("已挂载，存储文件 " + storageFile());

    return () => {
      disposed = true;
      for (const disposer of [disposeRpc, disposeCommand]) {
        if (typeof disposer === "function") {
          try {
            (disposer as () => unknown)();
          } catch (error) {
            logger.warn("卸载清理失败", error);
          }
        }
      }
      void ready.finally(() => undefined);
    };
  }, "mindmap host");
}
