/**
 * dsh-mindmap — 图片资产存储（Host 半区）。
 *
 * 字节落盘，元数据前进文档 JSON。为什么这么分：
 *   把 base64 塞进 `dsh-mindmap.json` 会让存储文件迅速膨胀——用户放十张
 *   手机照片就是几十 MB，而这份 JSON 每次保存都要整份序列化一遍，编辑
 *   会越来越卡。所以图片单独存 `storages/dsh-mindmap-assets/<id>.<ext>`，
 *   文档里只留 id / 尺寸 / 说明。
 *
 * 三条安全约束（都会直接拼进磁盘路径，必须守住）：
 *   1. id 白名单 `[A-Za-z0-9._-]{1,80}`：挡住 `../` 之类的路径穿越；
 *   2. MIME 白名单：只收 png/jpeg/gif/webp，不接受 svg（可含脚本）；
 *   3. 单张大小上限：挡住宿主被一个超大文件拖死。
 *
 * 孤儿清理：删节点 / 删文档时同步删文件。文档里不再引用的资产在
 * 「整份保存」后做一次对账（reconcile），把多余文件删掉——否则用户
 * 反复删改，assets 目录会只涨不跌。
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { IMAGE_TYPES, MAX_IMAGE_BYTES, type NodeImage } from "./core/tree.ts";

/** assets 目录名（与 dsh-mindmap.json 同级的子目录）。 */
export const ASSETS_DIR = "dsh-mindmap-assets";

/** id 合法性的唯一判据：它会被拼进文件名。 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,80}$/;

/** MIME → 扩展名。 */
const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** 扩展名 → MIME（读盘时反查，用于回给浏览器正确的 Content-Type）。 */
const TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** 判断 id 是否可以安全地当文件名用。 */
export function isSafeImageId(id: string): boolean {
  return SAFE_ID.test(id);
}

/** 判断 MIME 是否受支持。 */
export function isSupportedImageType(type: string): boolean {
  return (IMAGE_TYPES as readonly string[]).includes(type);
}

/** 图片在磁盘上的绝对路径；id 非法或类型未知时返回 undefined。 */
export function assetPath(dir: string, image: { id: string; type: string }): string | undefined {
  if (!isSafeImageId(image.id)) return undefined;
  const ext = EXT_BY_TYPE[image.type];
  if (ext === undefined) return undefined;
  return join(dir, image.id + "." + ext);
}

/**
 * 从磁盘字节里探明真实格式。
 *
 * 为什么不信任客户端给的 MIME：扩展名/MIME 是客户端说的，文件内容是客观的。
 * 只看魔数，既能让 Content-Type 正确，也顺带挡住"改个后缀就变成可执行文件"
 * 那类玩法。
 * @returns 探测到的 MIME，认不出返回 undefined。
 */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8) {
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return "image/png";
    }
    // GIF: "GIF8"
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
      return "image/gif";
    }
    // RIFF....WEBP
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return undefined;
}

/** 解析 PNG / GIF / WebP / JPEG 的像素尺寸（不解码整张图，只读头部）。 */
export function readImageSize(bytes: Uint8Array, type: string): { width: number; height: number } | undefined {
  try {
    if (type === "image/png" && bytes.length >= 24) {
      // IHDR 紧跟在 8 字节签名 + 4 字节长度 + 4 字节类型之后
      const width = readUInt32BE(bytes, 16);
      const height = readUInt32BE(bytes, 20);
      if (width > 0 && height > 0) return { width, height };
    }
    if (type === "image/gif" && bytes.length >= 10) {
      const width = bytes[6]! | (bytes[7]! << 8);
      const height = bytes[8]! | (bytes[9]! << 8);
      if (width > 0 && height > 0) return { width, height };
    }
    if (type === "image/jpeg") {
      // 扫 SOF 段：C0-CF 里除去 C4/C8/CC 的都是帧头
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1]!;
        const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
        if (length < 2) break;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
          const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
          if (width > 0 && height > 0) return { width, height };
        }
        offset += 2 + length;
      }
    }
    if (type === "image/webp" && bytes.length >= 30) {
      const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
      // VP8X（扩展格式）：画布尺寸存 24 位小端，值是"实际尺寸 - 1"
      if (chunk === "VP8X") {
        const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
        const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
        if (width > 0 && height > 0) return { width, height };
      }
      // VP8（有损）：帧头 3 字节起始码 9D 01 2A 之后是 16 位宽高（低 14 位有效）
      if (chunk === "VP8 ") {
        /*
         * 布局：RIFF(4) size(4) WEBP(4) 'VP8 '(4) chunkSize(4) = 20 字节，
         * 之后是 3 字节帧标签，再是起始码 9D 01 2A（偏移 23..25），
         * 宽高各 16 位（低 14 位有效）从偏移 26 开始。
         */
        if (bytes.length > 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
          const width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
          const height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
          if (width > 0 && height > 0) return { width, height };
        }
      }
      // VP8L（无损）：签名 0x2F 之后按 14 位打包
      if (chunk === "VP8L" && bytes[20] === 0x2f) {
        const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >> 14) & 0x3fff) + 1;
        if (width > 0 && height > 0) return { width, height };
      }
    }
  } catch {
    /* 头部残缺就当尺寸未知，不影响存盘 */
  }
  return undefined;
}

/** 读 32 位大端整数。 */
function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!
  );
}

/** 图片存储句柄。 */
export interface AssetStore {
  /** assets 目录绝对路径。 */
  dir(): string;
  /**
   * 存一张图片。
   * @param id - 客户端生成的 id（会校验）。
   * @param declaredType - 客户端声明的 MIME（只作参考，最终以魔数为准）。
   * @param bytes - 图片字节。
   * @returns 写好的元数据；校验失败返回 undefined 并带原因。
   */
  put(
    id: string,
    declaredType: string,
    bytes: Uint8Array,
  ): Promise<{ ok: true; image: NodeImage } | { ok: false; reason: string }>;
  /** 读一张图片的字节与 MIME。 */
  get(image: { id: string; type: string }): Promise<{ bytes: Uint8Array; type: string } | undefined>;
  /** 删一张图片（不存在视为成功）。 */
  remove(image: { id: string; type: string }): Promise<boolean>;
  /**
   * 对账：删掉 assets 目录里不再被任何文档引用的文件。
   * @param referenced - 当前所有文档引用到的图片 id 集合。
   * @returns 删掉的文件数。
   */
  reconcile(referenced: Set<string>): Promise<number>;
  /** 目录里现有文件数（诊断用）。 */
  count(): Promise<number>;
}

/**
 * 打开图片存储。
 * @param storagesDir - `storages` 目录（assets 会建在它下面）。
 */
export async function openAssetStore(storagesDir: string, logger?: { info(...a: unknown[]): void; warn(...a: unknown[]): void }): Promise<AssetStore> {
  const dir = join(storagesDir, ASSETS_DIR);
  const log = logger ?? { info: () => undefined, warn: () => undefined };

  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    log.warn("无法创建图片目录", dir, error);
  }

  return {
    dir() {
      return dir;
    },

    async put(id, declaredType, bytes) {
      if (!isSafeImageId(id)) return { ok: false, reason: "图片 id 不合法" };
      if (bytes.length === 0) return { ok: false, reason: "图片是空的" };
      if (bytes.length > MAX_IMAGE_BYTES) {
        return { ok: false, reason: "图片太大（上限 " + String(Math.round(MAX_IMAGE_BYTES / 1024 / 1024)) + " MB）" };
      }
      if (!isSupportedImageType(declaredType)) {
        return { ok: false, reason: "不支持的图片格式（只接受 PNG / JPEG / GIF / WebP）" };
      }
      // 以魔数为准：客户端说的类型只用来交叉校验
      const actual = sniffImageType(bytes);
      if (actual === undefined) return { ok: false, reason: "认不出这个文件是不是图片" };
      if (actual !== declaredType) {
        log.warn("图片类型与内容不符，按内容为准", { declared: declaredType, actual });
      }

      const info = readImageSize(bytes, actual);
      const target = assetPath(dir, { id, type: actual });
      if (target === undefined) return { ok: false, reason: "无法为这张图片生成路径" };

      // 原子写：先临时文件再 rename，避免读到半张图
      const temp = target + ".tmp-" + String(process.pid) + "-" + String(Date.now());
      try {
        await writeFile(temp, bytes);
        await rename(temp, target);
      } finally {
        await rm(temp, { force: true }).catch(() => undefined);
      }

      const image: NodeImage = { id, type: actual, name: id + "." + (EXT_BY_TYPE[actual] ?? "bin") };
      if (info !== undefined) {
        image.width = info.width;
        image.height = info.height;
      }
      return { ok: true, image };
    },

    async get(image) {
      const target = assetPath(dir, image);
      if (target === undefined) return undefined;
      try {
        const bytes = await readFile(target);
        const ext = target.slice(target.lastIndexOf(".") + 1).toLowerCase();
        return { bytes: new Uint8Array(bytes), type: TYPE_BY_EXT[ext] ?? image.type };
      } catch {
        return undefined;
      }
    },

    async remove(image) {
      const target = assetPath(dir, image);
      if (target === undefined) return false;
      try {
        await rm(target, { force: true });
        return true;
      } catch {
        return false;
      }
    },

    async reconcile(referenced) {
      let removed = 0;
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        return 0;
      }
      for (const file of files) {
        if (file.includes(".tmp-")) {
          // 上次崩溃留下的临时文件
          await rm(join(dir, file), { force: true }).catch(() => undefined);
          removed += 1;
          continue;
        }
        const dot = file.lastIndexOf(".");
        const id = dot > 0 ? file.slice(0, dot) : file;
        if (!referenced.has(id)) {
          await rm(join(dir, file), { force: true }).catch(() => undefined);
          removed += 1;
        }
      }
      if (removed > 0) log.info("清理了 " + String(removed) + " 个不再引用的图片文件");
      return removed;
    },

    async count() {
      try {
        return (await readdir(dir)).length;
      } catch {
        return 0;
      }
    },
  };
}
