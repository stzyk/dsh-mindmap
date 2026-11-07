#!/usr/bin/env python3
"""dsh-mindmap 浏览器冒烟（Playwright / headless chromium）。

覆盖的验收项：

  1  侧边栏出现「思维导图」图标
  2  点图标进到面板，空态可见
  3  新建一份导图 → 画布出中心节点
  4  键盘流：Enter 加同级 / Tab 缩进 / 方向键移动
  5  改节点文字（双击进入编辑）
  6  保存到 Host：刷新页面后数据仍在（证明是 Host 持久化，不是内存）
  7  转 Markdown 面板：标题形态输出正确
  8  切到列表形态 → 输出变化符合预期
  9  复制按钮 / 下载按钮可用
  10 返回列表，删除文档后列表归零
  11 控制台无插件自身报错

用法：
    python3 verify/smoke.py <带 token 的 URL> [截图目录]

退出码：0 = 全部通过；1 = 有失败项。每项打印 PASS/FAIL，失败绝不静默。
"""
import json
import os
import sys
import traceback

from playwright.sync_api import sync_playwright

DEFAULT_OUT = "/Users/mumu/projects/public/dsh-mindmap/verify/screenshots"
PLUGIN_ID = "dsh-mindmap"

results: list[dict] = []


def record(key: str, name: str, ok: bool, detail: str = "") -> None:
    results.append({"key": key, "name": name, "ok": bool(ok), "detail": detail})
    mark = "PASS  " if ok else "FAIL  "
    print(mark + key + " " + name + ("  —— " + detail if detail else ""), flush=True)


class Page:
    def __init__(self, page, out_dir: str):
        self.page = page
        self.out = out_dir
        # 测试开始前就存在的文档 id。
        #
        # reset_workspace() 会清空列表重新开始，但它**只能删测试自己建的**。
        # 早先它无差别删掉所有文档，把用户的真实导图一起清空了两次 ——
        # 测试工具毁数据是不可接受的，所以先把"别人的"记下来。
        self.foreign_ids = set()
        # 是否成功识别出"哪些是既有文档"。
        # 采集失败时**一律不删**——宁可不清理，也不能误删用户数据。
        self.foreign_ok = False

    def shot(self, name: str) -> str:
        os.makedirs(self.out, exist_ok=True)
        path = os.path.join(self.out, name + ".png")
        self.page.screenshot(path=path, full_page=False)
        print("SHOT  " + path, flush=True)
        return path

    def state(self):
        return self.page.evaluate("window.__mindmap ? window.__mindmap.state() : null")

    def tree_sig(self) -> list:
        """当前文档的树签名（"深度:文字" 列表），用于比较前后状态。"""
        return self.page.evaluate("""() => {
            const s = window.__mindmap.state();
            const out = [];
            const walk = (n, d) => { out.push(d + ':' + n.text); n.children.forEach(c => walk(c, d + 1)); };
            walk(s.doc.root, 0);
            return out;
        }""")

    def reset_workspace(self, title: str = "冒烟测试导图") -> None:
        """把工作区恢复成"一份干净的、只有一个根节点的文档"，并停在画布上。

        为什么需要：冒烟按顺序跑十几段，任何一段失败都会让后续段落从一个
        意外的状态开始（停在 Markdown 面板、选中的是别的节点、树里多了图片…）。
        那样后续的失败全是"被前面连累"，看不出真正的问题。每段开头调这个，
        失败就被限制在它自己那一格里。
        """
        if not self.foreign_ok:
            # 不知道哪些是用户的，就不能开始删
            raise RuntimeError("未能识别既有文档，拒绝执行会删除文档的 reset（保护用户数据）")
        self.page.evaluate("""async (args) => {
            const st = window.__mindmap.state();
            const foreign = new Set(args.foreign);
            for (const d of st.docs) {
                // 只删测试自己建的：用户的真实导图必须原样留着
                if (foreign.has(d.id)) continue;
                await fetch('/mindmap/docs.remove', {method:'POST',
                    headers:{'content-type':'application/json'},
                    body: JSON.stringify({type:'client-request', rpcId:'reset-'+d.id,
                        method:'docs.remove', payload:{id:d.id}})});
            }
            await window.__mindmap.create(args.title);
        }""", {"title": title, "foreign": sorted(self.foreign_ids)})
        # 诊断：确认 reset 之后既有文档还在
        left = self.page.evaluate(
            """(f) => {
                const s = window.__mindmap.state();
                const set = new Set(f);
                return s.docs.filter(d => set.has(d.id)).map(d => d.title);
            }""",
            sorted(self.foreign_ids),
        )
        if self.foreign_ids and len(left) != len(self.foreign_ids):
            print(
                f"WARN  reset 之后既有文档只剩 {len(left)}/{len(self.foreign_ids)}：{left}",
                flush=True,
            )
        self.page.wait_for_selector(".mm-node", timeout=20000)
        self.page.wait_for_timeout(900)

    def open_panel(self) -> str:
        """点侧边栏的「思维导图」图标。返回使用的定位方式。"""
        # 隔离实例（独立 DSH_HOME）刷新后会再次弹出 "Get started"，
        # 它的遮罩会挡住侧边栏。每次打开面板前先尝试关掉，没有就是 no-op。
        try:
            self.page.evaluate("""() => {
                const m = document.querySelector('._mask_o6lrb_18');
                if (m) m.click();
                const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '×');
                if (btn) btn.click();
            }""")
            self.page.wait_for_timeout(400)
        except Exception:
            pass
        # 侧边栏面板行的 aria-label 就是面板 label
        candidates = [
            self.page.get_by_role("button", name="思维导图", exact=True),
            self.page.locator('[aria-label="思维导图"]'),
            self.page.locator("button", has_text="思维导图"),
        ]
        for locator in candidates:
            try:
                if locator.count() > 0:
                    locator.first.click(timeout=6000)
                    self.page.wait_for_timeout(1200)
                    return str(locator)
            except Exception:
                continue
        raise RuntimeError("侧边栏找不到「思维导图」入口")


def main() -> int:
    url = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT

    console_errors: list[str] = []

    with sync_playwright() as p:
        # 优先用系统安装的 Chrome：Playwright 自带的 Chromium 需要额外下载，
        # 在受限网络下经常装不下来（实测走 CDN / npmmirror 都会卡住）。
        try:
            browser = p.chromium.launch(channel="chrome", headless=True)
        except Exception:
            browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1500, "height": 950})
        page = ctx.new_page()

        def on_console(msg):
            if msg.type == "error":
                console_errors.append(f"{msg.type}: {msg.text}"[:400])

        def on_pageerror(err):
            console_errors.append("PAGEERROR: " + str(err)[:400])

        page.on("console", on_console)
        page.on("pageerror", on_pageerror)

        page.goto(url, wait_until="load", timeout=90000)
        # 不用 networkidle：DSH Web 常驻 SSE/长连接，networkidle 永远不会出现，
        # 等待条件本身就是错的。改成等根节点出现再给一段固定热身时间。
        try:
            page.wait_for_selector(".mm-root, #root, body", timeout=30000)
        except Exception:
            pass
        page.wait_for_timeout(6000)
        pg = Page(page, out_dir)
        # 隔离实例（独立 DSH_HOME）首次运行会弹 "Get started"，先关掉。
        # 用真实 profile 跑时没有这个弹窗，这段是无害的 no-op。
        try:
            page.evaluate("""() => {
                const m = document.querySelector('._mask_o6lrb_18');
                if (m) m.click();
                const btn = [...document.querySelectorAll('button')].find(b => (b.textContent||'').trim() === '×');
                if (btn) btn.click();
            }""")
            page.wait_for_timeout(800)
        except Exception:
            pass
        pg.shot("00-initial")


        # ---------- 1 侧边栏图标 ----------
        try:
            has = page.evaluate("typeof window.__mindmap === 'object' && window.__mindmap !== null")
            record("1a", "调试句柄 __mindmap 存在（插件已加载）", has)
        except Exception as exc:
            record("1a", "调试句柄 __mindmap 存在（插件已加载）", False, str(exc)[:200])

        try:
            locator_used = pg.open_panel()
            record("1", "侧边栏图标可点开「思维导图」面板", True, locator_used[:120])

            # 面板打开后才有 window.__mindmap，此时才能读到既有文档。
            # （早先放在打开面板之前采集，异常被吞掉 -> 当成"列表为空"
            #  -> 收尾清理把用户的真实导图全删了。踩过两次。）
            try:
                pg.foreign_ids = {
                    d["id"] for d in (page.evaluate("window.__mindmap.state().docs") or [])
                }
                pg.foreign_ok = True
                if pg.foreign_ids:
                    print(
                        f"NOTE  发现 {len(pg.foreign_ids)} 份既有文档，测试期间会保留",
                        flush=True,
                    )
            except Exception as exc:
                pg.foreign_ok = False
                print(f"WARN  无法识别既有文档，本次不做清理：{exc}", flush=True)
        except Exception as exc:
            record("1", "侧边栏图标可点开「思维导图」面板", False, str(exc)[:200])
            pg.shot("01-panel-fail")
            return finish(browser, console_errors)

        pg.shot("01-panel-list")

        # ---------- 2 空态 ----------
        try:
            empty = page.locator("[data-mm-empty='true']").count() > 0 or page.locator(".mm-doc").count() > 0
            record("2", "面板渲染出内容（空态或列表）", empty)
        except Exception as exc:
            record("2", "面板渲染出内容（空态或列表）", False, str(exc)[:200])

        # ---------- 3 新建 ----------
        try:
            # 清掉**测试自己建的**，保证从干净状态开始。
            #
            # 这里早先是无差别删光所有文档，会把用户的真实导图一起清掉
            # （本项目已经因此丢过三次数据）。只删不在 foreign_ids 里的。
            # 走 docs.remove（而不是直接改文件）：这样服务端的图片清理逻辑
            # 也会跑到，不会给下一次测试留下孤儿图片文件。
            if not pg.foreign_ok:
                raise RuntimeError("未能识别既有文档，拒绝执行会删除文档的清理")
            page.evaluate("""async (foreign) => {
                const st = window.__mindmap.state();
                const f = new Set(foreign);
                for (const d of st.docs) {
                    if (f.has(d.id)) continue;
                    await fetch('/mindmap/docs.remove', {
                        method: 'POST', headers: {'content-type':'application/json'},
                        body: JSON.stringify({type:'client-request', rpcId:'clean-'+d.id,
                            method:'docs.remove', payload:{id:d.id}})
                    });
                }
            }""", sorted(pg.foreign_ids))
            page.reload(wait_until="load", timeout=90000)
            page.wait_for_timeout(2000)
            pg.open_panel()

            page.fill('input[aria-label="新导图标题"]', "冒烟测试导图")
            page.click('[data-mm-action="create"]')
            page.wait_for_selector(".mm-node", timeout=15000)
            count = page.locator(".mm-node").count()
            record("3", "新建导图后画布出现中心节点", count >= 1, f"节点数={count}")
            pg.shot("02-new-doc")
        except Exception as exc:
            record("3", "新建导图后画布出现中心节点", False, str(exc)[:200])
            pg.shot("02-new-doc-fail")
            return finish(browser, console_errors)

        # ---------- 4 键盘流 ----------
        try:
            # 点中心节点选中 → Enter 加同级（根节点的兄弟会变成子节点）
            page.locator(".mm-node").first.click()
            page.wait_for_timeout(300)
            page.locator(".mm-canvas").first.click(position={"x": 5, "y": 5})
            page.wait_for_timeout(200)
            page.locator(".mm-node").first.click()
            page.keyboard.press("Enter")
            page.wait_for_timeout(500)
            # 新节点进入编辑态，输入文字后回车
            page.keyboard.type("第一个分支")
            page.keyboard.press("Enter")
            page.wait_for_timeout(600)
            after_enter = page.locator(".mm-node").count()

            record("4a", "Enter 加出同级节点", after_enter >= 2, f"节点数={after_enter}")

            def tree_flat():
                return page.evaluate("""() => {
                    const st = window.__mindmap.state();
                    const flat = [];
                    const walk = (n, d) => { flat.push({id:n.id, text:n.text, depth:d}); n.children.forEach(c => walk(c, d+1)); };
                    walk(st.doc.root, 0);
                    return flat;
                }""")

            # ---------- 4b Tab = 加子节点 ----------
            # 上一版 Tab 是"缩进"、且真正加子节点的 addChild() 没有任何入口，
            # 用户按 Tab 期望出子节点却什么都不发生。这条断言锁死新语义。
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            before = tree_flat()
            before_count = len(before)
            before_max_depth = max(n["depth"] for n in before)

            # 选中一个节点后按 Tab
            page.locator(".mm-node").first.click()
            page.wait_for_timeout(250)
            page.keyboard.press("Tab")
            page.wait_for_timeout(600)
            page.keyboard.type("子节点文字")
            page.keyboard.press("Enter")
            page.wait_for_timeout(600)

            after = tree_flat()
            added = [n for n in after if n["text"] == "子节点文字"]
            record(
                "4b",
                "Tab 加出子节点（深度 +1，不再是缩进）",
                len(after) > before_count
                and len(added) == 1
                and added[0]["depth"] == before_max_depth,
                f"节点数 {before_count}→{len(after)}，新节点 depth={added[0]['depth'] if added else 'N/A'}",
            )

            # ---------- 4c Shift+Tab 减一级（大纲直觉保留） ----------
            # 注意：depth=1 的节点**不能**再 outdent —— 它的父是根，根没有兄弟，
            # 层面在语义上已经到底。必须用一个 depth>=2 的节点来验，
            # 否则测的是"边界拒绝"而不是"减少缩进生效"。
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            if added:
                # 在刚才加出的子节点上再挂一层，造出一个 depth=2 的节点
                page.locator(f'[data-node-id="{added[0]["id"]}"]').click()
                page.wait_for_timeout(250)
                page.keyboard.press("Tab")
                page.wait_for_timeout(600)
                page.keyboard.type("孙节点")
                page.keyboard.press("Enter")
                page.wait_for_timeout(600)
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)

                grand = [n for n in tree_flat() if n["text"] == "孙节点"]
                if not grand:
                    record("4c", "Shift+Tab 减少一级缩进", False, "没能造出 depth=2 的节点")
                else:
                    depth_before = grand[0]["depth"]
                    page.locator(f'[data-node-id="{grand[0]["id"]}"]').click()
                    page.wait_for_timeout(250)
                    page.keyboard.press("Shift+Tab")
                    page.wait_for_timeout(700)
                    still = [n for n in tree_flat() if n["id"] == grand[0]["id"]]
                    depth_after = still[0]["depth"] if still else -1
                    record(
                        "4c",
                        "Shift+Tab 减少一级缩进（depth>=2 才可减）",
                        bool(still) and depth_after < depth_before,
                        f"depth {depth_before}→{depth_after}",
                    )

                    # ---------- 4c2 边界：depth=1 的节点 Shift+Tab 应被拒绝而不是崩 ----------
                    page.keyboard.press("Escape")
                    page.wait_for_timeout(200)
                    top_level = [n for n in tree_flat() if n["depth"] == 1]
                    if top_level:
                        page.locator(f'[data-node-id="{top_level[0]["id"]}"]').click()
                        page.wait_for_timeout(250)
                        d_before = top_level[0]["depth"]
                        page.keyboard.press("Shift+Tab")
                        page.wait_for_timeout(500)
                        node_now = [n for n in tree_flat() if n["id"] == top_level[0]["id"]]
                        record(
                            "4c2",
                            "第一层节点 Shift+Tab 被安全拒绝（不崩、不消失）",
                            bool(node_now) and node_now[0]["depth"] == d_before,
                            f"depth 保持 {d_before}",
                        )
                    else:
                        record("4c2", "第一层节点 Shift+Tab 被安全拒绝（不崩、不消失）", False, "没有第一层节点")
            else:
                record("4c", "Shift+Tab 减少一级缩进（depth>=2 才可减）", False, "上一步没加出子节点")
                record("4c2", "第一层节点 Shift+Tab 被安全拒绝（不崩、不消失）", False, "上一步没加出子节点")

            # ---------- 4d 鼠标按钮也能加（入口可见性） ----------
            try:
                page.keyboard.press("Escape")
                page.wait_for_timeout(200)
                page.locator(".mm-node").first.click()
                page.wait_for_timeout(250)
                count_before_btn = page.locator(".mm-node").count()
                # 工具条按钮已移除（v0.15.1），加子节点改用 Tab
                # 点空白现在会取消选中（v0.16.0），所以直接点节点：
                # 既选中又让画布拿到焦点，然后 Tab 才有意义
                page.locator(".mm-node").first.click()
                page.wait_for_timeout(300)
                page.keyboard.press("Tab")
                page.wait_for_timeout(600)
                page.keyboard.press("Escape")
                page.wait_for_timeout(300)
                count_after_btn = page.locator(".mm-node").count()
                record(
                    "4d",
                    "「+ 子节点」按钮可用（鼠标用户有入口）",
                    count_after_btn > count_before_btn,
                    f"节点数 {count_before_btn}→{count_after_btn}",
                )
            except Exception as exc:
                record("4d", "「+ 子节点」按钮可用（鼠标用户有入口）", False, str(exc)[:200])

            pg.shot("03-keyboard-flow")
        except Exception as exc:
            for key, name in [
                ("4a", "Enter 加出同级节点"),
                ("4b", "Tab 加出子节点（深度 +1，不再是缩进）"),
                ("4c", "Shift+Tab 减少一级缩进（depth>=2 才可减）"),
                ("4c2", "第一层节点 Shift+Tab 被安全拒绝（不崩、不消失）"),
                ("4d", "「+ 子节点」按钮可用（鼠标用户有入口）"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("03-keyboard-fail")

        # ---------- 5 双击改文字 ----------
        try:
            node = page.locator(".mm-node").nth(1)
            node.dblclick()
            page.wait_for_timeout(400)
            editor = page.locator(".mm-node-input")
            visible_editor = editor.count() > 0
            if visible_editor:
                editor.first.fill("改过的文字")
                editor.first.press("Enter")
                page.wait_for_timeout(600)
            texts = page.evaluate("""() => {
                const st = window.__mindmap.state();
                const out = [];
                const walk = (n) => { out.push(n.text); n.children.forEach(walk); };
                walk(st.doc.root);
                return out;
            }""")
            record("5", "双击进入编辑并改文字生效", "改过的文字" in texts, json.dumps(texts, ensure_ascii=False)[:200])
            pg.shot("04-edited")
        except Exception as exc:
            record("5", "双击进入编辑并改文字生效", False, str(exc)[:200])

        # ---------- 5b 根节点可读性（对比度 + 输入可见） ----------
        # 为什么必须测这个：根节点曾经因为"把文字色当背景色"渲染成一整块纯黑，
        # 而所有功能断言（节点数、文字内容、Markdown 输出）全都照常通过。
        # 颜色错了只有人眼能看出——所以这里把"看得见"变成机器可判断的断言。
        try:
            contrast = page.evaluate("""() => {
                const parse = (c) => {
                    const m = c.match(/[0-9]+(?:[.][0-9]+)?/g);
                    return m ? m.slice(0, 3).map(Number) : null;
                };
                const lum = (rgb) => {
                    const f = rgb.map((v) => {
                        const s = v / 255;
                        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
                    });
                    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
                };
                const ratio = (a, b) => {
                    const l1 = lum(a), l2 = lum(b);
                    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
                };
                const root = document.querySelector('.mm-node[data-root="true"]');
                const span = root.querySelector('span');
                const rc = getComputedStyle(root);
                const sc = getComputedStyle(span);
                const out = {
                    rootBg: rc.backgroundColor,
                    rootColor: sc.color,
                    rootRatio: ratio(parse(sc.color), parse(rc.backgroundColor)),
                };
                // 顺带确认根节点不是"纯黑一整块"（背景与文字同色）
                out.isSolidBlack = (parse(rc.backgroundColor) || []).every((v) => v <= 8)
                    && (parse(sc.color) || []).every((v) => v >= 247);
                return out;
            }""")
            record(
                "5b",
                "根节点文字对比度足够（不会黑底黑字）",
                contrast["rootRatio"] >= 3.0,
                f"ratio={contrast['rootRatio']:.2f} bg={contrast['rootBg']} text={contrast['rootColor']}",
            )
            # 进入编辑态，确认输入的文字与编辑框底色也有足够对比
            # 先把它拉回确定状态：上一步可能停在别的节点的编辑态里，
            # 直接双击可能打在一个正在重渲染的节点上（真实使用里人不会这么快连点）
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            page.evaluate("() => window.__mindmap.edit(null)")
            page.wait_for_timeout(200)
            root_node = page.locator('.mm-node[data-root="true"]')
            if root_node.count() == 0:
                raise RuntimeError("画布上找不到根节点")
            root_node.click()
            page.wait_for_timeout(250)
            root_node.dblclick()
            page.wait_for_timeout(700)
            typing = page.evaluate("""() => {
                const i = document.querySelector('.mm-node-input');
                if (!i) return null;
                const cs = getComputedStyle(i);
                const parent = getComputedStyle(i.parentElement);
                const parse = (c) => { const m = c.match(/[0-9]+(?:[.][0-9]+)?/g); return m ? m.slice(0,3).map(Number) : null; };
                const lum = (rgb) => {
                    const f = rgb.map((v) => { const s = v/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); });
                    return 0.2126*f[0] + 0.7152*f[1] + 0.0722*f[2];
                };
                const ratio = (a,b) => { const l1=lum(a), l2=lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
                // 输入框本身透明时，实际可视底色是父节点的底色
                const bg = parse(cs.backgroundColor).every((v,i) => cs.backgroundColor === 'rgba(0, 0, 0, 0)') ? parent.backgroundColor : cs.backgroundColor;
                return { color: cs.color, bg, ratio: ratio(parse(cs.color), parse(bg)), focused: document.activeElement === i };
            }""")
            if typing is None:
                record("5c", "根节点编辑框文字可见", False, "找不到编辑框")
            else:
                record(
                    "5c",
                    "根节点编辑框文字可见（白底白字会在这里失败）",
                    typing["ratio"] >= 3.0,
                    f"ratio={typing['ratio']:.2f} text={typing['color']} bg={typing['bg']}",
                )
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            pg.shot("04b-contrast")
        except Exception as exc:
            record("5b", "根节点文字对比度足够（不会黑底黑字）", False, str(exc)[:200])
            record("5c", "根节点编辑框文字可见（白底白字会在这里失败）", False, str(exc)[:200])

        # ---------- 5d 拖动节点（自由摆放位置） ----------
        # 用真实指针事件拖，不能用 JS 直接改数据——那测不到"拖不动"这个 bug。
        try:
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            page.evaluate("() => window.__mindmap.edit(null)")
            page.wait_for_timeout(200)

            def node_box(nid):
                return page.evaluate(
                    """(id) => {
                        const el = document.querySelector('[data-node-id="' + id + '"]');
                        if (!el) return null;
                        const r = el.getBoundingClientRect();
                        return {x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height};
                    }""",
                    nid,
                )

            def node_pos(nid):
                return page.evaluate(
                    """(id) => {
                        const st = window.__mindmap.state();
                        let found = null;
                        const walk = (n) => { if (n.id === id) found = n; n.children.forEach(walk); };
                        walk(st.doc.root);
                        return found ? (found.position || null) : null;
                    }""",
                    nid,
                )

            # 找一个非根节点来拖（根节点单独测）
            ids = page.evaluate(
                """() => {
                    const st = window.__mindmap.state();
                    const out = [];
                    const walk = (n, d) => { out.push({id: n.id, depth: d}); n.children.forEach(c => walk(c, d+1)); };
                    walk(st.doc.root, 0);
                    return out;
                }"""
            )
            leaf = [n for n in ids if n["depth"] >= 1]
            if not leaf:
                record("5d", "拖动节点改变位置", False, "没有可拖的子节点")
            else:
                target = leaf[0]["id"]
                before = node_pos(target)
                box = node_box(target)
                # 真实拖拽：按下 → 分多步移动（模拟人手）→ 松开
                page.mouse.move(box["x"], box["y"])
                page.mouse.down()
                for step in range(1, 11):
                    page.mouse.move(box["x"] + step * 12, box["y"] + step * 7)
                    page.wait_for_timeout(25)
                page.mouse.up()
                page.wait_for_timeout(900)

                after = node_pos(target)
                moved_ok = after is not None and before is None
                record(
                    "5d",
                    "拖动子节点写入固定坐标（且不破坏结构）",
                    moved_ok,
                    f"position {before} → {after}",
                )

                # 拖完之后树结构不能变（位置不影响层级）
                still = page.evaluate(
                    """(id) => {
                        const st = window.__mindmap.state();
                        let found = null;
                        const walk = (n, d, parent) => { if (n.id === id) found = {depth: d, parent: parent ? parent.id : null}; n.children.forEach(c => walk(c, d+1, n)); };
                        walk(st.doc.root, 0, null);
                        return found;
                    }""",
                    target,
                )
                record(
                    "5d2",
                    "拖动不改变树的层级关系",
                    still is not None and still["depth"] == [n for n in ids if n["id"] == target][0]["depth"],
                    f"depth 仍是 {still['depth'] if still else 'N/A'}",
                )

                # 拖根节点：整棵树不能消失
                root_ids = [n for n in ids if n["depth"] == 0]
                if root_ids:
                    rid = root_ids[0]["id"]
                    rbox = node_box(rid)
                    nodes_before = page.locator(".mm-node").count()
                    page.mouse.move(rbox["x"], rbox["y"])
                    page.mouse.down()
                    for step in range(1, 9):
                        page.mouse.move(rbox["x"] + step * 10, rbox["y"] + step * 6)
                        page.wait_for_timeout(25)
                    page.mouse.up()
                    page.wait_for_timeout(900)
                    nodes_after = page.locator(".mm-node").count()
                    root_pos = node_pos(rid)
                    record(
                        "5d3",
                        "拖动中心主题后整棵树仍在（不能消失）",
                        nodes_after == nodes_before and root_pos is not None,
                        f"节点数 {nodes_before}→{nodes_after}, rootPosition={root_pos}",
                    )
                pg.shot("04c-dragged")

                # 重新排版：一键回到自动布局
                try:
                    page.click('[data-mm-action="auto-layout"]')
                    page.wait_for_timeout(900)
                    remaining = page.evaluate(
                        """() => {
                            const st = window.__mindmap.state();
                            let count = 0;
                            const walk = (n) => { if (n.position) count += 1; n.children.forEach(walk); };
                            walk(st.doc.root);
                            return count;
                        }"""
                    )
                    record("5d4", "「重新排版」清除所有手动坐标", remaining == 0, f"剩余带坐标节点 {remaining}")
                    pg.shot("04d-relayout")
                except Exception as exc:
                    record("5d4", "「重新排版」清除所有手动坐标", False, str(exc)[:200])
        except Exception as exc:
            for key, name in [
                ("5d", "拖动子节点写入固定坐标（且不破坏结构）"),
                ("5d2", "拖动不改变树的层级关系"),
                ("5d3", "拖动中心主题后整棵树仍在（不能消失）"),
                ("5d4", "「重新排版」清除所有手动坐标"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04c-drag-fail")

        # ---------- 5e 节点图片（附件图 + 纯图片节点） ----------
        try:
            # 独立起点：清空并新建一份只有根节点的文档
            pg.reset_workspace("图片测试导图")

            fixture = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixture.png")
            if not os.path.exists(fixture):
                record("5e", "上传图片并渲染到节点", False, "缺少测试图片 fixture.png")
            else:
                # 选中根节点，用真实的文件选择器上传（不是直接调接口）。
                #
                # 用调试句柄选中而不是点 DOM：前面的拖动用例可能把节点挪到视口外，
                # 按坐标点会点空，而这是测试脚手架的问题、不是功能的问题。
                # 这里只跳过"选中"这一步，上传本身仍走真实的 file chooser。
                page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    window.__mindmap.select(s.doc.root.id);
                }""")
                page.wait_for_timeout(400)
                # 工具条按钮已移除（v0.15.1）：直接给隐藏的 file input 设文件，
                # 走的是和"粘贴 / 拖入"完全相同的 addImages 路径
                page.set_input_files('input[multiple]', fixture)
                page.wait_for_timeout(2500)

                img_count = page.locator(".mm-node-img").count()
                record("5e", "上传图片后节点里渲染出图片", img_count >= 1, f"img 元素数={img_count}")

                # 图片必须真的加载成功（naturalWidth > 0），而不是坏图标或占位符。
                #
                # 这里必须"等"而不是"睡一会儿再看"：图片要经过
                # 上传 → Host 落盘 → assets.get 取回 → 建 blob URL → 浏览器解码
                # 才会有 naturalWidth。固定 sleep 在网络稍慢时会拿到占位 SPAN，
                # 从而把"加载慢"误报成"图片坏了"。
                try:
                    page.wait_for_function(
                        """() => {
                            const imgs = [...document.querySelectorAll('.mm-node-img')];
                            return imgs.some(i => i.tagName === 'IMG' && (i.naturalWidth || 0) > 0);
                        }""",
                        timeout=15000,
                    )
                except Exception:
                    pass
                loaded = page.evaluate(
                    """() => {
                        const imgs = [...document.querySelectorAll('.mm-node-img')];
                        return imgs.map(i => ({tag: i.tagName, nw: i.naturalWidth || 0, src: (i.src||'').slice(0,20)}));
                    }"""
                )
                ok_loaded = any(i["tag"] == "IMG" and i["nw"] > 0 for i in loaded)
                record("5e2", "图片真的加载成功（naturalWidth>0）", ok_loaded, json.dumps(loaded)[:220])

                # 数据里应该有 images 元数据（含探明的尺寸）
                meta = page.evaluate(
                    """() => {
                        const st = window.__mindmap.state();
                        const out = [];
                        const walk = (n) => { for (const im of (n.images||[])) out.push(im); n.children.forEach(walk); };
                        walk(st.doc.root);
                        return out;
                    }"""
                )
                record(
                    "5e3",
                    "图片元数据写入文档（带探明的宽高）",
                    len(meta) >= 1 and meta[0].get("width", 0) > 0 and meta[0].get("height", 0) > 0,
                    json.dumps(meta)[:220],
                )

                # 纯图片节点：新建一个子节点，清空文字只留图片
                try:
                    page.locator('.mm-node[data-root="true"]').click()
                    page.wait_for_timeout(300)
                    page.keyboard.press("Tab")
                    page.wait_for_timeout(700)
                    page.keyboard.press("Escape")
                    page.wait_for_timeout(400)
                    # 给这个新节点加图：同样用调试句柄确保选中的是它
                    page.evaluate("""() => {
                        const s = window.__mindmap.state();
                        window.__mindmap.select(s.selectedId);
                    }""")
                    page.wait_for_timeout(300)
                    # 工具条按钮已移除（v0.15.1）：直接给隐藏的 file input 设文件
                    page.set_input_files('input[multiple]', fixture)
                    page.wait_for_timeout(2500)

                    pure = page.evaluate(
                        """() => {
                            const st = window.__mindmap.state();
                            let pure = null;
                            const walk = (n) => {
                                if (!n.text.trim() && (n.images||[]).length > 0) pure = {id: n.id, imgs: n.images.length};
                                n.children.forEach(walk);
                            };
                            walk(st.doc.root);
                            return pure;
                        }"""
                    )
                    record(
                        "5e4",
                        "纯图片节点（无文字只有图）可创建",
                        pure is not None,
                        json.dumps(pure, ensure_ascii=False)[:160],
                    )
                    pg.shot("04e-images")
                except Exception as exc:
                    record("5e4", "纯图片节点（无文字只有图）可创建", False, str(exc)[:200])

                # Markdown 里要有图片语法
                try:
                    page.click('[data-mm-action="markdown"]')
                    page.wait_for_selector('[data-mm-panel="markdown"]', timeout=15000)
                    page.wait_for_timeout(800)
                    md_path = page.input_value(".mm-md-text")
                    has_md_img = "![" in md_path and "assets/" in md_path
                    record(
                        "5e5",
                        "Markdown 用相对路径输出图片",
                        has_md_img,
                        [l for l in md_path.split("\n") if "![" in l][:2].__str__()[:160],
                    )

                    # 内嵌开关
                    if page.locator('[data-mm-action="inline-images"]').count() > 0:
                        page.check('[data-mm-action="inline-images"]')
                        page.wait_for_timeout(2500)
                        md_inline = page.input_value(".mm-md-text")
                        record(
                            "5e6",
                            "勾选内嵌后 Markdown 出现 base64 data URI",
                            "data:image/" in md_inline and "base64," in md_inline,
                            ("长度 " + str(len(md_inline)) + " 字符") if "data:image/" in md_inline else md_inline[:120],
                        )
                        page.uncheck('[data-mm-action="inline-images"]')
                        page.wait_for_timeout(600)
                    else:
                        record("5e6", "勾选内嵌后 Markdown 出现 base64 data URI", False, "找不到内嵌开关")

                    record(
                        "5e7",
                        "「导出图片」按钮存在",
                        page.locator('[data-mm-action="download-images"]').count() == 1,
                    )
                    # Markdown 现在是右侧一栏：收起它（画布一直都在）
                    if page.locator('[data-mm-action="hide-md"]').count() > 0:
                        page.click('[data-mm-action="hide-md"]')
                    else:
                        page.click('[data-mm-action="markdown"]')
                    page.wait_for_timeout(700)
                except Exception as exc:
                    for key, name in [
                        ("5e5", "Markdown 用相对路径输出图片"),
                        ("5e6", "勾选内嵌后 Markdown 出现 base64 data URI"),
                        ("5e7", "「导出图片」按钮存在"),
                    ]:
                        if not any(r["key"] == key for r in results):
                            record(key, name, False, str(exc)[:200])
        except Exception as exc:
            for key, name in [
                ("5e", "上传图片后节点里渲染出图片"),
                ("5e2", "图片真的加载成功（naturalWidth>0）"),
                ("5e3", "图片元数据写入文档（带探明的宽高）"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04e-images-fail")

        # ---------- 5f 撤销 / 重做 ----------
        # 要验的是「真的回退了」而不是「按钮能点」：每一步都对比树的实际内容。
        try:
            # 独立起点：不受 5d 拖动、5e 图片的影响
            pg.reset_workspace("撤销测试导图")

            tree_sig = pg.tree_sig  # 绑定方法，直接调用即可

            def hist():
                return page.evaluate("window.__mindmap.state().historyState")

            def click_if_enabled(action):
                """只有按钮可点时才点，返回是否点了。

                为什么要判：Playwright 点一个 disabled 按钮会一直等到超时（30s），
                既拖慢测试又让失败信息变成"超时"而不是"状态不对"。
                """
                sel = '[data-mm-action="' + action + '"]'
                if page.locator(sel).count() == 0:
                    return False
                if page.locator(sel).is_disabled():
                    return False
                page.click(sel)
                page.wait_for_timeout(500)
                return True

            # --- 5f 干净文档：撤销按钮应禁用 ---
            _h0 = hist()
            record(
                "5f",
                "刚新建文档时撤销按钮禁用（历史已复位）",
                _h0["canUndo"] is False,
                f"historyState={_h0} nodes={tree_sig()}",
            )

            before_sig = tree_sig()

            # --- 做一次可辨识的编辑 ---
            page.locator(".mm-node").first.click()
            page.wait_for_timeout(300)
            page.keyboard.press("Tab")
            page.wait_for_timeout(600)
            page.keyboard.type("撤销测试节点")
            page.keyboard.press("Enter")
            page.wait_for_timeout(700)
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)

            after_sig = tree_sig()
            record("5f2", "编辑后撤销按钮变为可用", hist()["canUndo"] is True)

            # --- 撤销一次：树必须变化 ---
            clicked = click_if_enabled("undo")
            undone_sig = tree_sig()
            record(
                "5f3",
                "撤销一次让树回退（内容确实变了）",
                clicked and undone_sig != after_sig,
                f"{len(after_sig)} → {len(undone_sig)} 节点",
            )
            record("5f3c", "撤销后重做按钮变为可用", hist()["canRedo"] is True)

            # --- 重做一次：回到撤销前 ---
            redone = click_if_enabled("redo")
            record(
                "5f4",
                "重做把刚才撤销的那一步加回来",
                redone and tree_sig() == after_sig,
                f"回到撤销前={tree_sig() == after_sig}",
            )

            # --- 一路撤到底，必须回到编辑前 ---
            for _ in range(10):
                if not click_if_enabled("undo"):
                    break
            bottom_sig = tree_sig()
            record(
                "5f3b",
                "一路撤销能回到编辑前的状态",
                bottom_sig == before_sig,
                f"回到初始={bottom_sig == before_sig}",
            )

            # --- 一路重做回去 ---
            for _ in range(12):
                if not click_if_enabled("redo"):
                    break
            record(
                "5f4b",
                "一路重做能回到编辑后的状态",
                tree_sig() == after_sig,
                f"回到编辑后={tree_sig() == after_sig}",
            )

            # --- 键盘快捷键 ---
            page.locator(".mm-canvas").first.click(position={"x": 5, "y": 5})
            page.wait_for_timeout(300)
            kbd_before = tree_sig()
            page.keyboard.press("Control+z")
            page.wait_for_timeout(900)
            kbd_after = tree_sig()
            record(
                "5f5",
                "Ctrl+Z 快捷键撤销生效（树内容变化）",
                kbd_after != kbd_before,
                f"{len(kbd_before)} → {len(kbd_after)} 节点",
            )

            page.keyboard.press("Control+Shift+z")
            page.wait_for_timeout(900)
            record(
                "5f6",
                "Ctrl+Shift+Z 快捷键重做生效（回到撤销前）",
                tree_sig() == kbd_before,
                f"与撤销前一致={tree_sig() == kbd_before}",
            )

            # --- 连续多步撤销 ---
            page.locator(".mm-canvas").first.click(position={"x": 5, "y": 5})
            page.wait_for_timeout(200)
            baseline = tree_sig()
            for _ in range(3):
                if not click_if_enabled("undo"):
                    break
            shrunk = tree_sig()
            record(
                "5f7",
                "连续撤销多步逐步回退",
                len(shrunk) < len(baseline),
                f"{len(baseline)} → {len(shrunk)} 节点",
            )

            pg.shot("04f-undo")
        except Exception as exc:
            for key, name in [
                ("5f", "刚新建文档时撤销按钮禁用（历史已复位）"),
                ("5f2", "编辑后撤销按钮变为可用"),
                ("5f3", "撤销一次让树回退（内容确实变了）"),
                ("5f3c", "撤销后重做按钮变为可用"),
                ("5f4", "重做把刚才撤销的那一步加回来"),
                ("5f3b", "一路撤销能回到编辑前的状态"),
                ("5f4b", "一路重做能回到编辑后的状态"),
                ("5f5", "Ctrl+Z 快捷键撤销生效（树内容变化）"),
                ("5f6", "Ctrl+Shift+Z 快捷键重做生效（回到撤销前）"),
                ("5f7", "连续撤销多步逐步回退"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04f-undo-fail")

        # ---------- 5g 双击图片查看大图 ----------
        try:
            # 自己准备一张图，不依赖前面任何一段的残留。
            #
            # 这一条是踩过才写的：5g 原本"承接 5e 的图片"，但 5f 里
            # reset_workspace() 会清空并重建文档，跑在 5g 之前 -> 图片早就没了，
            # 于是 5g 报"画布上没有可点的图片"。看似功能坏了，其实是测试顺序。
            # 每段自己造数据，顺序就不再是隐式依赖。
            fixture = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixture.png")
            pg.reset_workspace("灯箱测试导图")
            page.evaluate("() => { const s = window.__mindmap.state(); window.__mindmap.select(s.doc.root.id); }")
            page.wait_for_timeout(300)
            # 工具条按钮已移除（v0.15.1）：直接给隐藏的 file input 设文件
            page.set_input_files('input[multiple]', fixture)
            # 等图片真正落到节点上（上传是异步的）
            try:
                page.wait_for_function(
                    """() => {
                        const s = window.__mindmap.state();
                        let n = 0;
                        const w = (x) => { n += (x.images || []).length; x.children.forEach(w); };
                        if (s.doc) w(s.doc.root);
                        return n > 0;
                    }""",
                    timeout=15000,
                )
            except Exception:
                pass
            page.wait_for_timeout(600)

            thumbs = page.locator("img.mm-node-img")
            if thumbs.count() == 0:
                # 失败时把现场信息带出来：是停在别的面板？还是节点上真没图？
                diag = page.evaluate("""() => ({
                    mode: window.__mindmap.state().mode,
                    hasMarkdownPanel: !!document.querySelector('[data-mm-panel="markdown"]'),
                    nodes: document.querySelectorAll('.mm-node').length,
                    anyNodeImg: document.querySelectorAll('.mm-node-img').length,
                    imgsInDoc: (function(){
                        const s = window.__mindmap.state();
                        let n = 0;
                        const w = (x) => { n += (x.images||[]).length; x.children.forEach(w); };
                        if (s.doc) w(s.doc.root);
                        return n;
                    })(),
                })""")
                record("5g", "双击图片打开大图", False, "画布上没有可点的图片 " + json.dumps(diag, ensure_ascii=False)[:260])
            else:
                record("5g0", "缩略图光标提示可放大", page.evaluate(
                    """() => {
                        const img = document.querySelector('img.mm-node-img');
                        return img ? getComputedStyle(img).cursor : null;
                    }"""
                ) == "zoom-in")

                # 双击第一张缩略图
                thumbs.first.dblclick()
                page.wait_for_timeout(1200)

                box = page.locator('[data-mm-panel="lightbox"]')
                opened = box.count() > 0
                record("5g", "双击图片打开大图灯箱", opened)

                if opened:
                    # 大图必须真的加载出来
                    try:
                        page.wait_for_function(
                            """() => {
                                const img = document.querySelector('.mm-lightbox-img');
                                return img && img.tagName === 'IMG' && (img.naturalWidth || 0) > 0;
                            }""",
                            timeout=15000,
                        )
                    except Exception:
                        pass
                    big = page.evaluate(
                        """() => {
                            const img = document.querySelector('.mm-lightbox-img');
                            if (!img) return null;
                            const r = img.getBoundingClientRect();
                            return {nw: img.naturalWidth, nh: img.naturalHeight,
                                    w: Math.round(r.width), h: Math.round(r.height)};
                        }"""
                    )
                    record(
                        "5g2",
                        "大图真实加载（naturalWidth>0）",
                        big is not None and big["nw"] > 0,
                        json.dumps(big),
                    )
                    # 大图显示尺寸应显著大于缩略图（132 上限）
                    record(
                        "5g3",
                        "大图显示尺寸大于缩略图",
                        big is not None and big["w"] > 132,
                        f"大图 {big['w']}x{big['h']}" if big else "无",
                    )

                    # Esc 关闭
                    page.keyboard.press("Escape")
                    page.wait_for_timeout(600)
                    record(
                        "5g4",
                        "Esc 关闭灯箱",
                        page.locator('[data-mm-panel="lightbox"]').count() == 0,
                    )

                    # 再打开一次，测点背景关闭
                    thumbs.first.dblclick()
                    page.wait_for_timeout(900)
                    reopened = page.locator('[data-mm-panel="lightbox"]').count() > 0
                    if reopened:
                        # 点舞台边缘（背景）
                        page.mouse.click(20, 400)
                        page.wait_for_timeout(600)
                    record(
                        "5g5",
                        "点背景关闭灯箱",
                        reopened and page.locator('[data-mm-panel="lightbox"]').count() == 0,
                        f"重新打开={reopened}",
                    )

                    # 双击图片不能触发节点改名（冒泡必须被拦住）
                    before_edit = page.evaluate("window.__mindmap.state().editingId")
                    thumbs.first.dblclick()
                    page.wait_for_timeout(900)
                    in_lightbox = page.locator('[data-mm-panel="lightbox"]').count() > 0
                    editing = page.evaluate("window.__mindmap.state().editingId")
                    record(
                        "5g6",
                        "双击图片不会误触发节点改名",
                        in_lightbox and editing is None,
                        f"灯箱打开={in_lightbox} editingId={editing} (之前={before_edit})",
                    )
                    if in_lightbox:
                        page.click('[data-mm-action="lightbox-close"]')
                        page.wait_for_timeout(400)

                    pg.shot("04g-lightbox")
        except Exception as exc:
            for key, name in [
                ("5g0", "缩略图光标提示可放大"),
                ("5g", "双击图片打开大图灯箱"),
                ("5g2", "大图真实加载（naturalWidth>0）"),
                ("5g3", "大图显示尺寸大于缩略图"),
                ("5g4", "Esc 关闭灯箱"),
                ("5g5", "点背景关闭灯箱"),
                ("5g6", "双击图片不会误触发节点改名"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04g-lightbox-fail")

        # ---------- 5h Markdown 侧栏：默认右侧、可隐藏、可反向编辑 ----------
        try:
            pg.reset_workspace("双向编辑导图")

            # 造两个分支。
            #
            # 注意必须先**点节点**把焦点放到画布上再按键盘：reset_workspace 之后
            # 焦点还在别处，直接 press("Tab") 会把焦点移出面板（浏览器默认行为），
            # 之后整个界面就"消失"了 —— 这正是 5h 系列全挂的真实原因。
            page.locator(".mm-node").first.click()
            page.wait_for_timeout(400)
            page.keyboard.press("Tab"); page.wait_for_timeout(600)
            page.keyboard.type("分支甲"); page.keyboard.press("Enter"); page.wait_for_timeout(600)
            # 回车在编辑态只确认（v0.8.2）：再按一次才是"加同级"
            page.keyboard.press("Enter"); page.wait_for_timeout(500)
            page.keyboard.type("分支乙"); page.keyboard.press("Enter"); page.wait_for_timeout(600)
            page.keyboard.press("Escape"); page.wait_for_timeout(600)
            # 键盘操作完再点一次画布空白处，确保焦点回来
            page.locator(".mm-canvas").first.click(position={"x": 5, "y": 5})
            page.wait_for_timeout(400)

            # --- 打开侧栏 ---
            record("5h0", "默认不显示 Markdown 侧栏", page.locator('[data-mm-panel="markdown"]').count() == 0)

            # 确认确实停在画布上且工具栏可用再点：前面几步用键盘操作节点，
            # 可能停在编辑态或列表页，那时工具栏按钮不可点（Playwright 会等 30s）
            try:
                page.wait_for_selector('[data-mm-action="markdown"]', state="visible", timeout=15000)
            except Exception:
                diag = page.evaluate("""() => ({
                    mode: window.__mindmap.state().mode,
                    mdOpen: window.__mindmap.state().mdOpen,
                    hasDoc: !!window.__mindmap.state().doc,
                    docsInList: document.querySelectorAll('.mm-doc').length,
                    hasMmRoot: !!document.querySelector('.mm-mm-root, [data-mm-root]'),
                    hasBar: !!document.querySelector('.mm-bar'),
                    actions: [...document.querySelectorAll('[data-mm-action]')].map(e => e.dataset.mmAction),
                })""")
                raise RuntimeError("找不到 Markdown 按钮，现场：" + json.dumps(diag, ensure_ascii=False)[:300])
            page.evaluate("() => window.__mindmap.edit(null)")
            page.wait_for_timeout(400)
            if page.locator(".mm-doc").count() > 0:
                page.locator(".mm-doc").first.click()
                page.wait_for_selector(".mm-node", timeout=15000)
                page.wait_for_timeout(700)

            page.click('[data-mm-action="markdown"]')
            page.wait_for_timeout(900)
            opened = page.locator('[data-mm-panel="markdown"]').count() > 0
            record("5h", "点 Markdown 打开右侧栏", opened)

            if opened:
                # --- 画布仍在（不是互斥视图）---
                record(
                    "5h1",
                    "打开侧栏后画布仍然可见（不再互斥）",
                    page.locator(".mm-node").count() > 0,
                    f"画布节点数={page.locator('.mm-node').count()}",
                )

                # --- 右侧布局：侧栏在画布右边 ---
                geo = page.evaluate("""() => {
                    const canvas = document.querySelector('.mm-split-main');
                    const side = document.querySelector('.mm-split-side');
                    if (!canvas || !side) return null;
                    const a = canvas.getBoundingClientRect(), b = side.getBoundingClientRect();
                    return {canvasRight: Math.round(a.right), sideLeft: Math.round(b.left),
                            sideWidth: Math.round(b.width), canvasWidth: Math.round(a.width)};
                }""")
                record(
                    "5h2",
                    "侧栏位于画布右侧且有合理宽度",
                    geo is not None and geo["sideLeft"] >= geo["canvasRight"] - 2 and geo["sideWidth"] > 200,
                    json.dumps(geo),
                )

                # --- 画布改动会同步到 Markdown ---
                md_before = page.input_value(".mm-md-text")
                # 必须点画布把焦点抢回来：此时焦点在侧栏的 textarea 里，
                # 直接 press("Tab") 会在 textarea 内跳转，不会在画布上加节点。
                page.locator(".mm-node").first.click()
                page.wait_for_timeout(400)
                page.keyboard.press("Tab"); page.wait_for_timeout(600)
                page.keyboard.type("画布上新增"); page.keyboard.press("Enter"); page.wait_for_timeout(700)
                page.keyboard.press("Escape"); page.wait_for_timeout(700)
                md_after = page.input_value(".mm-md-text")
                record(
                    "5h3",
                    "画布改动实时反映到 Markdown",
                    "画布上新增" in md_after and md_after != md_before,
                    f"含新增={'画布上新增' in md_after} 有变化={md_after != md_before} "
                    f"before={md_before[:60]!r} after={md_after[:60]!r}",
                )

                # --- 改 Markdown → 应用 → 画布变化 ---
                # 在文本里追加一个二级标题
                page.fill(".mm-md-text", md_after.rstrip() + "\n\n## Markdown新增\n")
                page.wait_for_timeout(500)
                has_apply = page.locator('[data-mm-action="apply-md"]').count() > 0
                record("5h4", "编辑后出现「应用修改」按钮", has_apply)

                if has_apply:
                    page.click('[data-mm-action="apply-md"]')
                    page.wait_for_timeout(1200)
                    tree_texts = page.evaluate("""() => {
                        const s = window.__mindmap.state();
                        const out = [];
                        const w = (n) => { out.push(n.text); n.children.forEach(w); };
                        w(s.doc.root);
                        return out;
                    }""")
                    record(
                        "5h5",
                        "Markdown 的修改应用到画布",
                        "Markdown新增" in tree_texts,
                        json.dumps(tree_texts, ensure_ascii=False)[:200],
                    )

                    # --- 反向编辑不应破坏已有节点 ---
                    still = [t for t in tree_texts if t in ("分支甲", "分支乙")]
                    record(
                        "5h6",
                        "反向编辑保留原有节点",
                        len(still) == 2,
                        json.dumps(tree_texts, ensure_ascii=False)[:200],
                    )

                    # --- 改文字但保留图片/位置（这里验证改名不丢子结构）---
                    md_now = page.input_value(".mm-md-text")
                    page.fill(".mm-md-text", md_now.replace("分支甲", "分支甲改名"))
                    page.wait_for_timeout(400)
                    page.click('[data-mm-action="apply-md"]')
                    page.wait_for_timeout(1200)
                    renamed = page.evaluate("""() => {
                        const s = window.__mindmap.state();
                        const names = [];
                        const w = (n) => { names.push(n.text); n.children.forEach(w); };
                        w(s.doc.root);
                        return names;
                    }""")
                    record(
                        "5h7",
                        "Markdown 里改名同步到画布",
                        "分支甲改名" in renamed,
                        json.dumps(renamed, ensure_ascii=False)[:200],
                    )

                # --- 隐藏侧栏 ---
                if page.locator('[data-mm-action="hide-md"]').count() > 0:
                    page.click('[data-mm-action="hide-md"]')
                else:
                    page.click('[data-mm-action="markdown"]')
                page.wait_for_timeout(800)
                record(
                    "5h8",
                    "可以隐藏侧栏（收起后画布恢复全宽）",
                    page.locator('[data-mm-panel="markdown"]').count() == 0,
                )
                record("5h9", "隐藏侧栏后画布仍在", page.locator(".mm-node").count() > 0)
                pg.shot("04h-md-sidebar")
        except Exception as exc:
            for key, name in [
                ("5h0", "默认不显示 Markdown 侧栏"),
                ("5h", "点 Markdown 打开右侧栏"),
                ("5h1", "打开侧栏后画布仍然可见（不再互斥）"),
                ("5h2", "侧栏位于画布右侧且有合理宽度"),
                ("5h3", "画布改动实时反映到 Markdown"),
                ("5h4", "编辑后出现「应用修改」按钮"),
                ("5h5", "Markdown 的修改应用到画布"),
                ("5h6", "反向编辑保留原有节点"),
                ("5h7", "Markdown 里改名同步到画布"),
                ("5h8", "可以隐藏侧栏（收起后画布恢复全宽）"),
                ("5h9", "隐藏侧栏后画布仍在"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04h-md-fail")

        # ---------- 5i 节点属性（配色 / 字号 / 字形 / 圆角 / 边框） ----------
        try:
            pg.reset_workspace("样式测试导图")
            page.locator(".mm-node").first.click()
            page.wait_for_timeout(700)

            # --- 选中后属性面板出现 ---
            record("5i0", "选中节点后出现属性面板", page.locator('[data-mm-panel="style"]').count() == 1)

            def node_css():
                return page.evaluate("""() => {
                    const el = document.querySelector('.mm-node');
                    if (!el) return null;
                    const cs = getComputedStyle(el);
                    return {bg: cs.backgroundColor, color: cs.color, fontSize: cs.fontSize,
                            fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
                            radius: cs.borderRadius, borderWidth: cs.borderTopWidth};
                }""")

            before = node_css()

            # --- 配色：选一个色板 ---
            page.click('[data-mm-style="color"][data-mm-value="blue"]')
            page.wait_for_timeout(800)
            after_color = node_css()
            record(
                "5i1",
                "选配色后节点背景改变",
                after_color["bg"] != before["bg"],
                f"{before['bg']} → {after_color['bg']}",
            )

            # 数据里存的是 key 而不是色值
            stored = page.evaluate("""() => {
                const s = window.__mindmap.state();
                return s.doc.root.style || null;
            }""")
            record(
                "5i2",
                "数据里存色板 key 而不是硬编码色值",
                stored is not None and stored.get("color") == "blue",
                json.dumps(stored)[:160],
            )

            # --- 字号 ---
            page.click('[data-mm-style="fontSize"][data-mm-value="20"]')
            page.wait_for_timeout(800)
            after_size = node_css()
            record(
                "5i3",
                "选字号后实际字号改变",
                after_size["fontSize"] == "20px",
                f"{before['fontSize']} → {after_size['fontSize']}",
            )

            # 节点尺寸也要跟着变（布局响应字号）
            box_after = page.evaluate("""() => {
                const el = document.querySelector('.mm-node');
                const r = el.getBoundingClientRect();
                return {w: Math.round(r.width), h: Math.round(r.height)};
            }""")
            record("5i3b", "大字号让节点变高", box_after["h"] > 34, json.dumps(box_after))

            # --- 字形：加粗 + 斜体 ---
            #
            # 注意：这里是根节点，根节点**默认就是加粗的**，所以第一次点 B 是
            # "取消加粗"（面板上 B 本来就是亮的，点它是关掉）。
            # v0.13.1 起按"生效值"取反，而不是按"显式值"取反。
            page.click('[data-mm-action="style-bold"]')
            page.wait_for_timeout(600)
            unbold_font = node_css()
            record(
                "5i4",
                "根节点可以取消默认加粗",
                int(unbold_font["fontWeight"]) < 700,
                f"weight={unbold_font['fontWeight']}",
            )

            # 再点一次恢复加粗，顺带验证加粗确实生效
            page.click('[data-mm-action="style-bold"]')
            page.wait_for_timeout(600)
            page.click('[data-mm-action="style-italic"]')
            page.wait_for_timeout(600)
            after_font = node_css()
            record(
                "5i4b",
                "加粗与斜体生效",
                int(after_font["fontWeight"]) >= 700 and after_font["fontStyle"] == "italic",
                f"weight={after_font['fontWeight']} style={after_font['fontStyle']}",
            )

            # --- 圆角 ---
            page.click('[data-mm-style="radius"][data-mm-value="14"]')
            page.wait_for_timeout(600)
            after_radius = node_css()
            record("5i5", "圆角生效", after_radius["radius"] == "14px", after_radius["radius"])

            # --- 边框 ---
            page.click('[data-mm-style="borderWidth"][data-mm-value="3"]')
            page.wait_for_timeout(600)
            after_border = node_css()
            record("5i6", "边框粗细生效", after_border["borderWidth"] == "3px", after_border["borderWidth"])

            # --- 可读性：自定义配色后文字与底色仍要有对比 ---
            readability = page.evaluate("""() => {
                const el = document.querySelector('.mm-node');
                const cs = getComputedStyle(el);
                const parse = (c) => { const m = c.match(/[0-9]+/g); return m ? m.slice(0,3).map(Number) : null; };
                const lum = (rgb) => {
                    const f = rgb.map((v) => { const s = v/255; return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4); });
                    return 0.2126*f[0] + 0.7152*f[1] + 0.0722*f[2];
                };
                const ratio = (a,b) => { const l1=lum(a), l2=lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); };
                return ratio(parse(cs.color), parse(cs.backgroundColor));
            }""")
            record("5i7", "自定义配色后文字对比度足够（≥3）", readability >= 3.0, f"ratio={readability:.2f}")

            # --- 撤销能回退样式 ---
            undo_ok = False
            if not page.locator('[data-mm-action="undo"]').is_disabled():
                page.click('[data-mm-action="undo"]')
                page.wait_for_timeout(700)
                reverted = node_css()
                undo_ok = reverted["borderWidth"] != after_border["borderWidth"]
                # 再重做回去
                if not page.locator('[data-mm-action="redo"]').is_disabled():
                    page.click('[data-mm-action="redo"]')
                    page.wait_for_timeout(600)
            record("5i8", "样式修改可以撤销", undo_ok)

            # --- 应用到子树 ---
            # 点节点抢焦点：直接 press("Tab") 在属性面板的 checkbox 上有焦点时会跳走
            page.locator('.mm-node[data-root="true"]').click()
            page.wait_for_timeout(500)
            page.keyboard.press("Tab"); page.wait_for_timeout(600)
            page.keyboard.type("子节点甲"); page.keyboard.press("Enter"); page.wait_for_timeout(700)
            page.keyboard.press("Escape"); page.wait_for_timeout(600)

            page.locator('.mm-node[data-root="true"]').click()
            page.wait_for_timeout(600)
            if page.locator('[data-mm-action="style-subtree"]').count() > 0:
                page.check('[data-mm-action="style-subtree"]')
                page.wait_for_timeout(300)
                page.click('[data-mm-style="color"][data-mm-value="red"]')
                page.wait_for_timeout(900)
                all_styled = page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    const out = [];
                    const w = (n) => { out.push(n.style ? n.style.color : null); n.children.forEach(w); };
                    w(s.doc.root);
                    return out;
                }""")
                record(
                    "5i9",
                    "「含子节点」把样式应用到整棵子树",
                    all_styled[0] == "red" and len([x for x in all_styled if x == "red"]) >= 2,
                    json.dumps(all_styled),
                )
                page.uncheck('[data-mm-action="style-subtree"]')
                page.wait_for_timeout(400)

            # --- 恢复默认 ---
            # 用调试句柄选中根节点：节点可能被属性面板挤到视口边缘，
            # 按坐标点会不稳（这是测试脚手架的问题，不是功能的）
            page.evaluate("() => { const s = window.__mindmap.state(); window.__mindmap.select(s.doc.root.id); }")
            page.wait_for_timeout(700)
            # 先确认按钮状态，别让 Playwright 干等 30 秒
            btn = page.locator('[data-mm-action="style-reset"]')
            if btn.count() == 0:
                raise RuntimeError("属性面板里没有「恢复默认」按钮")
            if btn.is_disabled():
                diag = page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    const sel = s.selectedId;
                    let found = null;
                    const w = (n) => { if (n.id === sel) found = n; n.children.forEach(w); };
                    w(s.doc.root);
                    return {selectedId: sel, style: found ? (found.style || null) : "节点未找到"};
                }""")
                raise RuntimeError("「恢复默认」按钮是禁用的，现场：" + json.dumps(diag, ensure_ascii=False)[:240])
            # 顺便验证按钮没有被宿主的浮动控件挡住（曾经被桌面宠物盖住过）
            hit = page.evaluate("""() => {
                const btn = document.querySelector('[data-mm-action="style-reset"]');
                if (!btn) return null;
                const r = btn.getBoundingClientRect();
                const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                return {isSelf: top === btn || (top !== null && btn.contains(top)),
                        topTag: top ? top.tagName : "none"};
            }""")
            record(
                "5i10b",
                "「恢复默认」按钮未被宿主浮层遮挡",
                hit is not None and hit["isSelf"],
                json.dumps(hit),
            )
            btn.click()
            page.wait_for_timeout(900)
            cleared = page.evaluate("""() => {
                const s = window.__mindmap.state();
                let n = 0;
                const w = (x) => { if (x.style) n += 1; x.children.forEach(w); };
                w(s.doc.root);
                return n;
            }""")
            record("5i10", "恢复默认清空样式", cleared == 0, f"仍有 {cleared} 个节点带样式")

            pg.shot("04i-style")
        except Exception as exc:
            for key, name in [
                ("5i0", "选中节点后出现属性面板"),
                ("5i1", "选配色后节点背景改变"),
                ("5i2", "数据里存色板 key 而不是硬编码色值"),
                ("5i3", "选字号后实际字号改变"),
                ("5i3b", "大字号让节点变高"),
                ("5i4", "加粗与斜体生效"),
                ("5i5", "圆角生效"),
                ("5i6", "边框粗细生效"),
                ("5i7", "自定义配色后文字对比度足够（≥3）"),
                ("5i8", "样式修改可以撤销"),
                ("5i9", "「含子节点」把样式应用到整棵子树"),
                ("5i10", "恢复默认清空样式"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04i-style-fail")

        # ---------- 5j 画布缩放 ----------
        try:
            pg.reset_workspace("缩放测试导图")
            # 造几个子节点：只有一个根节点时画布比视口窄，
            # 放大到 125% 仍然放得下，测不出"滚动范围要跟着变大"。
            page.locator(".mm-node").first.click()
            page.wait_for_timeout(400)
            # 回车在编辑态只确认内容（v0.8.2），要加同级得再按一次
            page.keyboard.press("Tab")
            page.wait_for_timeout(350)
            # 10 个子节点：300% 时纵向才真的超出视口，测得出"滚动范围跟着内容走"
            for index, name in enumerate(["子甲", "子乙", "子丙", "子丁", "子戊", "子己", "子庚", "子辛", "子壬", "子癸"]):
                if index > 0:
                    page.keyboard.press("Enter")   # 画布态：加同级
                    page.wait_for_timeout(350)
                page.keyboard.type(name)
                page.keyboard.press("Enter")       # 编辑态：确认
                page.wait_for_timeout(350)
            page.keyboard.press("Escape")
            page.wait_for_timeout(500)

            def zoom_text():
                return page.evaluate(
                    """() => document.querySelector('[data-mm-action="zoom-reset"]').textContent.trim()"""
                )

            def canvas_metrics():
                # v0.17.0 起画布用 transform 平移/缩放，没有滚动容器也没有尺寸外壳；
                # 缩放比例直接从 transform 矩阵读。
                return page.evaluate("""() => {
                    const c = document.querySelector('.mm-canvas');
                    const r = c.getBoundingClientRect();
                    const m = new DOMMatrixReadOnly(getComputedStyle(c).transform);
                    return {canvasW: Math.round(r.width),
                            canvasH: Math.round(r.height),
                            scale: Math.round(m.a * 100),
                            panX: Math.round(m.e), panY: Math.round(m.f)};
                }""")

            record("5j0", "缩放控件存在且默认 100%", zoom_text() == "100%", zoom_text())

            m0 = canvas_metrics()
            page.click('[data-mm-action="zoom-in"]')
            page.wait_for_timeout(600)
            m1 = canvas_metrics()
            record(
                "5j1",
                "点放大后比例与画布尺寸都变大",
                zoom_text() == "125%" and m1["canvasW"] > m0["canvasW"],
                f"{zoom_text()} {m0['canvasW']} → {m1['canvasW']}",
            )

            # v0.17.0 改成 transform 平移后没有"滚动范围"了：
            # 画布可以无限拖，不再需要把外壳撑大。这里改为断言
            # 缩放确实作用在 transform 上（比例与控件显示一致）。
            for _ in range(20):
                if page.locator('[data-mm-action="zoom-in"]').is_disabled():
                    break
                page.click('[data-mm-action="zoom-in"]')
                page.wait_for_timeout(100)
            page.wait_for_timeout(600)
            m2 = canvas_metrics()
            # transform 的比例要和控件显示的一致（都是 300%）
            ok = (
                m2["scale"] == 300
                and zoom_text() == "300%"
            )
            record(
                "5j2",
                "放大后 transform 比例与控件显示一致（300%）",
                ok,
                f"scale={m2['scale']} 控件={zoom_text()}",
            )
            page.click('[data-mm-action="zoom-reset"]')
            page.wait_for_timeout(400)

            page.click('[data-mm-action="zoom-reset"]')
            page.wait_for_timeout(500)
            record("5j3", "点百分比可复位到 100%", zoom_text() == "100%", zoom_text())

            page.click('[data-mm-action="zoom-out"]')
            page.wait_for_timeout(500)
            record("5j4", "点缩小后比例变小", zoom_text() == "75%", zoom_text())

            # 缩到边界
            for _ in range(15):
                if page.locator('[data-mm-action="zoom-out"]').is_disabled():
                    break
                page.click('[data-mm-action="zoom-out"]')
                page.wait_for_timeout(120)
            record(
                "5j5",
                "缩到下限后按钮禁用（不会无限缩小）",
                zoom_text() == "25%" and page.locator('[data-mm-action="zoom-out"]').is_disabled(),
                zoom_text(),
            )

            # 放到边界
            for _ in range(20):
                if page.locator('[data-mm-action="zoom-in"]').is_disabled():
                    break
                page.click('[data-mm-action="zoom-in"]')
                page.wait_for_timeout(120)
            record(
                "5j6",
                "放到上限后按钮禁用（不会无限放大）",
                zoom_text() == "300%" and page.locator('[data-mm-action="zoom-in"]').is_disabled(),
                zoom_text(),
            )

            # 快捷键。注意：300% 时节点可能已经移出视口（无限画布没有滚动条），
            # 直接点节点会超时，所以用 JS 聚焦画布元素来接收键盘事件。
            page.evaluate("() => document.querySelector('.mm-canvas').focus()")
            page.wait_for_timeout(300)
            page.keyboard.press("Control+0")
            page.wait_for_timeout(500)
            base = zoom_text()
            page.keyboard.press("Control+=")
            page.wait_for_timeout(500)
            up = zoom_text()
            page.keyboard.press("Control+-")
            page.wait_for_timeout(500)
            down = zoom_text()
            record(
                "5j7",
                "快捷键 Ctrl+= / Ctrl+- / Ctrl+0 可用",
                base == "100%" and up == "125%" and down == "100%",
                f"{base} → {up} → {down}",
            )

            # Ctrl+滚轮
            box = page.locator(".mm-canvas-wrap").bounding_box()
            page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            page.keyboard.down("Control")
            page.mouse.wheel(0, -120)
            page.wait_for_timeout(500)
            wheel_up = zoom_text()
            page.mouse.wheel(0, 240)
            page.wait_for_timeout(500)
            wheel_down = zoom_text()
            page.keyboard.up("Control")
            record(
                "5j8",
                "Ctrl+滚轮可缩放",
                wheel_up == "125%" and wheel_down == "100%",
                f"{wheel_up} → {wheel_down}",
            )

            # 缩放状态下拖动要跟手：屏幕位移 ÷ 缩放 = 画布位移
            page.keyboard.press("Control+=")
            page.wait_for_timeout(600)
            record("5j9a", "拖动测试前已放大到 125%", zoom_text() == "125%", zoom_text())

            def child_pos():
                return page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    const c = s.doc.root.children[0];
                    return c ? (c.position || null) : null;
                }""")

            def drag_child(dx, dy):
                nb = page.locator(".mm-node").nth(1).bounding_box()
                cx, cy = nb["x"] + nb["width"] / 2, nb["y"] + nb["height"] / 2
                page.mouse.move(cx, cy)
                page.mouse.down()
                for i in range(1, 11):
                    page.mouse.move(cx + dx * i / 10, cy + dy * i / 10)
                    page.wait_for_timeout(25)
                page.mouse.up()
                page.wait_for_timeout(700)

            # 第一次拖动：从自动布局变成手动位置（这一步只用来建立基准）
            drag_child(40, 20)
            before = child_pos()
            # 第二次拖动：在已有位置上再移动 (100,60)，量位移
            drag_child(100, 60)
            after = child_pos()
            moved_ok = False
            detail = f"{before} → {after}"
            if after is not None and before is not None:
                dx = after["x"] - before["x"]
                dy = after["y"] - before["y"]
                # 100px 屏幕位移在 125% 下应是 80px 画布位移（容差 ±6）
                moved_ok = abs(dx - 80) <= 6 and abs(dy - 48) <= 6
                detail += f" 画布位移=({dx:.0f},{dy:.0f}) 期望=(80,48)"
            record("5j9", "缩放状态下拖动仍跟手（位移按比例换算）", moved_ok, detail)

            page.keyboard.press("Control+0")
            page.wait_for_timeout(400)
            pg.shot("04j-zoom")
        except Exception as exc:
            for key, name in [
                ("5j0", "缩放控件存在且默认 100%"),
                ("5j1", "点放大后比例与画布尺寸都变大"),
                ("5j2", "放大后滚动范围同步变大（能滚到右侧内容）"),
                ("5j3", "点百分比可复位到 100%"),
                ("5j4", "点缩小后比例变小"),
                ("5j5", "缩到下限后按钮禁用（不会无限缩小）"),
                ("5j6", "放到上限后按钮禁用（不会无限放大）"),
                ("5j7", "快捷键 Ctrl+= / Ctrl+- / Ctrl+0 可用"),
                ("5j8", "Ctrl+滚轮可缩放"),
                ("5j9a", "拖动测试前已放大到 125%"),
                ("5j9", "缩放状态下拖动仍跟手（位移按比例换算）"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04j-zoom-fail")

        # ---------- 5k 框选与批量操作 ----------
        try:
            pg.reset_workspace("框选测试导图")
            page.locator('.mm-node[data-root="true"]').click()
            page.wait_for_timeout(400)
            page.keyboard.press("Tab")
            page.wait_for_timeout(450)
            for index, name in enumerate(["甲", "乙", "丙"]):
                if index > 0:
                    page.keyboard.press("Enter")   # 画布态：加同级
                    page.wait_for_timeout(450)
                page.keyboard.type(name)
                page.wait_for_timeout(250)
                page.keyboard.press("Enter")       # 编辑态：确认
                page.wait_for_timeout(450)
            page.keyboard.press("Escape")
            page.wait_for_timeout(600)

            def sel_info():
                return page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    return {n: s.selectedIds.length, ids: s.selectedIds, primary: s.selectedId};
                }""")

            def node_boxes():
                return page.evaluate("""() => [...document.querySelectorAll('.mm-node')].map(el => {
                    const r = el.getBoundingClientRect();
                    return {id: el.dataset.nodeId, x: Math.round(r.x), y: Math.round(r.y),
                            w: Math.round(r.width), h: Math.round(r.height)};
                })""")

            def canvas_pos():
                return page.evaluate("""() => {
                    const out = {};
                    document.querySelectorAll('.mm-node').forEach(el => {
                        out[el.dataset.nodeId] = {l: parseFloat(el.style.left), t: parseFloat(el.style.top)};
                    });
                    return out;
                }""")

            # --- Shift + 点击 累加多选 ---
            boxes = node_boxes()
            page.locator('.mm-node').nth(1).click()
            page.wait_for_timeout(400)
            one = sel_info()
            page.locator('.mm-node').nth(2).click(modifiers=["Shift"])
            page.wait_for_timeout(400)
            two = sel_info()
            page.locator('.mm-node').nth(3).click(modifiers=["Shift"])
            page.wait_for_timeout(400)
            three = sel_info()
            record(
                "5k0",
                "Shift+点击可以累加多选",
                one["n"] == 1 and two["n"] == 2 and three["n"] == 3,
                f"{one['n']} → {two['n']} → {three['n']}",
            )

            # --- 属性面板切换为批量模式 ---
            panel_title = page.evaluate("""() => {
                const el = document.querySelector('[data-mm-panel="style"] .mm-style-target');
                return el ? el.textContent.trim() : null;
            }""")
            record(
                "5k1",
                "多选时属性面板显示批量模式",
                panel_title is not None and "已选" in panel_title,
                str(panel_title),
            )

            # --- 批量改样式：只影响选中 ---
            page.click('[data-mm-style="color"][data-mm-value="amber"]')
            page.wait_for_timeout(800)
            styled = page.evaluate("""() => {
                const s = window.__mindmap.state();
                const sel = new Set(s.selectedIds);
                const out = [];
                const w = (n) => { out.push({id: n.id, c: n.style ? n.style.color : null}); n.children.forEach(w); };
                w(s.doc.root);
                return {all: out, sel: [...sel]};
            }""")
            sel_set = set(styled["sel"])
            ok_batch = all(
                (item["c"] == "amber") == (item["id"] in sel_set) for item in styled["all"]
            )
            record(
                "5k2",
                "批量改样式只作用于选中节点",
                ok_batch,
                json.dumps([{"选中": i["id"] in sel_set, "色": i["c"]} for i in styled["all"]], ensure_ascii=False)[:200],
            )

            # --- 框选 ---
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            page.evaluate("() => window.__mindmap.select(null)")
            page.wait_for_timeout(400)
            boxes = node_boxes()
            right = [b for b in boxes if b["x"] > 440]
            if len(right) < 2:
                raise RuntimeError(f"右侧节点太少（{len(right)}），无法验证框选")
            left = min(b["x"] for b in right) - 15
            top = min(b["y"] for b in right) - 15
            rx = max(b["x"] + b["w"] for b in right) + 15
            ry = max(b["y"] + b["h"] for b in right) + 15

            page.mouse.move(rx, ry)
            page.mouse.down()
            for i in range(1, 11):
                page.mouse.move(rx - (rx - left) * i / 10, ry - (ry - top) * i / 10)
                page.wait_for_timeout(30)
            # 松手前截一张，确认虚线框真的画出来了
            marquee_visible = page.locator('[data-mm-marquee="true"]').count() > 0
            page.mouse.up()
            page.wait_for_timeout(700)
            boxed = sel_info()
            record(
                "5k3",
                "空白处拖动可框选多个节点",
                boxed["n"] == len(right),
                f"框住 {len(right)} 个，实际选中 {boxed['n']} 个",
            )
            record("5k4", "框选过程中显示虚线框", marquee_visible)

            # --- 批量拖动：整组一起移动，相对位置不变 ---
            before = canvas_pos()
            boxes = node_boxes()
            target = [b for b in boxes if b["x"] > 440][0]
            cx, cy = target["x"] + target["w"] / 2, target["y"] + target["h"] / 2
            page.mouse.move(cx, cy)
            page.mouse.down()
            for i in range(1, 11):
                page.mouse.move(cx + 90 * i / 10, cy + 50 * i / 10)
                page.wait_for_timeout(30)
            page.mouse.up()
            page.wait_for_timeout(900)
            after = canvas_pos()
            selected = set(sel_info()["ids"])

            deltas = {
                nid: (after[nid]["l"] - before[nid]["l"], after[nid]["t"] - before[nid]["t"])
                for nid in before
            }
            sel_deltas = [deltas[nid] for nid in selected if nid in deltas]
            uniform = len(sel_deltas) > 0 and all(
                abs(d[0] - 90) <= 2 and abs(d[1] - 50) <= 2 for d in sel_deltas
            )
            record(
                "5k5",
                "拖动选中节点时整组一起移动（位移一致）",
                uniform,
                json.dumps({("选中" if k in selected else "未选"): [round(v[0]), round(v[1])] for k, v in deltas.items()}, ensure_ascii=False)[:220],
            )

            # --- 相对位置保留 ---
            pairs = [(after[n]["t"] - before[n]["t"]) for n in selected if n in after and n in before]
            record(
                "5k6",
                "批量拖动保留节点间的相对位置",
                len(set(round(x) for x in pairs)) <= 1,
                f"各节点纵向位移={[round(x) for x in pairs]}",
            )

            # --- 拖动后多选不丢 ---
            record(
                "5k7",
                "批量拖动后选中状态保持不变",
                len(sel_info()["ids"]) == len(selected),
                f"{len(selected)} → {len(sel_info()['ids'])}",
            )

            # --- 批量操作可以撤销 ---
            undo_ok = False
            if not page.locator('[data-mm-action="undo"]').is_disabled():
                page.click('[data-mm-action="undo"]')
                page.wait_for_timeout(700)
                reverted = canvas_pos()
                undo_ok = any(
                    abs(reverted[n]["t"] - before[n]["t"]) <= 2 for n in selected if n in reverted
                )
            record("5k8", "批量拖动可以撤销", undo_ok)

            pg.shot("04k-multi")
        except Exception as exc:
            for key, name in [
                ("5k0", "Shift+点击可以累加多选"),
                ("5k1", "多选时属性面板显示批量模式"),
                ("5k2", "批量改样式只作用于选中节点"),
                ("5k3", "空白处拖动可框选多个节点"),
                ("5k4", "框选过程中显示虚线框"),
                ("5k5", "拖动选中节点时整组一起移动（位移一致）"),
                ("5k6", "批量拖动保留节点间的相对位置"),
                ("5k7", "批量拖动后选中状态保持不变"),
                ("5k8", "批量拖动可以撤销"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04k-multi-fail")

        # ---------- 5l 自动保存 / 属性抽屉 / 直接打字 ----------
        try:
            pg.reset_workspace("v08 测试导图")

            # --- 3. 选中后直接打字即进入编辑 ---
            page.locator('.mm-node[data-root="true"]').click()
            page.wait_for_timeout(400)
            # 用 ASCII：Playwright 输中文走 insertText 不产生 keydown，
            # 而真实中文输入会先产生拼音字母的 keydown，所以 ASCII 更能代表真实路径
            page.keyboard.type("abc")
            page.wait_for_timeout(500)
            typed = page.evaluate("""() => {
                const s = window.__mindmap.state();
                const input = document.querySelector('.mm-node-input');
                return {editing: s.editingId !== null, draft: input ? input.value : null};
            }""")
            record(
                "5l0",
                "选中节点后直接打字即进入编辑",
                typed["editing"] and typed["draft"] == "abc",
                json.dumps(typed, ensure_ascii=False),
            )
            page.keyboard.press("Enter")
            page.wait_for_timeout(600)
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            committed = page.evaluate("() => window.__mindmap.state().doc.root.text")
            record(
                "5l1",
                "直接打字的内容能提交（且顶替原文字）",
                committed == "abc",
                str(committed),
            )

            # 快捷键不能被抢：Tab 仍然加子节点
            page.locator('.mm-node[data-root="true"]').click()
            page.wait_for_timeout(400)
            page.keyboard.press("Tab")
            page.wait_for_timeout(600)
            node_count = page.locator(".mm-node").count()
            still_editing = page.evaluate("() => window.__mindmap.state().editingId !== null")
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            record(
                "5l2",
                "直接打字不影响 Tab 等快捷键",
                node_count >= 2 and still_editing,
                f"节点数={node_count} 编辑态={still_editing}",
            )

            # --- 2. 属性抽屉在右侧 ---
            page.locator('.mm-node[data-root="true"]').click()
            page.wait_for_timeout(600)
            geo = page.evaluate("""() => {
                const el = document.querySelector('[data-mm-side="style"]');
                const main = document.querySelector('.mm-split-main');
                if (!el || !main) return null;
                const r = el.getBoundingClientRect();
                const m = main.getBoundingClientRect();
                return {x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height),
                        canvasRight: Math.round(m.right), canvasH: Math.round(m.height)};
            }""")
            record(
                "5l3",
                "属性面板是画布右侧的抽屉",
                geo is not None and geo["x"] >= geo["canvasRight"] - 2 and geo["w"] < 400,
                json.dumps(geo),
            )
            record(
                "5l4b",
                "抽屉高度占满（不再挤占画布高度）",
                geo is not None and abs(geo["h"] - geo["canvasH"]) <= 2,
                f"抽屉高={geo['h'] if geo else None} 画布高={geo['canvasH'] if geo else None}",
            )

            # 收起抽屉：节点仍选中
            page.click('[data-mm-action="style-close"]')
            page.wait_for_timeout(600)
            hidden = page.locator('[data-mm-side="style"]').count() == 0
            still_selected = page.evaluate("() => window.__mindmap.state().selectedId !== null")
            record("5l5", "属性抽屉可以隐藏", hidden)
            record("5l6", "隐藏抽屉不会取消选中", still_selected)

            # 再次选中重新展开
            page.locator('.mm-node[data-root="true"]').click()
            page.wait_for_timeout(600)
            record(
                "5l7",
                "再次选中节点会重新展开抽屉",
                page.locator('[data-mm-side="style"]').count() == 1,
            )

            # 与 Markdown 侧栏共存
            page.click('[data-mm-action="markdown"]')
            page.wait_for_timeout(800)
            both = page.evaluate("""() => {
                const st = document.querySelector('[data-mm-side="style"]');
                const md = document.querySelector('[data-mm-side="markdown"]');
                return {style: !!st, md: !!md,
                        styleRight: st ? Math.round(st.getBoundingClientRect().right) : null,
                        mdLeft: md ? Math.round(md.getBoundingClientRect().left) : null};
            }""")
            record(
                "5l8",
                "属性抽屉与 Markdown 侧栏可以同时存在",
                both["style"] and both["md"],
                json.dumps(both),
            )
            if both["style"] and both["md"]:
                page.click('[data-mm-action="hide-md"]')
                page.wait_for_timeout(600)

            # --- 1. 自动保存状态 ---
            def save_info():
                return page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    const el = document.querySelector('[data-mm-action="save"]');
                    return {state: s.saveState, label: el ? el.textContent.trim() : null};
                }""")

            page.locator('.mm-node[data-root="true"]').click()
            page.wait_for_timeout(400)
            page.keyboard.press("Tab")
            page.wait_for_timeout(150)
            during = save_info()
            page.wait_for_timeout(1600)
            after_save = save_info()
            record(
                "5l9",
                "改动后显示未保存，防抖到点后变已保存",
                during["state"] in ("pending", "saving") and after_save["state"] == "saved",
                f"{during['state']}/{during['label']} → {after_save['state']}/{after_save['label']}",
            )
            record(
                "5l10",
                "保存状态有可见文字提示（不只靠颜色）",
                after_save["label"] is not None and len(after_save["label"]) > 0,
                str(after_save["label"]),
            )

            # --- 关键：改完立刻刷新，数据不能丢 ---
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            # 必须点节点把焦点抢回画布：调试句柄 select() 只改状态、不聚焦，
            # 之后按 Tab 会落到别处（前面 5h/5k 都踩过同一个坑）
            page.locator('.mm-node[data-root="true"]').click()
            page.wait_for_timeout(400)
            page.keyboard.press("Tab")
            page.wait_for_timeout(500)
            # 用 fill 而不是 keyboard.type：Playwright 输中文走 insertText，
            # 不产生 keydown；这里只是要写入内容，不测输入法路径
            page.fill(".mm-node-input", "关键内容")
            page.wait_for_timeout(300)
            page.keyboard.press("Enter")
            page.wait_for_timeout(600)
            page.keyboard.press("Escape")
            page.wait_for_timeout(200)
            before_reload = page.evaluate("""() => {
                const s = window.__mindmap.state();
                const out = [];
                const w = (n) => { out.push(n.text); n.children.forEach(w); };
                if (s.doc) w(s.doc.root);
                return out;
            }""")
            # 不等防抖，立刻刷新
            page.reload(wait_until="load", timeout=90000)
            page.wait_for_timeout(6000)
            pg.open_panel()
            page.wait_for_timeout(1500)
            found = page.evaluate("""() => {
                const s = window.__mindmap.state();
                const d = s.docs.find(x => x.title === 'v08 测试导图');
                if (!d) return null;
                return d.id;
            }""")
            if found is not None:
                page.evaluate("(id) => window.__mindmap.open(id)", found)
                page.wait_for_timeout(1800)
            after_reload = page.evaluate("""() => {
                const s = window.__mindmap.state();
                if (!s.doc) return null;
                const out = [];
                const w = (n) => { out.push(n.text); n.children.forEach(w); };
                w(s.doc.root);
                return out;
            }""")
            record(
                "5l11",
                "改完立刻刷新，编辑不丢失（离开页面前已落盘）",
                after_reload is not None and "关键内容" in after_reload,
                f"刷新前={json.dumps(before_reload, ensure_ascii=False)[:80]} 刷新后={json.dumps(after_reload, ensure_ascii=False)[:80]}",
            )

            pg.shot("04l-v08")
        except Exception as exc:
            for key, name in [
                ("5l0", "选中节点后直接打字即进入编辑"),
                ("5l1", "直接打字的内容能提交（且顶替原文字）"),
                ("5l2", "直接打字不影响 Tab 等快捷键"),
                ("5l3", "属性面板是画布右侧的抽屉"),
                ("5l4", "抽屉高度占满（不再挤占画布高度）"),
                ("5l5", "属性抽屉可以隐藏"),
                ("5l6", "隐藏抽屉不会取消选中"),
                ("5l7", "再次选中节点会重新展开抽屉"),
                ("5l8", "属性抽屉与 Markdown 侧栏可以同时存在"),
                ("5l9", "改动后显示未保存，防抖到点后变已保存"),
                ("5l10", "保存状态有可见文字提示（不只靠颜色）"),
                ("5l11", "改完立刻刷新，编辑不丢失（离开页面前已落盘）"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04l-v08-fail")

        # ---------- 5m 抽屉与画布同层，且不遮挡选中节点 ----------
        try:
            pg.reset_workspace("抽屉遮挡测试")
            # 造一条 7 层深的链：总宽超出收窄后的画布，才测得出"遮挡"
            page.evaluate("""() => {
                const s = window.__mindmap.state();
                let cur = s.doc.root;
                for (let i = 1; i <= 7; i++) {
                    const child = {id: 'deep-' + i, text: '层级' + i, children: []};
                    cur.children.push(child);
                    cur = child;
                }
                window.__mindmap.mutate(s.doc.root);
            }""")
            page.wait_for_timeout(1200)

            def layout_info():
                return page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    const sel = s.selectedId;
                    const el = sel ? document.querySelector('[data-node-id="'+CSS.escape(sel)+'"]') : null;
                    const wrap = document.querySelector('.mm-canvas-wrap');
                    const drawer = document.querySelector('[data-mm-side="style"]');
                    if (!el || !wrap) return null;
                    const r = el.getBoundingClientRect();
                    const w = wrap.getBoundingClientRect();
                    const d = drawer ? drawer.getBoundingClientRect() : null;
                    return {
                        fullyVisible: r.left >= w.left - 1 && r.right <= w.right + 1,
                        scrollLeft: Math.round(wrap.scrollLeft),
                        canvasRight: Math.round(w.right),
                        drawerLeft: d ? Math.round(d.left) : null,
                        drawerOpen: !!drawer,
                    };
                }""")

            # 抽屉收起，再选中第 7 层（这一层在画布右侧之外）
            page.evaluate("() => window.__mindmap.hideStyle()")
            page.wait_for_timeout(500)
            page.evaluate("() => window.__mindmap.select('deep-7')")
            page.wait_for_timeout(1000)
            opened = layout_info()

            record(
                "5m0",
                "抽屉与画布并排（不覆盖画布）",
                opened is not None
                and opened["drawerOpen"]
                and opened["drawerLeft"] is not None
                and opened["drawerLeft"] >= opened["canvasRight"] - 1,
                json.dumps(opened),
            )
            record(
                "5m1",
                "打开抽屉后，选中节点仍完整可见（画布已左移）",
                opened is not None and opened["fullyVisible"],
                json.dumps(opened),
            )
            record(
                "5m2",
                "画布确实发生了横向平移（不是碰巧就在视野内）",
                opened is not None and abs(opened["scrollLeft"]) > 0,
                f"panX={opened['scrollLeft'] if opened else None}",
            )

            # 选中远处的节点也要能自动滚进视野
            page.evaluate("() => window.__mindmap.select('deep-1')")
            page.wait_for_timeout(900)
            near = layout_info()
            page.evaluate("() => window.__mindmap.select('deep-7')")
            page.wait_for_timeout(900)
            far = layout_info()
            record(
                "5m3",
                "切换选中不同深度的节点都会滚进视野",
                near is not None
                and far is not None
                and near["fullyVisible"]
                and far["fullyVisible"]
                and far["scrollLeft"] != near["scrollLeft"],
                f"deep-1 scroll={near['scrollLeft'] if near else None} deep-7 scroll={far['scrollLeft'] if far else None}",
            )

            pg.shot("04m-drawer-scroll")
        except Exception as exc:
            for key, name in [
                ("5m0", "抽屉与画布并排（不覆盖画布）"),
                ("5m1", "打开抽屉后，选中节点仍完整可见（画布已左移）"),
                ("5m2", "画布确实发生了横向滚动（不是碰巧就在视野内）"),
                ("5m3", "切换选中不同深度的节点都会滚进视野"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04m-drawer-scroll-fail")

        # ---------- 5n 编辑框加高加宽 / 悬停提示 / 回车只确认 ----------
        try:
            pg.reset_workspace("编辑优化测试")
            LONG = "这是一段很长的节点文字，用来验证编辑框是否足够高、是否能完整显示内容"

            # 先用 mutate 写入长文本（避免编辑态干扰后续断言）
            page.evaluate("""(t) => {
                const s = window.__mindmap.state();
                s.doc.root.text = t;
                window.__mindmap.mutate(s.doc.root);
            }""", LONG)
            page.wait_for_timeout(1200)

            # --- 编辑框：textarea、比节点高、够宽、内容不被裁 ---
            # 先记下**非编辑态**的节点高度：编辑时方框会包住输入框，
            # 那时两者必然接近，拿编辑态的高度做对比没有意义。
            normal_h = page.evaluate(
                """() => Math.round(document.querySelector('.mm-node[data-root="true"]').getBoundingClientRect().height)"""
            )
            page.locator('.mm-node[data-root="true"]').dblclick()
            page.wait_for_timeout(900)
            editor = page.evaluate("""() => {
                const t = document.querySelector('.mm-node-input');
                const node = document.querySelector('.mm-node[data-root="true"]');
                if (!t || !node) return null;
                const r = t.getBoundingClientRect(), n = node.getBoundingClientRect();
                return {tag: t.tagName, h: Math.round(r.height), w: Math.round(r.width),
                        nodeH: Math.round(n.height), scrollH: t.scrollHeight, clientH: t.clientHeight};
            }""")
            if editor is not None:
                editor["normalH"] = normal_h
            record(
                "5n0",
                "编辑框是多行输入框（textarea）",
                editor is not None and editor["tag"] == "TEXTAREA",
                json.dumps(editor),
            )
            record(
                "5n1",
                "编辑框比节点平时更高（不再憋屈）",
                editor is not None and editor["h"] > editor["normalH"],
                f"编辑框高={editor['h'] if editor else None} 节点平时高={editor['normalH'] if editor else None}",
            )
            record(
                "5n2",
                "编辑框足够宽（长文本不被挤成竖条）",
                editor is not None and editor["w"] >= 240,
                f"宽={editor['w'] if editor else None}",
            )
            record(
                "5n3",
                "编辑时内容不被裁剪（能通读全文）",
                editor is not None and editor["scrollH"] <= editor["clientH"] + 2,
                f"scrollH={editor['scrollH'] if editor else None} clientH={editor['clientH'] if editor else None}",
            )

            # --- 回车只确认，不新增节点 ---
            before_count = page.locator(".mm-node").count()
            page.keyboard.press("Enter")
            page.wait_for_timeout(900)
            after_count = page.locator(".mm-node").count()
            editing_now = page.evaluate("() => window.__mindmap.state().editingId !== null")
            text_now = page.evaluate("() => window.__mindmap.state().doc.root.text")
            record(
                "5n4",
                "编辑态按回车只确认内容，不新增节点",
                after_count == before_count and not editing_now and text_now == LONG,
                f"节点 {before_count}→{after_count} 编辑态={editing_now} 内容已确认={text_now == LONG}",
            )

            # --- 悬停提示：被截断时出现 ---
            truncated = page.evaluate("""() => {
                const span = document.querySelector('.mm-node[data-root="true"] span');
                return span ? span.scrollWidth > span.clientWidth + 1 : false;
            }""")
            # 先把鼠标挪开，确保随后能触发 mouseenter（鼠标已在节点上时不会再触发）
            page.mouse.move(20, 800)
            page.wait_for_timeout(300)
            page.hover('.mm-node[data-root="true"]')
            page.wait_for_timeout(1100)
            tip = page.evaluate("""() => {
                const el = document.querySelector('.mm-tooltip');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return {text: el.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height)};
            }""")
            record(
                "5n5",
                "长文本被截断时，悬停显示完整内容",
                truncated and tip is not None and tip["text"] == LONG,
                f"截断={truncated} 提示={json.dumps(tip, ensure_ascii=False)[:120] if tip else None}",
            )
            record(
                "5n6",
                "悬停提示是浮层（有独立尺寸，不是原生 title）",
                tip is not None and tip["w"] > 0 and tip["h"] > 0,
                json.dumps(tip, ensure_ascii=False)[:120] if tip else None,
            )

            # --- 没被截断的节点不该弹提示 ---
            page.evaluate("""() => {
                const s = window.__mindmap.state();
                s.doc.root.text = "短";
                window.__mindmap.mutate(s.doc.root);
            }""")
            page.wait_for_timeout(1000)
            page.mouse.move(20, 800)
            page.wait_for_timeout(300)
            page.hover('.mm-node[data-root="true"]')
            page.wait_for_timeout(1100)
            no_tip = page.evaluate("() => document.querySelector('.mm-tooltip') === null")
            record("5n7", "未被截断的节点不弹提示（不制造噪音）", no_tip)

            # --- 短文本编辑框不能"小方框套大输入框" ---
            page.evaluate("""() => {
                const s = window.__mindmap.state();
                s.doc.root.text = "颜料的特性";
                window.__mindmap.mutate(s.doc.root);
            }""")
            page.wait_for_timeout(1000)
            page.locator('.mm-node[data-root="true"]').dblclick()
            page.wait_for_timeout(900)
            short = page.evaluate("""() => {
                const n = document.querySelector('.mm-node[data-root="true"]').getBoundingClientRect();
                const t = document.querySelector('.mm-node-input');
                if (!t) return null;
                const r = t.getBoundingClientRect();
                return {
                    nodeW: Math.round(n.width), nodeH: Math.round(n.height),
                    edW: Math.round(r.width), edH: Math.round(r.height),
                    inside: r.left >= n.left - 1 && r.right <= n.right + 1
                        && r.top >= n.top - 1 && r.bottom <= n.bottom + 1,
                    ratio: Math.round((r.width / n.width) * 100),
                };
            }""")
            record(
                "5n8",
                "短文本的编辑框被方框包住（不溢出、不失调）",
                short is not None and short["inside"],
                json.dumps(short),
            )
            record(
                "5n9",
                "编辑框与方框宽度相称（不出现小方框套大输入框）",
                short is not None and 60 <= short["ratio"] <= 100,
                f"编辑框/方框 = {short['ratio'] if short else None}%",
            )
            page.keyboard.press("Escape")
            page.wait_for_timeout(500)

            pg.shot("04n-editor")
        except Exception as exc:
            for key, name in [
                ("5n0", "编辑框是多行输入框（textarea）"),
                ("5n1", "编辑框比节点本身更高（不再憋屈）"),
                ("5n2", "编辑框足够宽（长文本不被挤成竖条）"),
                ("5n3", "编辑时内容不被裁剪（能通读全文）"),
                ("5n4", "编辑态按回车只确认内容，不新增节点"),
                ("5n5", "长文本被截断时，悬停显示完整内容"),
                ("5n6", "悬停提示是浮层（有独立尺寸，不是原生 title）"),
                ("5n7", "未被截断的节点不弹提示（不制造噪音）"),
                ("5n8", "短文本的编辑框被方框包住（不溢出、不失调）"),
                ("5n9", "编辑框与方框宽度相称（不出现小方框套大输入框）"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04n-editor-fail")

        # ---------- 5o 右键拖动平移画布 ----------
        try:
            pg.reset_workspace("平移测试导图")
            # 造一棵够大的树：既要有横向滚动也要有纵向滚动，否则测不出平移
            page.evaluate("""() => {
                const s = window.__mindmap.state();
                // 40 个分支 × 7 层：横向和纵向都要超出视口，才测得出平移
                for (let i = 1; i <= 40; i++) {
                    const child = {id: 'pan-' + i, text: '节点' + i, children: []};
                    let cur = child;
                    for (let d = 2; d <= 7; d++) {
                        const next = {id: 'pan-' + i + '-' + d, text: '第' + d + '层', children: []};
                        cur.children.push(next);
                        cur = next;
                    }
                    s.doc.root.children.push(child);
                }
                window.__mindmap.mutate(s.doc.root);
            }""")
            page.wait_for_timeout(1500)

            def scroll_info():
                # v0.17.0：滚动范围 = 内容 + 四周虚拟留白（PAD 4000），
                # 所以既有滚动条，又不会被内容卡死。
                return page.evaluate("""() => {
                    const w = document.querySelector('.mm-canvas-wrap');
                    return {left: Math.round(w.scrollLeft), top: Math.round(w.scrollTop),
                            maxLeft: w.scrollWidth - w.clientWidth,
                            maxTop: w.scrollHeight - w.clientHeight};
                }""")

            page.wait_for_timeout(400)
            start = scroll_info()

            box = page.locator('.mm-canvas-wrap').bounding_box()
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

            # 右键按住往左上拖 -> 视口往右下看
            page.mouse.move(cx, cy)
            page.mouse.down(button="right")
            for i in range(1, 11):
                page.mouse.move(cx - 100 * i / 10, cy - 60 * i / 10)
                page.wait_for_timeout(25)
            during = page.evaluate("""() => ({
                panning: document.querySelector('.mm-canvas-wrap').dataset.panning || null,
                cursor: getComputedStyle(document.querySelector('.mm-canvas-wrap')).cursor,
            })""")
            page.mouse.up(button="right")
            page.wait_for_timeout(500)
            after = scroll_info()

            record(
                "5o0",
                "右键拖动可以平移画布（位移与鼠标一致）",
                # v0.17.0：改成 transform 平移后，鼠标往左上拖 = 内容跟着往左上走
                # = 平移量**减小**（旧的滚动模型下 scrollLeft 是增大，符号相反）
                after["left"] - start["left"] == 100 and after["top"] - start["top"] == 60,
                f"scroll ({start['left']},{start['top']}) → ({after['left']},{after['top']}) 期望 +100/+60",
            )
            record(
                "5o1",
                "平移过程中显示抓取光标",
                during["panning"] == "true" and during["cursor"] == "grabbing",
                json.dumps(during),
            )

            # 右键菜单不应弹出
            prevented = page.evaluate("""() => new Promise((resolve) => {
                const el = document.querySelector('.mm-canvas-wrap');
                const ev = new MouseEvent('contextmenu', {bubbles: true, cancelable: true});
                el.dispatchEvent(ev);
                resolve(ev.defaultPrevented);
            })""")
            record("5o2", "画布上屏蔽浏览器右键菜单", prevented is True, f"defaultPrevented={prevented}")

            # 松开右键后不能再拖（状态已清）
            moved_after_release = page.evaluate("""() => {
                const w = document.querySelector('.mm-canvas-wrap');
                const before = w.scrollLeft;
                const ev = new PointerEvent('pointermove', {clientX: 10, clientY: 10, pointerId: 999, bubbles: true});
                w.dispatchEvent(ev);
                return w.scrollLeft === before;
            }""")
            record("5o3", "松开右键后移动鼠标不再平移", moved_after_release)

            # 左键行为不受影响：左键拖空白处仍是框选
            page.wait_for_timeout(300)
            before_left = scroll_info()
            page.mouse.move(cx + 200, cy + 200)
            page.mouse.down()
            for i in range(1, 6):
                page.mouse.move(cx + 200 - 20 * i, cy + 200 - 20 * i)
                page.wait_for_timeout(25)
            page.mouse.up()
            page.wait_for_timeout(500)
            after_left = scroll_info()
            record(
                "5o4",
                "左键拖动空白处仍是框选（不会被当成平移）",
                after_left["left"] == before_left["left"] and after_left["top"] == before_left["top"],
                f"左键拖动后 scroll=({after_left['left']},{after_left['top']})",
            )

            # --- 中键平移（v0.9.1）---
            mid_start = scroll_info()
            page.mouse.move(cx, cy)
            page.mouse.down(button="middle")
            for i in range(1, 11):
                page.mouse.move(cx - 80 * i / 10, cy - 40 * i / 10)
                page.wait_for_timeout(25)
            mid_during = page.evaluate("""() => ({
                panning: document.querySelector('.mm-canvas-wrap').dataset.panning || null,
            })""")
            page.mouse.up(button="middle")
            page.wait_for_timeout(500)
            mid_after = scroll_info()
            record(
                "5o5",
                "中键拖动也可以平移画布",
                mid_during["panning"] == "true"
                and mid_after["left"] - mid_start["left"] == 80
                and mid_after["top"] - mid_start["top"] == 40,
                f"scroll ({mid_start['left']},{mid_start['top']}) → ({mid_after['left']},{mid_after['top']})"
                f" 可用量 ({mid_start['maxLeft']},{mid_start['maxTop']})",
            )

            # 中键的浏览器默认行为（自动滚动/auxclick）必须被拦住
            mid_default = page.evaluate("""() => {
                const el = document.querySelector('.mm-canvas-wrap');
                const down = new MouseEvent('mousedown', {button: 1, bubbles: true, cancelable: true});
                el.dispatchEvent(down);
                const aux = new MouseEvent('auxclick', {button: 1, bubbles: true, cancelable: true});
                el.dispatchEvent(aux);
                return {mousedown: down.defaultPrevented, auxclick: aux.defaultPrevented};
            }""")
            record(
                "5o6",
                "中键的浏览器默认行为被阻止（不会进自动滚动模式）",
                mid_default["mousedown"] is True and mid_default["auxclick"] is True,
                json.dumps(mid_default),
            )

            # --- 无限画布：拖得比内容远得多也不会被卡住 ---
            page.evaluate("() => window.__mindmap.center()")
            page.wait_for_timeout(400)
            origin = scroll_info()
            for _ in range(4):
                page.mouse.move(cx, cy)
                page.mouse.down(button="right")
                for i in range(1, 11):
                    page.mouse.move(cx - 250 * i / 10, cy - 150 * i / 10)
                    page.wait_for_timeout(15)
                page.mouse.up(button="right")
                page.wait_for_timeout(120)
            far_pan = scroll_info()
            record(
                "5o7",
                "画布可以拖到内容之外（虚拟留白，不再被内容尺寸卡死）",
                far_pan["left"] - origin["left"] == 1000 and far_pan["top"] - origin["top"] == 600,
                f"scroll ({origin['left']},{origin['top']}) → ({far_pan['left']},{far_pan['top']})",
            )

            # --- pointercancel 不能中断平移（某些平台右键会触发它） ---
            page.mouse.move(cx, cy)
            page.mouse.down(button="right")
            page.evaluate("""() => {
                document.querySelector('.mm-canvas-wrap').dispatchEvent(
                    new PointerEvent('pointercancel', {bubbles: true, pointerId: 1, pointerType: 'mouse'}),
                );
            }""")
            before_cancel = scroll_info()
            page.mouse.move(cx + 120, cy + 80)
            page.wait_for_timeout(250)
            after_cancel = scroll_info()
            page.mouse.up(button="right")
            record(
                "5o8",
                "pointercancel 之后仍能继续平移（右键手势不会把画布锁死）",
                after_cancel["left"] != before_cancel["left"],
                f"{before_cancel['left']} → {after_cancel['left']}",
            )

            # --- 居中按钮：内容拖到视野外还能找回来 ---
            # 先复位缩放：居中的断言和缩放无关，留着上一段测试的 125%/300% 会干扰
            page.click('[data-mm-action="zoom-reset"]')
            page.wait_for_timeout(400)
            page.click('[data-mm-action="center"]')
            page.wait_for_timeout(900)
            centered_ok = page.evaluate("""() => {
                const wrap = document.querySelector('.mm-canvas-wrap').getBoundingClientRect();
                const node = document.querySelector('.mm-node').getBoundingClientRect();
                const tol = 2;
                return node.left >= wrap.left - tol && node.right <= wrap.right + tol
                    && node.top >= wrap.top - tol && node.bottom <= wrap.bottom + tol;
            }""")
            record("5o9", "「居中」按钮能把内容挪回视野", centered_ok)

            pg.shot("04o-pan")
        except Exception as exc:
            for key, name in [
                ("5o0", "右键拖动可以平移画布（位移与鼠标一致）"),
                ("5o1", "平移过程中显示抓取光标"),
                ("5o2", "画布上屏蔽浏览器右键菜单"),
                ("5o3", "松开右键后移动鼠标不再平移"),
                ("5o4", "左键拖动空白处仍是框选（不会被当成平移）"),
                ("5o5", "中键拖动也可以平移画布"),
                ("5o6", "中键的浏览器默认行为被阻止（不会进自动滚动模式）"),
                ("5o7", "无限画布：可以拖到远超内容尺寸的位置（不再被内容卡住）"),
                ("5o8", "pointercancel 之后仍能继续平移（右键手势不会把画布锁死）"),
                ("5o9", "「居中」按钮能把内容挪回视野"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04o-pan-fail")

        # ---------- 5p 复制节点（含子树） ----------
        try:
            pg.reset_workspace("复制测试导图")
            page.evaluate("""() => {
                const s = window.__mindmap.state();
                s.doc.root.children.push(
                    {id: 'cp-a', text: 'A', children: [
                        {id: 'cp-a1', text: 'A1', children: []},
                        {id: 'cp-a2', text: 'A2', children: []},
                    ]},
                    {id: 'cp-b', text: 'B', children: []}
                );
                window.__mindmap.mutate(s.doc.root);
            }""")
            page.wait_for_timeout(1200)

            def tree():
                return page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    const out = [];
                    const w = (n, d) => { out.push({t: n.text, id: n.id, d}); n.children.forEach(c => w(c, d + 1)); };
                    if (s.doc) w(s.doc.root, 0);
                    return out;
                }""")

            before = tree()
            record("5p0", "复制前有 5 个节点（根 + A/A1/A2 + B）", len(before) == 5, f"实际 {len(before)}")

            # 选中 A，点「复制节点」
            # 先点节点：快捷键只在画布有焦点时生效，前面点过工具栏按钮
            page.locator('.mm-node[data-node-id="cp-a"]').click()
            page.wait_for_timeout(400)
            # 工具条按钮已移除（v0.15.1），复制改用 Cmd/Ctrl+D
            page.keyboard.press("Control+d")
            page.wait_for_timeout(1000)
            after = tree()

            # 副本紧跟在原节点之后，且子树完整
            texts = [x["t"] for x in after]
            record(
                "5p1",
                "复制节点会连同子节点一起复制",
                len(after) == 8 and texts.count("A") == 2 and texts.count("A1") == 2,
                f"节点 {len(before)} → {len(after)}",
            )
            record(
                "5p2",
                "副本紧跟在原节点之后（同级顺序正确）",
                texts == ["复制测试导图", "A", "A1", "A2", "A", "A1", "A2", "B"],
                json.dumps(texts, ensure_ascii=False),
            )

            ids = [x["id"] for x in after]
            record(
                "5p3",
                "复制出的每个节点都有新 id（全树唯一）",
                len(set(ids)) == len(ids),
                f"{len(ids)} 个节点，{len(set(ids))} 个不同 id",
            )

            sel = page.evaluate("() => window.__mindmap.state().selectedIds")
            record(
                "5p4",
                "复制后自动选中新节点",
                len(sel) == 1 and sel[0] in ids and sel[0] != "cp-a",
                f"选中={sel}",
            )

            # 撤销
            page.evaluate("() => window.__mindmap.undo()")
            page.wait_for_timeout(800)
            record("5p5", "复制可以撤销", len(tree()) == 5, f"撤销后 {len(tree())} 个节点")

            # 快捷键 Cmd/Ctrl+D
            page.locator('.mm-node[data-node-id="cp-b"]').click()
            page.wait_for_timeout(400)
            page.keyboard.press("Control+d")
            page.wait_for_timeout(900)
            record(
                "5p6",
                "快捷键 Cmd/Ctrl+D 可以复制",
                len(tree()) == 6,
                f"Ctrl+D 后 {len(tree())} 个节点",
            )

            # 根节点不能复制（没有同级）
            page.evaluate("() => { const s = window.__mindmap.state(); window.__mindmap.select(s.doc.root.id); }")
            page.wait_for_timeout(400)
            before_root = len(tree())
            # 工具条按钮已移除（v0.15.1），复制改用 Cmd/Ctrl+D
            page.keyboard.press("Control+d")
            page.wait_for_timeout(800)
            record(
                "5p7",
                "根节点不能复制（没有同级，不会变成两个根）",
                len(tree()) == before_root,
                f"{before_root} → {len(tree())}",
            )

            # 多选复制
            page.evaluate("() => window.__mindmap.selectMany(['cp-a', 'cp-b'])")
            page.wait_for_timeout(400)
            before_multi = len(tree())
            # 工具条按钮已移除（v0.15.1），复制改用 Cmd/Ctrl+D
            page.keyboard.press("Control+d")
            page.wait_for_timeout(1000)
            after_multi = tree()
            multi_ids = [x["id"] for x in after_multi]
            record(
                "5p8",
                "多选时可以一次复制多组",
                len(after_multi) == before_multi + 4 and len(set(multi_ids)) == len(multi_ids),
                f"{before_multi} → {len(after_multi)}",
            )

            pg.shot("04p-duplicate")
        except Exception as exc:
            for key, name in [
                ("5p0", "复制前有 5 个节点（根 + A/A1/A2 + B）"),
                ("5p1", "复制节点会连同子节点一起复制"),
                ("5p2", "副本紧跟在原节点之后（同级顺序正确）"),
                ("5p3", "复制出的每个节点都有新 id（全树唯一）"),
                ("5p4", "复制后自动选中新节点"),
                ("5p5", "复制可以撤销"),
                ("5p6", "快捷键 Cmd/Ctrl+D 可以复制"),
                ("5p7", "根节点不能复制（没有同级，不会变成两个根）"),
                ("5p8", "多选时可以一次复制多组"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04p-duplicate-fail")

        # ---------- 5q 连线：文字描述 + 拖动改关联 ----------
        try:
            pg.reset_workspace("连线测试导图")
            page.evaluate("""() => {
                const s = window.__mindmap.state();
                s.doc.root.children.push(
                    {id: 'eg-a', text: 'A', children: [{id: 'eg-a1', text: 'A1', children: []}]},
                    {id: 'eg-b', text: 'B', children: []}
                );
                window.__mindmap.mutate(s.doc.root);
            }""")
            page.wait_for_timeout(1200)

            def tree():
                return page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    const out = [];
                    const w = (n, d, parent) => {
                        out.push({t: n.text, id: n.id, d, parent, label: n.edgeLabel || null});
                        n.children.forEach(c => w(c, d + 1, n.text));
                    };
                    if (s.doc) w(s.doc.root, 0, null);
                    return out;
                }""")

            def node_of(id_):
                return next((x for x in tree() if x["id"] == id_), None)

            # --- 1. 双击连线加文字 ---
            # 直接派发两次 pointerdown/up：曲线的包围盒中心并不在描边上，
            # 按坐标点很容易落到别的元素上（实测就是这样漏掉的）
            page.evaluate("""() => {
                const el = document.querySelector('[data-mm-link-to="eg-a"]');
                const r = el.getBoundingClientRect();
                const x = r.x + r.width / 2;
                const y = r.y + r.height / 2;
                for (let i = 0; i < 2; i++) {
                    el.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true}));
                    el.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0, isPrimary: true}));
                }
            }""")
            page.wait_for_timeout(700)
            has_editor = page.locator('.mm-edge-input').count() > 0
            record("5q0", "双击连线出现文字编辑框", has_editor)
            if has_editor:
                page.fill('.mm-edge-input', "依赖关系")
                page.wait_for_timeout(250)
                page.keyboard.press("Enter")
                page.wait_for_timeout(800)

            a = node_of("eg-a")
            record(
                "5q1",
                "连线文字能保存到数据里",
                a is not None and a["label"] == "依赖关系",
                json.dumps(a, ensure_ascii=False),
            )
            record(
                "5q2",
                "连线文字渲染在画布上",
                page.locator('[data-mm-edge-label="eg-a"]').count() == 1,
            )

            # 文字跟着节点走（改关联后标签还在）
            # --- 2. 拖动连线把 A 挂到 B 下 ---
            child = page.locator('[data-node-id="eg-a"]').bounding_box()
            target = page.locator('[data-node-id="eg-b"]').bounding_box()
            if child is None or target is None:
                raise RuntimeError("找不到节点包围盒")
            # v0.16.0 起两端语义不同：**父端** = 把这个节点挂到落点下，
            # 子端 = 改这条线连到谁。这里测"改挂"，所以拖父端手柄。
            # v0.22.0：线是独立对象，手柄只在**选中线**时出现（选中节点不出现）
            page.evaluate("() => window.__mindmap.selectEdge('eg-a')")
            page.wait_for_timeout(600)
            handle = page.locator('[data-mm-edge-handle="eg-a"][data-mm-end="parent"]').bounding_box()
            if handle is None:
                raise RuntimeError("找不到父端手柄")
            sx, sy = handle["x"] + handle["width"] / 2, handle["y"] + handle["height"] / 2
            tx, ty = target["x"] + target["width"] / 2, target["y"] + target["height"] / 2
            page.mouse.move(sx, sy)
            page.mouse.down()
            for i in range(1, 11):
                page.mouse.move(sx + (tx - sx) * i / 10, sy + (ty - sy) * i / 10)
                page.wait_for_timeout(30)
            ghost = page.locator('.mm-link-ghost').count()
            page.mouse.up()
            page.wait_for_timeout(1000)

            moved = node_of("eg-a")
            record(
                "5q3",
                "拖动连线可以把节点改挂到另一个节点下",
                moved is not None and moved["parent"] == "B" and moved["d"] == 2,
                json.dumps(moved, ensure_ascii=False),
            )
            record(
                "5q4",
                "拖动连线时显示跟随的虚线（能看见在拖什么）",
                ghost == 1,
                f"虚影元素数={ghost}",
            )
            record(
                "5q5",
                "改关联后连线文字仍跟着这个节点",
                moved is not None and moved["label"] == "依赖关系",
                json.dumps(moved, ensure_ascii=False),
            )
            record(
                "5q6",
                "改关联时子树一起搬走",
                any(x["id"] == "eg-a1" and x["parent"] == "A" for x in tree()),
                json.dumps([x for x in tree() if x["id"] == "eg-a1"], ensure_ascii=False),
            )

            # --- 3. 不允许连到自己的子节点（成环）---
            page.evaluate("() => window.__mindmap.reparent('eg-b', 'eg-a1')")
            page.wait_for_timeout(700)
            b_node = node_of("eg-b")
            record(
                "5q7",
                "不允许把节点连到自己的子孙上（防成环）",
                b_node is not None and b_node["parent"] == "连线测试导图",
                json.dumps(b_node, ensure_ascii=False),
            )

            # --- 4. 撤销 ---
            page.evaluate("() => window.__mindmap.undo()")
            page.wait_for_timeout(800)
            back = node_of("eg-a")
            record(
                "5q8",
                "改关联可以撤销",
                back is not None and back["parent"] == "连线测试导图",
                json.dumps(back, ensure_ascii=False),
            )

            pg.shot("04q-edge")
        except Exception as exc:
            for key, name in [
                ("5q0", "双击连线出现文字编辑框"),
                ("5q1", "连线文字能保存到数据里"),
                ("5q2", "连线文字渲染在画布上"),
                ("5q3", "拖动连线可以把节点改挂到另一个节点下"),
                ("5q4", "拖动连线时显示跟随的虚线（能看见在拖什么）"),
                ("5q5", "改关联后连线文字仍跟着这个节点"),
                ("5q6", "改关联时子树一起搬走"),
                ("5q7", "不允许把节点连到自己的子孙上（防成环）"),
                ("5q8", "改关联可以撤销"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04q-edge-fail")

        # ---------- 5r 多主题 ----------
        try:
            pg.reset_workspace("多主题测试导图")

            def theme_info():
                return page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    return {
                        multi: s.doc.multiTheme === true,
                        rootText: s.doc.root.text,
                        themes: s.doc.root.children.map(c => c.text),
                        rendered: document.querySelectorAll('.mm-node').length,
                        containerRendered: !!document.querySelector(
                            '[data-node-id="' + s.doc.root.id + '"]'),
                    };
                }""")

            base = theme_info()
            record(
                "5r0",
                "新建的导图是单主题（容器根就是中心节点）",
                base["multi"] is False and base["rendered"] == 1 and base["containerRendered"],
                json.dumps(base, ensure_ascii=False),
            )

            # 加第二个主题
            # 工具条按钮已移除（v0.15.1）。这一段测的是"多主题本身"的行为，
            # 创建手势另有 5w/5x 覆盖，所以直接走 store，避免双击落到刚建的主题上。
            page.evaluate("() => window.__mindmap.addTheme()")
            page.wait_for_timeout(1000)
            page.keyboard.type("第二个主题")
            page.wait_for_timeout(300)
            page.keyboard.press("Enter")
            page.wait_for_timeout(900)
            two = theme_info()
            record(
                "5r1",
                "可以新增第二个中心主题",
                two["multi"] and len(two["themes"]) == 2,
                json.dumps(two, ensure_ascii=False),
            )
            record(
                "5r2",
                "升级后容器根不再渲染（画布上只有各主题）",
                two["containerRendered"] is False and two["rendered"] == 2,
                f"渲染节点={two['rendered']} 容器是否渲染={two['containerRendered']}",
            )
            record(
                "5r3",
                "新主题可以直接命名（不会被默认文字干扰）",
                two["themes"][1] == "第二个主题",
                json.dumps(two["themes"], ensure_ascii=False),
            )

            # 再加一个
            # 工具条按钮已移除（v0.15.1）。这一段测的是"多主题本身"的行为，
            # 创建手势另有 5w/5x 覆盖，所以直接走 store，避免双击落到刚建的主题上。
            page.evaluate("() => window.__mindmap.addTheme()")
            page.wait_for_timeout(1000)
            page.keyboard.type("第三个主题")
            page.wait_for_timeout(300)
            page.keyboard.press("Enter")
            page.wait_for_timeout(900)
            three = theme_info()
            record(
                "5r4",
                "可以继续加第三个主题（不会层层嵌套）",
                len(three["themes"]) == 3 and three["rendered"] == 3,
                json.dumps(three["themes"], ensure_ascii=False),
            )

            # 三个主题纵向排开、互不重叠
            boxes = page.evaluate("""() => [...document.querySelectorAll('.mm-node')]
                .map(el => { const r = el.getBoundingClientRect();
                    return {t: el.textContent.trim(), x: Math.round(r.x), y: Math.round(r.y),
                            h: Math.round(r.height)}; })
                .sort((a, b) => a.y - b.y)""")
            stacked = (
                len(boxes) == 3
                and boxes[1]["y"] > boxes[0]["y"] + boxes[0]["h"]
                and boxes[2]["y"] > boxes[1]["y"] + boxes[1]["h"]
                and len({b["x"] for b in boxes}) == 1
            )
            record(
                "5r5",
                "多个主题纵向排开、左对齐、互不重叠",
                stacked,
                json.dumps(boxes, ensure_ascii=False)[:200],
            )

            # 主题下可以正常加子节点
            page.locator('.mm-node').first.click()
            page.wait_for_timeout(400)
            page.keyboard.press("Tab")
            page.wait_for_timeout(500)
            page.keyboard.type("主题一的孩子")
            page.wait_for_timeout(250)
            page.keyboard.press("Enter")
            page.wait_for_timeout(800)
            child_ok = page.evaluate("""() => {
                const s = window.__mindmap.state();
                const first = s.doc.root.children[0];
                return first.children.length === 1 && first.children[0].text === "主题一的孩子";
            }""")
            record("5r6", "多主题下每个主题仍可正常加子节点", child_ok)

            # Markdown 导出：每个主题各成一个 H1
            page.click('[data-mm-action="markdown"]')
            page.wait_for_selector('[data-mm-panel="markdown"]', timeout=15000)
            page.wait_for_timeout(900)
            md = page.input_value(".mm-md-text")
            h1s = [line for line in md.split("\n") if line.startswith("# ")]
            record(
                "5r7",
                "Markdown 导出时每个主题各成一个 H1",
                len(h1s) == 3,
                json.dumps(h1s, ensure_ascii=False)[:200],
            )

            if page.locator('[data-mm-action="hide-md"]').count() > 0:
                page.click('[data-mm-action="hide-md"]')
                page.wait_for_timeout(600)

            # 多主题暂不支持反向同步，必须明确拒绝而不是悄悄合并
            page.click('[data-mm-action="markdown"]')
            page.wait_for_timeout(800)
            page.fill(".mm-md-text", "# 改坏了\n\n## 子\n")
            page.wait_for_timeout(400)
            if page.locator('[data-mm-action="apply-md"]').count() > 0:
                page.click('[data-mm-action="apply-md"]')
                page.wait_for_timeout(900)
            still_multi = page.evaluate("() => window.__mindmap.state().doc.multiTheme === true")
            record(
                "5r8",
                "多主题下从 Markdown 反向修改会被拒绝（不会把主题挤成一棵）",
                still_multi,
                f"仍是多主题={still_multi}",
            )

            pg.shot("04r-multi-theme")
        except Exception as exc:
            for key, name in [
                ("5r0", "新建的导图是单主题（容器根就是中心节点）"),
                ("5r1", "可以新增第二个中心主题"),
                ("5r2", "升级后容器根不再渲染（画布上只有各主题）"),
                ("5r3", "新主题可以直接命名（不会被默认文字干扰）"),
                ("5r4", "可以继续加第三个主题（不会层层嵌套）"),
                ("5r5", "多个主题纵向排开、左对齐、互不重叠"),
                ("5r6", "多主题下每个主题仍可正常加子节点"),
                ("5r7", "Markdown 导出时每个主题各成一个 H1"),
                ("5r8", "多主题下从 Markdown 反向修改会被拒绝（不会把主题挤成一棵）"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04r-multi-theme-fail")

        # ---------- 5s 图片的删除 / 替换 / 说明 ----------
        try:
            pg.reset_workspace("图片操作测试导图")
            fixture = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixture.png")

            page.evaluate("() => { const s = window.__mindmap.state(); window.__mindmap.select(s.doc.root.id); }")
            page.wait_for_timeout(400)
            # 加两张图
            for _ in range(2):
                # 工具条按钮已移除（v0.15.1）：直接给隐藏的 file input 设文件
                page.set_input_files('input[multiple]', fixture)
                page.wait_for_timeout(2200)

            def images():
                return page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    const out = [];
                    const w = (n) => {
                        for (const i of n.images || []) out.push({id: i.id, type: i.type, caption: i.caption || null});
                        n.children.forEach(w);
                    };
                    if (s.doc) w(s.doc.root);
                    return out;
                }""")

            start = images()
            record("5s0", "节点上已有两张图片", len(start) == 2, f"{len(start)} 张")

            # 悬停出现操作条
            page.locator('.mm-node-img-box').first.hover()
            page.wait_for_timeout(500)
            bar = page.evaluate("""() => {
                const el = document.querySelector('.mm-img-actions');
                if (!el) return null;
                const r = el.getBoundingClientRect();
                const box = document.querySelector('.mm-node-img-box').getBoundingClientRect();
                return {opacity: getComputedStyle(el).opacity, buttons: el.querySelectorAll('button').length,
                        insideBox: r.left >= box.left - 1 && r.right <= box.right + 1};
            }""")
            record(
                "5s1",
                "悬停图片出现操作条（删除 / 替换 / 说明）",
                bar is not None and bar["opacity"] == "1" and bar["buttons"] == 3,
                json.dumps(bar),
            )
            record(
                "5s2",
                "操作条贴在图片内（不会跑到画布其它位置）",
                bar is not None and bar["insideBox"],
                json.dumps(bar),
            )

            # 改说明
            page.locator('.mm-node-img-box').first.hover()
            page.wait_for_timeout(300)
            page.locator('[data-mm-action="img-caption"]').first.click()
            page.wait_for_timeout(700)
            if page.locator('.mm-caption-input').count() > 0:
                page.fill('.mm-caption-input', "第一张图的说明")
                page.keyboard.press("Enter")
                page.wait_for_timeout(800)
            after_caption = images()
            record(
                "5s3",
                "可以给图片写说明",
                after_caption[0]["caption"] == "第一张图的说明",
                json.dumps(after_caption, ensure_ascii=False)[:160],
            )

            # 删除第二张（不是"删最后一张"的旧逻辑，而是点哪张删哪张）
            page.locator('.mm-node-img-box').nth(1).hover()
            page.wait_for_timeout(300)
            page.locator('[data-mm-action="img-remove"]').nth(1).click()
            page.wait_for_timeout(900)
            after_remove = images()
            record(
                "5s4",
                "可以删除指定的那张图片",
                len(after_remove) == 1 and after_remove[0]["id"] == start[0]["id"],
                json.dumps(after_remove, ensure_ascii=False)[:160],
            )

            # 替换剩下那张
            page.locator('.mm-node-img-box').first.hover()
            page.wait_for_timeout(300)
            with page.expect_file_chooser() as fc2:
                page.locator('[data-mm-action="img-replace"]').first.click()
            fc2.value.set_files(fixture)
            page.wait_for_timeout(2500)
            after_replace = images()
            record(
                "5s5",
                "可以替换图片（数量不变，id 换新）",
                len(after_replace) == 1 and after_replace[0]["id"] != start[0]["id"],
                json.dumps(after_replace, ensure_ascii=False)[:160],
            )
            record(
                "5s6",
                "替换后图片说明仍保留",
                after_replace[0]["caption"] == "第一张图的说明",
                json.dumps(after_replace, ensure_ascii=False)[:160],
            )

            # 替换后图片能正常显示（不是坏图）
            page.wait_for_function(
                """() => {
                    const imgs = [...document.querySelectorAll('.mm-node-img')];
                    return imgs.some(i => i.tagName === 'IMG' && (i.naturalWidth || 0) > 0);
                }""",
                timeout=15000,
            )
            record("5s7", "替换后的图片能正常加载", True)

            # 删除可以撤销
            page.evaluate("() => window.__mindmap.undo()")
            page.wait_for_timeout(800)
            record(
                "5s8",
                "删除图片可以撤销",
                len(images()) == 1,
                f"撤销后 {len(images())} 张",
            )

            pg.shot("04s-image-ops")
        except Exception as exc:
            for key, name in [
                ("5s0", "节点上已有两张图片"),
                ("5s1", "悬停图片出现操作条（删除 / 替换 / 说明）"),
                ("5s2", "操作条贴在图片内（不会跑到画布其它位置）"),
                ("5s3", "可以给图片写说明"),
                ("5s4", "可以删除指定的那张图片"),
                ("5s5", "可以替换图片（数量不变，id 换新）"),
                ("5s6", "替换后图片说明仍保留"),
                ("5s7", "替换后的图片能正常加载"),
                ("5s8", "删除图片可以撤销"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04s-image-ops-fail")

        # ---------- 5t 属性面板显示当前生效值 ----------
        try:
            pg.reset_workspace("属性显示测试导图")
            page.evaluate("""() => {
                const s = window.__mindmap.state();
                s.doc.root.children.push({id: 'st-a', text: '普通节点', children: []});
                window.__mindmap.mutate(s.doc.root);
            }""")
            page.wait_for_timeout(1200)

            def panel():
                return page.evaluate("""() => {
                    const out = {};
                    for (const g of ['color', 'fontSize', 'radius', 'borderWidth']) {
                        const el = document.querySelector('[data-mm-style="' + g + '"][data-active="true"]');
                        out[g] = el ? el.getAttribute('data-mm-value') : null;
                    }
                    out.bold = !!document.querySelector('[data-mm-action="style-bold"][data-active="true"]');
                    out.italic = !!document.querySelector('[data-mm-action="style-italic"][data-active="true"]');
                    out.defaults = document.querySelectorAll('.mm-style-default').length;
                    out.current = [...document.querySelectorAll('.mm-style-current')].map(e => e.textContent);
                    return out;
                }""")

            # --- 普通节点：没设置过样式，也要显示当前值 ---
            page.evaluate("() => window.__mindmap.select('st-a')")
            page.wait_for_timeout(800)
            plain = panel()
            record(
                "5t0",
                "没设置过样式的节点，面板也高亮当前生效值（13 号 / 边框 1 / 默认配色）",
                plain["fontSize"] == "13" and plain["borderWidth"] == "1" and plain["color"] == "default",
                json.dumps(plain, ensure_ascii=False),
            )
            record(
                "5t1",
                "生效值不在预设档位时标出「当前 N」（圆角默认 6 不在 0/4/8/14 里）",
                any("6" in item for item in plain["current"]),
                json.dumps(plain["current"], ensure_ascii=False),
            )
            record(
                "5t2",
                "没设置过的项标出「默认」",
                plain["defaults"] >= 4,
                f"{plain['defaults']} 个默认标记",
            )

            # --- 根节点：默认更大更粗 ---
            page.evaluate("() => { const s = window.__mindmap.state(); window.__mindmap.select(s.doc.root.id); }")
            page.wait_for_timeout(800)
            rootp = panel()
            record(
                "5t3",
                "根节点面板显示「当前 13.5」且 B 高亮（根默认加粗）",
                rootp["bold"] is True and any("13.5" in item for item in rootp["current"]),
                json.dumps(rootp, ensure_ascii=False),
            )

            # --- 自定义样式后应高亮对应档位 ---
            page.evaluate(
                "() => window.__mindmap.styleNode('st-a', {fontSize: 16, bold: true, radius: 14, borderWidth: 3})"
            )
            page.wait_for_timeout(800)
            page.evaluate("() => window.__mindmap.select('st-a')")
            page.wait_for_timeout(800)
            custom = panel()
            record(
                "5t4",
                "设置过样式后，面板高亮的是设置的那个值",
                custom["fontSize"] == "16"
                and custom["radius"] == "14"
                and custom["borderWidth"] == "3"
                and custom["bold"] is True,
                json.dumps(custom, ensure_ascii=False),
            )
            record(
                "5t5",
                "只有仍未设置的项才标「默认」",
                custom["defaults"] == 1,
                f"{custom['defaults']} 个默认标记（只剩配色）",
            )

            # --- 根节点可以取消加粗 ---
            page.evaluate("() => { const s = window.__mindmap.state(); window.__mindmap.select(s.doc.root.id); }")
            page.wait_for_timeout(700)
            page.click('[data-mm-action="style-bold"]')
            page.wait_for_timeout(900)
            unbold = panel()
            record(
                "5t6",
                "根节点可以取消默认加粗（B 不再高亮）",
                unbold["bold"] is False,
                json.dumps(unbold, ensure_ascii=False),
            )

            pg.shot("04t-style-effective")
        except Exception as exc:
            for key, name in [
                ("5t0", "没设置过样式的节点，面板也高亮当前生效值"),
                ("5t1", "生效值不在预设档位时标出「当前 N」"),
                ("5t2", "没设置过的项标出「默认」"),
                ("5t3", "根节点面板显示「当前 13.5」且 B 高亮"),
                ("5t4", "设置过样式后，面板高亮的是设置的那个值"),
                ("5t5", "只有仍未设置的项才标「默认」"),
                ("5t6", "根节点可以取消默认加粗（B 不再高亮）"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04t-style-effective-fail")

        # ---------- 5u 编辑框尺寸与光标定位 ----------
        try:
            pg.reset_workspace("编辑框测试导图")

            def rect(sel):
                return page.evaluate(
                    """(s) => {
                        const el = document.querySelector(s);
                        if (!el) return null;
                        const r = el.getBoundingClientRect();
                        return {w: Math.round(r.width), h: Math.round(r.height)};
                    }""",
                    sel,
                )

            # 进入编辑态
            page.evaluate("() => { const s = window.__mindmap.state(); window.__mindmap.edit(s.doc.root.id); }")
            page.wait_for_timeout(900)
            editor = rect(".mm-node-input")
            box = rect('.mm-node[data-editing="true"]')
            record("5u0", "进入编辑态后出现输入框", editor is not None, json.dumps(editor))

            # 1) 短文本默认单行
            record(
                "5u1",
                "短文本编辑框默认只有一行高（不会撑成两行）",
                editor is not None and editor["h"] <= 34,
                f"高 {editor['h']}px（单行 13.5px 字约 30px）",
            )
            # 2) 宽度贴合内容，不是写死的 180
            record(
                "5u2",
                "编辑框宽度跟随节点内容（不是固定 180px）",
                editor is not None and editor["w"] <= box["w"] + 4,
                f"编辑框 {editor['w']}px vs 节点 {box['w']}px",
            )

            # 3) 编辑态点击文字不能退出编辑
            ib = page.locator(".mm-node-input").bounding_box()
            page.mouse.click(ib["x"] + 10, ib["y"] + ib["height"] / 2)
            page.wait_for_timeout(600)
            still_editing = page.evaluate("() => window.__mindmap.state().editingId !== null")
            record("5u3", "编辑态点击文字不会退出编辑", still_editing)

            # 4) 点击能把光标定位到指定位置
            caret = page.evaluate(
                """() => {
                    const el = document.querySelector('.mm-node-input');
                    return el
                        ? {start: el.selectionStart, focused: document.activeElement === el}
                        : null;
                }"""
            )
            record(
                "5u4",
                "点击文字能把光标放进去（输入框保持聚焦）",
                caret is not None and caret["focused"] is True,
                json.dumps(caret),
            )

            # 5) 在光标处插入字符，验证定位真的生效
            if caret is not None and caret["focused"]:
                page.keyboard.type("X")
                page.wait_for_timeout(400)
                typed = page.input_value(".mm-node-input")
                record(
                    "5u5",
                    "在光标处输入能插入到该位置",
                    typed.startswith("X"),
                    json.dumps(typed, ensure_ascii=False),
                )

            # 6) 长文本时自动变宽变高
            page.fill(".mm-node-input", "这是一段很长很长的节点文字用来测试编辑框的自适应行为是否正常工作")
            page.wait_for_timeout(700)
            long_box = rect(".mm-node-input")
            record(
                "5u6",
                "长文本时编辑框自动变宽并换行增高",
                long_box is not None and long_box["w"] > editor["w"] and long_box["h"] > editor["h"],
                json.dumps(long_box),
            )

            # 收尾：确认没有越增越高（box-sizing 的坑）
            page.wait_for_timeout(600)
            again = rect(".mm-node-input")
            record(
                "5u7",
                "编辑框高度稳定，不会每轮自动增高（box-sizing 正确）",
                again is not None and abs(again["h"] - long_box["h"]) <= 1,
                f"{long_box['h']}px → {again['h']}px",
            )

            # 退出编辑，内容不应被这次点击弄丢
            page.keyboard.press("Escape")
            page.wait_for_timeout(600)
            pg.shot("04u-editor")
        except Exception as exc:
            for key, name in [
                ("5u0", "进入编辑态后出现输入框"),
                ("5u1", "短文本编辑框默认只有一行高（不会撑成两行）"),
                ("5u2", "编辑框宽度跟随节点内容（不是固定 180px）"),
                ("5u3", "编辑态点击文字不会退出编辑"),
                ("5u4", "点击文字能把光标放进去（输入框保持聚焦）"),
                ("5u5", "在光标处输入能插入到该位置"),
                ("5u6", "长文本时编辑框自动变宽并换行增高"),
                ("5u7", "编辑框高度稳定，不会每轮自动增高（box-sizing 正确）"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04u-editor-fail")

        # ---------- 5v 节点标识（⭐ 重点 等） ----------
        try:
            pg.reset_workspace("标识测试导图")
            page.evaluate("""() => {
                const s = window.__mindmap.state();
                s.doc.root.children.push({id: 'mk-a', text: '重点内容', children: []});
                window.__mindmap.mutate(s.doc.root);
            }""")
            page.wait_for_timeout(1200)

            def marks_of(id_):
                return page.evaluate(
                    """(target) => {
                        const s = window.__mindmap.state();
                        let found = null;
                        const w = (n) => { if (n.id === target) found = n.marks || null; n.children.forEach(w); };
                        if (s.doc) w(s.doc.root);
                        return found;
                    }""",
                    id_,
                )

            def node_width(id_):
                return page.evaluate(
                    """(target) => {
                        const el = document.querySelector('[data-node-id="' + target + '"]');
                        return el ? Math.round(el.getBoundingClientRect().width) : null;
                    }""",
                    id_,
                )

            page.evaluate("() => window.__mindmap.select('mk-a')")
            page.wait_for_timeout(800)
            record(
                "5v0",
                "属性面板有标识按钮",
                page.locator("[data-mm-mark]").count() >= 6,
                f"{page.locator('[data-mm-mark]').count()} 个",
            )

            width_before = node_width("mk-a")
            page.click('[data-mm-mark="star"]')
            page.wait_for_timeout(600)
            page.click('[data-mm-mark="fire"]')
            page.wait_for_timeout(700)
            after = marks_of("mk-a")
            record("5v1", "可以给节点加标识", after == ["star", "fire"], json.dumps(after))
            record(
                "5v2",
                "标识显示在画布上",
                page.locator('[data-node-id="mk-a"] .mm-mark').count() == 2,
                f"{page.locator('[data-node-id="mk-a"] .mm-mark').count()} 个图标",
            )
            width_after = node_width("mk-a")
            record(
                "5v3",
                "加标识后节点变宽（图标不会压到文字）",
                width_after > width_before,
                f"{width_before}px → {width_after}px",
            )

            # 再点一次取消
            page.click('[data-mm-mark="star"]')
            page.wait_for_timeout(700)
            record("5v4", "再点一次取消标识", marks_of("mk-a") == ["fire"], json.dumps(marks_of("mk-a")))

            # 撤销
            page.evaluate("() => window.__mindmap.undo()")
            page.wait_for_timeout(700)
            record("5v5", "标识可以撤销", marks_of("mk-a") == ["star", "fire"], json.dumps(marks_of("mk-a")))

            # 上限 4 个
            page.click('[data-mm-mark="warn"]')
            page.wait_for_timeout(400)
            page.click('[data-mm-mark="ask"]')
            page.wait_for_timeout(700)
            full = marks_of("mk-a")
            record("5v6", "一个节点最多 4 个标识", len(full) == 4, json.dumps(full))
            page.click('[data-mm-mark="idea"]')
            page.wait_for_timeout(800)
            record(
                "5v7",
                "第 5 个标识被拒绝",
                len(marks_of("mk-a")) == 4 and "idea" not in (marks_of("mk-a") or []),
                json.dumps(marks_of("mk-a")),
            )

            # 刷新后仍在（标识会存进数据）
            page.evaluate("() => window.__mindmap.refresh()")
            page.wait_for_timeout(1500)
            record(
                "5v8",
                "标识保存后刷新仍在",
                marks_of("mk-a") == full,
                json.dumps(marks_of("mk-a")),
            )

            pg.shot("04v-marks")
        except Exception as exc:
            for key, name in [
                ("5v0", "属性面板有标识按钮"),
                ("5v1", "可以给节点加标识"),
                ("5v2", "标识显示在画布上"),
                ("5v3", "加标识后节点变宽（图标不会压到文字）"),
                ("5v4", "再点一次取消标识"),
                ("5v5", "标识可以撤销"),
                ("5v6", "一个节点最多 4 个标识"),
                ("5v7", "第 5 个标识被拒绝"),
                ("5v8", "标识保存后刷新仍在"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04v-marks-fail")

        # ---------- 5w 双击空白区域新增主题 ----------
        try:
            pg.reset_workspace("双击加主题导图")

            def info():
                return page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    return {
                        multi: s.doc ? s.doc.multiTheme === true : false,
                        rootText: s.doc ? s.doc.root.text : "",
                        themes: s.doc ? s.doc.root.children.map(c => c.text) : [],
                        rendered: document.querySelectorAll('.mm-node').length,
                        editing: s.editingId !== null,
                    };
                }""")

            start = info()
            record("5w0", "初始是单主题", start["multi"] is False and start["rendered"] == 1,
                   json.dumps(start, ensure_ascii=False))

            # 在可见空白处双击（布局范围之外，事件落在滚动容器上）
            wrap = page.locator(".mm-canvas-wrap").bounding_box()
            ex = wrap["x"] + wrap["width"] * 0.6
            ey = wrap["y"] + wrap["height"] * 0.6
            page.mouse.dblclick(ex, ey)
            page.wait_for_timeout(1200)
            after = info()
            record(
                "5w1",
                "双击空白区域可以新增主题",
                after["multi"] is True and len(after["themes"]) == 2,
                json.dumps(after, ensure_ascii=False),
            )
            record(
                "5w2",
                "新主题直接进入编辑态，可以马上命名",
                after["editing"] is True,
                json.dumps(after, ensure_ascii=False),
            )

            page.keyboard.type("空白新增的主题")
            page.wait_for_timeout(300)
            page.keyboard.press("Enter")
            page.wait_for_timeout(900)
            named = info()
            record(
                "5w3",
                "新主题能命名成功",
                named["themes"][-1] == "空白新增的主题",
                json.dumps(named["themes"], ensure_ascii=False),
            )

            # 双击节点不应该新增主题（应该进入编辑）
            count_before = len(info()["themes"])
            page.locator(".mm-node").first.dblclick()
            page.wait_for_timeout(900)
            node_dbl = info()
            record(
                "5w4",
                "双击节点不会误加主题（而是进入编辑）",
                node_dbl["editing"] is True and len(node_dbl["themes"]) == count_before,
                json.dumps(node_dbl, ensure_ascii=False),
            )
            page.keyboard.press("Escape")
            page.wait_for_timeout(600)

            # 撤销：新增主题是一步，改名是另一步，所以先撤改名再撤主题
            page.evaluate("() => window.__mindmap.undo()")
            page.wait_for_timeout(800)
            page.evaluate("() => window.__mindmap.undo()")
            page.wait_for_timeout(900)
            undone = info()
            record(
                "5w5",
                "双击新增的主题可以撤销（回到单主题，根节点不会消失）",
                undone["multi"] is False
                and undone["rendered"] == 1
                and undone["rootText"] == "双击加主题导图",
                json.dumps(undone, ensure_ascii=False),
            )

            # 重做回到多主题
            page.evaluate("() => window.__mindmap.redo()")
            page.wait_for_timeout(900)
            redone = info()
            record(
                "5w6",
                "重做能回到多主题",
                redone["multi"] is True and len(redone["themes"]) == 2,
                json.dumps(redone, ensure_ascii=False),
            )

            pg.shot("04w-dbl-theme")
        except Exception as exc:
            for key, name in [
                ("5w0", "初始是单主题"),
                ("5w1", "双击空白区域可以新增主题"),
                ("5w2", "新主题直接进入编辑态，可以马上命名"),
                ("5w3", "新主题能命名成功"),
                ("5w4", "双击节点不会误加主题（而是进入编辑）"),
                ("5w5", "双击新增的主题可以撤销（回到单主题，根节点不会消失）"),
                ("5w6", "重做能回到多主题"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04w-dbl-theme-fail")

        # ---------- 5x 双击空白：在鼠标位置创建主题 ----------
        try:
            pg.reset_workspace("位置创建测试导图")

            def theme_positions():
                return page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    return (s.doc ? s.doc.root.children : []).map(c => ({
                        text: c.text, pos: c.position || null,
                    }));
                }""")

            def canvas_point(pt):
                return page.evaluate(
                    """(p) => {
                        const c = document.querySelector('.mm-canvas');
                        const r = c.getBoundingClientRect();
                        return {x: Math.round(p.x - r.left), y: Math.round(p.y - r.top)};
                    }""",
                    pt,
                )

            before = theme_positions()
            wrap = page.locator(".mm-canvas-wrap").bounding_box()
            cx = wrap["x"] + wrap["width"] * 0.62
            cy = wrap["y"] + wrap["height"] * 0.55
            expect = canvas_point({"x": cx, "y": cy})

            page.mouse.dblclick(cx, cy)
            page.wait_for_timeout(1200)
            page.keyboard.type("点出来的主题")
            page.wait_for_timeout(300)
            page.keyboard.press("Enter")
            page.wait_for_timeout(900)

            after = theme_positions()
            created = next((t for t in after if t["text"] == "点出来的主题"), None)
            record(
                "5x0",
                "双击空白创建的主题带鼠标坐标",
                created is not None and created["pos"] is not None,
                json.dumps(created, ensure_ascii=False),
            )
            record(
                "5x1",
                "新主题就落在双击的位置（误差 ≤ 2px）",
                created is not None
                and created["pos"] is not None
                and abs(created["pos"]["x"] - expect["x"]) <= 2
                and abs(created["pos"]["y"] - expect["y"]) <= 2,
                f"期望 {json.dumps(expect)} 实际 {json.dumps(created['pos'] if created else None)}",
            )

            # 在另一个位置再建一个，两个都应在各自的坐标上
            cx2 = wrap["x"] + wrap["width"] * 0.35
            cy2 = wrap["y"] + wrap["height"] * 0.75
            expect2 = canvas_point({"x": cx2, "y": cy2})
            page.mouse.dblclick(cx2, cy2)
            page.wait_for_timeout(1200)
            page.keyboard.type("第二个点出来的")
            page.wait_for_timeout(300)
            page.keyboard.press("Enter")
            page.wait_for_timeout(900)
            created2 = next((t for t in theme_positions() if t["text"] == "第二个点出来的"), None)
            record(
                "5x3",
                "第二个主题落在它自己的双击位置",
                created2 is not None
                and created2["pos"] is not None
                and abs(created2["pos"]["x"] - expect2["x"]) <= 2
                and abs(created2["pos"]["y"] - expect2["y"]) <= 2,
                f"期望 {json.dumps(expect2)} 实际 {json.dumps(created2['pos'] if created2 else None)}",
            )

            # 已有主题不该被新建动作挪动（基准取"建完第一个之后"，因为单主题时
            # 还没有 children，拿不到基准）
            after_all = theme_positions()
            by_text = {t["text"]: t["pos"] for t in after_all}
            record(
                "5x2",
                "新建主题不会挪动已有的主题",
                by_text.get("位置创建测试导图") is None
                and by_text.get("点出来的主题") == created["pos"]
                and by_text.get("第二个点出来的") == created2["pos"],
                json.dumps(after_all, ensure_ascii=False),
            )

            pg.shot("04x-theme-position")
        except Exception as exc:
            for key, name in [
                ("5x0", "双击空白创建的主题带鼠标坐标"),
                ("5x1", "新主题就落在双击的位置（误差 ≤ 2px）"),
                ("5x2", "创建新主题不会挪动已有的主题"),
                ("5x3", "第二个主题落在它自己的双击位置"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04x-theme-position-fail")

        # ---------- 5y 连线：两端手柄 + 删除 ----------
        try:
            pg.reset_workspace("连线操作测试导图")
            page.evaluate("""() => {
                const s = window.__mindmap.state();
                s.doc.root.children.push(
                    {id: 'yy-a', text: 'A', children: [{id: 'yy-a1', text: 'A1', children: []}]},
                    {id: 'yy-b', text: 'B', children: []}
                );
                window.__mindmap.mutate(s.doc.root);
            }""")
            page.wait_for_timeout(1200)

            def tree():
                return page.evaluate("""() => {
                    const s = window.__mindmap.state();
                    const out = [];
                    const w = (n, d, p) => {
                        out.push({t: n.text, id: n.id, d, parent: p});
                        n.children.forEach(c => w(c, d + 1, n.text));
                    };
                    if (s.doc) w(s.doc.root, 0, null);
                    return {multi: s.doc ? s.doc.multiTheme === true : false, nodes: out};
                }""")

            def node_of(id_):
                return next((x for x in tree()["nodes"] if x["id"] == id_), None)

            def drag_handle(end, target_id):
                h = page.locator(
                    '[data-mm-edge-handle="yy-a"][data-mm-end="' + end + '"]'
                ).bounding_box()
                tb = page.locator('[data-node-id="' + target_id + '"]').bounding_box()
                if h is None or tb is None:
                    raise RuntimeError("找不到手柄或目标节点")
                sx, sy = h["x"] + h["width"] / 2, h["y"] + h["height"] / 2
                tx, ty = tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2
                page.mouse.move(sx, sy)
                page.mouse.down()
                for i in range(1, 11):
                    page.mouse.move(sx + (tx - sx) * i / 10, sy + (ty - sy) * i / 10)
                    page.wait_for_timeout(30)
                ghost = page.locator(".mm-link-ghost").count()
                page.mouse.up()
                page.wait_for_timeout(900)
                return ghost

            # --- v0.22.0：线是独立对象，先选中节点确认"不出现线的工具" ---
            page.evaluate("() => window.__mindmap.select('yy-a')")
            page.wait_for_timeout(800)
            node_tools = page.evaluate("""() => ({
                handles: document.querySelectorAll('[data-mm-edge-handle="yy-a"]').length,
                remove: document.querySelectorAll('[data-mm-edge-remove="yy-a"]').length,
            })""")
            record(
                "5y-0",
                "选中节点时不出现连线的删除按钮和端点手柄（线是独立对象）",
                node_tools["handles"] == 0 and node_tools["remove"] == 0,
                json.dumps(node_tools),
            )
            # 选中线本身才会出现这些工具
            page.evaluate("() => window.__mindmap.selectEdge('yy-a')")
            page.wait_for_timeout(800)
            tools = page.evaluate("""() => ({
                handles: document.querySelectorAll('[data-mm-edge-handle="yy-a"]').length,
                parentEnd: !!document.querySelector('[data-mm-edge-handle="yy-a"][data-mm-end="parent"]'),
                childEnd: !!document.querySelector('[data-mm-edge-handle="yy-a"][data-mm-end="child"]'),
                remove: document.querySelectorAll('[data-mm-edge-remove="yy-a"]').length,
            })""")
            record(
                "5y0",
                "选中连线后，两端各有一个可拖拽端点",
                tools["handles"] == 2 and tools["parentEnd"] and tools["childEnd"],
                json.dumps(tools),
            )
            record("5y1", "连线中点有删除按钮", tools["remove"] == 1, json.dumps(tools))

            # --- 拖父端到 B：A 改挂到 B 下 ---
            ghost = drag_handle("parent", "yy-b")
            moved = node_of("yy-a")
            record(
                "5y2",
                "拖父端可以把节点改挂到另一个节点下",
                moved is not None and moved["parent"] == "B",
                json.dumps(moved, ensure_ascii=False),
            )
            record("5y3", "拖动时显示跟随的虚线", ghost == 1, f"虚影数={ghost}")

            # --- 撤销后拖子端，结果一致 ---
            page.evaluate("() => window.__mindmap.undo()")
            page.wait_for_timeout(800)
            page.evaluate("() => window.__mindmap.selectEdge('yy-a')")
            page.wait_for_timeout(700)
            # 子端手柄也要能用（两端都可操作）。这里只验证手柄能启动拖动，
            # 具体改接语义由 5A7 覆盖。
            ghost_child = drag_handle("child", "yy-b")
            record("5y4", "拖子端也能启动改线（两端都可操作）", ghost_child == 1, f"虚影数={ghost_child}")

            # --- 删除连线：A 变成自由主题，内容不丢 ---
            page.evaluate("() => window.__mindmap.undo()")
            page.wait_for_timeout(800)
            page.evaluate("() => window.__mindmap.selectEdge('yy-a')")
            page.wait_for_timeout(700)
            page.click('[data-mm-edge-remove="yy-a"]')
            page.wait_for_timeout(1000)
            after = tree()
            detached = node_of("yy-a")
            record(
                "5y5",
                "删除连线后节点仍是子节点（层级不变，不会变成主题）",
                # v0.18.0：断边只去掉那条线，节点留在原父级下
                detached is not None
                and detached["parent"] == "连线操作测试导图"
                and after["multi"] is False,
                json.dumps(detached, ensure_ascii=False),
            )
            record(
                "5y6",
                "删边不会丢掉节点的子节点",
                any(x["id"] == "yy-a1" and x["parent"] == "A" for x in after["nodes"]),
                json.dumps([x for x in after["nodes"] if x["id"] == "yy-a1"], ensure_ascii=False),
            )

            # --- 删边可撤销 ---
            page.evaluate("() => window.__mindmap.undo()")
            page.wait_for_timeout(900)
            restored = tree()
            back = node_of("yy-a")
            record(
                "5y7",
                "删除连线可以撤销（回到单主题）",
                restored["multi"] is False and back is not None and back["parent"] == "连线操作测试导图",
                json.dumps(back, ensure_ascii=False),
            )

            pg.shot("04y-edge-tools")
        except Exception as exc:
            for key, name in [
                ("5y0", "选中节点后，它的连线两端各有一个可拖拽端点"),
                ("5y1", "连线中点有删除按钮"),
                ("5y2", "拖父端可以把节点改挂到另一个节点下"),
                ("5y3", "拖动时显示跟随的虚线"),
                ("5y4", "拖子端也能改挂（两端都可操作）"),
                ("5y5", "删除连线后节点变成自由主题（和原主题并列）"),
                ("5y6", "删边不会丢掉节点的子节点"),
                ("5y7", "删除连线可以撤销（回到单主题）"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04y-edge-tools-fail")

        # ---------- 5z 连线作为独立对象：点击选中并编辑 ----------
        try:
            pg.reset_workspace("连线对象测试导图")
            page.evaluate("""() => {
                const s = window.__mindmap.state();
                s.doc.root.children.push(
                    {id: 'zz-a', text: 'A', children: []},
                    {id: 'zz-b', text: 'B', children: []}
                );
                window.__mindmap.mutate(s.doc.root);
            }""")
            page.wait_for_timeout(1200)
            # 先清空选中，确保测的是"点线"本身而不是"点节点"
            page.evaluate("() => { window.__mindmap.select(null); window.__mindmap.selectEdge(null); }")
            page.wait_for_timeout(500)

            def edge_state():
                return page.evaluate("""() => ({
                    edge: window.__mindmap.state().selectedEdgeId,
                    input: !!document.querySelector('.mm-edge-input'),
                    selectedStroke: !!document.querySelector('.mm-link[data-selected="true"]'),
                    handles: document.querySelectorAll('[data-mm-edge-handle]').length,
                    remove: document.querySelectorAll('[data-mm-edge-remove]').length,
                })""")

            def label_of(id_):
                return page.evaluate(
                    """(target) => {
                        const s = window.__mindmap.state();
                        let found = null;
                        const w = (n) => { if (n.id === target) found = n.edgeLabel || null; n.children.forEach(w); };
                        if (s.doc) w(s.doc.root);
                        return found;
                    }""",
                    id_,
                )

            # 点在连线上（子节点左边缘往左 12px，那里一定是线）
            a = page.locator('[data-node-id="zz-a"]').bounding_box()
            page.mouse.click(a["x"] - 12, a["y"] + a["height"] / 2)
            page.wait_for_timeout(900)

            st = edge_state()
            record("5z0", "点击连线可以选中这条边", st["edge"] == "zz-a", json.dumps(st))
            record("5z1", "选中的连线会高亮", st["selectedStroke"] is True, json.dumps(st))
            # v0.29.0：单击只选中，不弹输入框（避免挡住线本身、误触发）
            record("5z2", "单击连线只选中，不弹文字输入框", st["input"] is False, json.dumps(st))
            # 双击才打开文字编辑
            page.mouse.dblclick(a["x"] - 12, a["y"] + a["height"] / 2)
            page.wait_for_timeout(900)
            st2 = edge_state()
            record("5z2b", "双击连线出现文字编辑框", st2["input"] is True, json.dumps(st2))
            record(
                "5z3",
                "选中连线后两端手柄与删除按钮都出现",
                st["handles"] == 2 and st["remove"] == 1,
                json.dumps(st),
            )

            # 编辑文字（双击后输入框已打开）
            if st2["input"]:
                page.fill(".mm-edge-input", "点线编辑的文字")
                page.keyboard.press("Enter")
                page.wait_for_timeout(900)
            record("5z4", "连线文字能保存并渲染", label_of("zz-a") == "点线编辑的文字", json.dumps(label_of("zz-a"), ensure_ascii=False))
            record(
                "5z5",
                "连线文字显示在画布上（画在节点之上，不被盖住）",
                page.evaluate("""() => {
                    const el = document.querySelector('[data-mm-edge-label="zz-a"]');
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    const cs = getComputedStyle(el);
                    // 标签是 pointer-events:none（点它要穿透到线上），所以不能用
                    // elementFromPoint 判断；改看它确实有尺寸、且 z-index 高于节点
                    return r.width > 0 && r.height > 0 && Number(cs.zIndex) >= 4;
                }"""),
            )

            # 拖端点仍然能改关联（不能被"点击"逻辑吞掉）
            page.evaluate("() => window.__mindmap.selectEdge('zz-a')")
            page.wait_for_timeout(600)
            # 改挂要拖**父端**（子端是"改这条线连到谁"）
            h = page.locator('[data-mm-edge-handle="zz-a"][data-mm-end="parent"]').bounding_box()
            tb = page.locator('[data-node-id="zz-b"]').bounding_box()
            sx, sy = h["x"] + h["width"] / 2, h["y"] + h["height"] / 2
            tx, ty = tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2
            page.mouse.move(sx, sy)
            page.mouse.down()
            for i in range(1, 11):
                page.mouse.move(sx + (tx - sx) * i / 10, sy + (ty - sy) * i / 10)
                page.wait_for_timeout(30)
            page.mouse.up()
            page.wait_for_timeout(900)
            parent = page.evaluate("""() => {
                const s = window.__mindmap.state();
                let p = null;
                const w = (n, pn) => { if (n.id === 'zz-a') p = pn; n.children.forEach(c => w(c, n.text)); };
                if (s.doc) w(s.doc.root, null);
                return p;
            }""")
            record("5z6", "拖动端点仍能改关联（点击逻辑不会吞掉拖动）", parent == "B", json.dumps(parent, ensure_ascii=False))

            # 点空白取消连线选中
            page.evaluate("() => window.__mindmap.selectEdge('zz-a')")
            page.wait_for_timeout(400)
            # 点外层容器的空白处（布局范围之外的区域，v0.16.0 起也会取消选中）
            blank = page.locator(".mm-canvas-wrap").bounding_box()
            page.mouse.click(blank["x"] + blank["width"] - 40, blank["y"] + blank["height"] - 40)
            page.wait_for_timeout(700)
            record(
                "5z7",
                "点空白处取消连线选中",
                page.evaluate("() => window.__mindmap.state().selectedEdgeId === null"),
            )

            pg.shot("04z-edge-object")
        except Exception as exc:
            for key, name in [
                ("5z0", "点击连线可以选中这条边"),
                ("5z1", "选中的连线会高亮"),
                ("5z2", "点击连线直接出现文字编辑框"),
                ("5z3", "选中连线后两端手柄与删除按钮都出现"),
                ("5z4", "连线文字能保存并渲染"),
                ("5z5", "连线文字显示在画布上（不会被节点盖住）"),
                ("5z6", "拖动端点仍能改关联（点击逻辑不会吞掉拖动）"),
                ("5z7", "点空白处取消连线选中"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04z-edge-object-fail")

        # ---------- 5A 自由连线 + 改接语义 ----------
        try:
            pg.reset_workspace("关系线测试导图")
            page.evaluate("""() => {
                const s = window.__mindmap.state();
                s.doc.root.children.push(
                    {id: 'wa', text: 'A', children: [{id: 'wa2', text: 'A2', children: []}]},
                    {id: 'wb', text: 'B', children: []},
                    {id: 'wc', text: 'C', children: []}
                );
                window.__mindmap.mutate(s.doc.root);
            }""")
            page.wait_for_timeout(1200)

            def links():
                return page.evaluate("""() => (window.__mindmap.state().doc.links || [])
                    .map(l => ({from: l.from, to: l.to, label: l.label || null}))""")

            def drag_dot(from_id, to_id):
                d = page.locator('[data-mm-link-dot="' + from_id + '"]').bounding_box()
                t = page.locator('[data-node-id="' + to_id + '"]').bounding_box()
                if d is None or t is None:
                    raise RuntimeError("找不到拉线圆点或目标节点")
                sx, sy = d["x"] + d["width"] / 2, d["y"] + d["height"] / 2
                tx, ty = t["x"] + t["width"] / 2, t["y"] + t["height"] / 2
                page.mouse.move(sx, sy)
                page.mouse.down()
                for i in range(1, 11):
                    page.mouse.move(sx + (tx - sx) * i / 10, sy + (ty - sy) * i / 10)
                    page.wait_for_timeout(30)
                page.mouse.up()
                page.wait_for_timeout(900)

            # --- 从节点拉出关系线 ---
            page.evaluate("() => window.__mindmap.select('wa')")
            page.wait_for_timeout(700)
            record("5A0", "选中节点后出现拉线圆点", page.locator('[data-mm-link-dot="wa"]').count() == 1)
            drag_dot("wa", "wb")
            record("5A1", "可以从节点拉出一条关系线", links() == [{"from": "wa", "to": "wb", "label": None}], json.dumps(links()))
            record("5A2", "关系线以虚线渲染", page.locator(".mm-free-link").count() == 1)

            # --- 同一节点可以拉出多条 ---
            page.evaluate("() => window.__mindmap.select('wa')")
            page.wait_for_timeout(600)
            drag_dot("wa", "wc")
            record("5A3", "同一个节点可以连出多条关系线", len(links()) == 2, json.dumps(links()))

            # --- 点关系线可选中并删除 ---
            ab = page.locator('[data-node-id="wa"]').bounding_box()
            bb = page.locator('[data-node-id="wb"]').bounding_box()
            # 靠近 B 的顶边取点（A 底部有拉线圆点，会挡住）
            page.mouse.click(ab["x"] + ab["width"] / 2, bb["y"] - 4)
            page.wait_for_timeout(800)
            record(
                "5A4",
                "点击关系线可以选中它",
                page.evaluate("() => window.__mindmap.state().selectedFreeLinkId !== null"),
            )
            if page.locator("[data-mm-free-link-remove]").count() > 0:
                page.click("[data-mm-free-link-remove]")
                page.wait_for_timeout(800)
            record("5A5", "关系线可以删除", len(links()) == 1, json.dumps(links()))

            # --- 撤销 ---
            page.evaluate("() => window.__mindmap.undo()")
            page.wait_for_timeout(800)
            record("5A6", "删除关系线可以撤销", len(links()) == 2, json.dumps(links()))

            # --- 拖尾端改接：A->A2 拖到 C，应变成 A->C ---
            page.evaluate("() => window.__mindmap.selectEdge('wa2')")
            page.wait_for_timeout(700)
            h = page.locator('[data-mm-edge-handle="wa2"][data-mm-end="child"]').bounding_box()
            tc = page.locator('[data-node-id="wc"]').bounding_box()
            sx, sy = h["x"] + h["width"] / 2, h["y"] + h["height"] / 2
            tx, ty = tc["x"] + tc["width"] / 2, tc["y"] + tc["height"] / 2
            page.mouse.move(sx, sy)
            page.mouse.down()
            for i in range(1, 11):
                page.mouse.move(sx + (tx - sx) * i / 10, sy + (ty - sy) * i / 10)
                page.wait_for_timeout(30)
            page.mouse.up()
            page.wait_for_timeout(1000)
            shape = page.evaluate("""() => {
                const s = window.__mindmap.state();
                const out = [];
                const w = (n, p) => { out.push({id: n.id, parent: p}); n.children.forEach(c => w(c, n.id)); };
                if (s.doc) w(s.doc.root, null);
                return out;
            }""")
            parent_of = {x["id"]: x["parent"] for x in shape}
            record(
                "5A7",
                "拖连线尾端改的是这条线连到谁（A->A2 拖到 C 变成 A->C）",
                # C 挂到 A 下；A2 升格成自由主题（父级是那个不渲染的容器，不是 None）
                parent_of.get("wc") == "wa" and parent_of.get("wa2") not in (None, "wa"),
                json.dumps(parent_of, ensure_ascii=False),
            )

            # --- 删边后节点原地不动（v0.22.0：先选中线才有删除按钮）---
            page.evaluate("() => window.__mindmap.selectEdge('wb')")
            page.wait_for_timeout(700)
            # 用布局坐标而不是屏幕矩形：屏幕位置会随滚动变化，和"原地不动"无关
            before_pos = page.evaluate("""() => {
                const el = document.querySelector('[data-node-id="wb"]');
                return {x: Math.round(parseFloat(el.style.left)), y: Math.round(parseFloat(el.style.top))};
            }""")
            if page.locator('[data-mm-edge-remove="wb"]').count() > 0:
                page.click('[data-mm-edge-remove="wb"]')
                page.wait_for_timeout(1000)
            after_pos = page.evaluate("""() => {
                const el = document.querySelector('[data-node-id="wb"]');
                if (!el) return null;
                return {x: Math.round(parseFloat(el.style.left)), y: Math.round(parseFloat(el.style.top))};
            }""")
            record(
                "5A8",
                "删除连线后节点原地不动（不会跳到别处）",
                after_pos is not None
                and abs(after_pos["x"] - before_pos["x"]) <= 2
                and abs(after_pos["y"] - before_pos["y"]) <= 2,
                f"{json.dumps(before_pos)} → {json.dumps(after_pos)}",
            )

            pg.shot("04A-free-link")
        except Exception as exc:
            for key, name in [
                ("5A0", "选中节点后出现拉线圆点"),
                ("5A1", "可以从节点拉出一条关系线"),
                ("5A2", "关系线以虚线渲染"),
                ("5A3", "同一个节点可以连出多条关系线"),
                ("5A4", "点击关系线可以选中它"),
                ("5A5", "关系线可以删除"),
                ("5A6", "删除关系线可以撤销"),
                ("5A7", "拖连线尾端改的是这条线连到谁"),
                ("5A8", "删除连线后节点原地不动"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04A-free-link-fail")

        # ---------- 5B 记住视口位置 ----------
        try:
            pg.reset_workspace("视口记忆导图")
            page.wait_for_timeout(1200)

            def view():
                return page.evaluate("""() => {
                    const w = document.querySelector('.mm-canvas-wrap');
                    return {left: Math.round(w.scrollLeft), top: Math.round(w.scrollTop),
                            zoom: document.querySelector('[data-mm-action="zoom-reset"]').textContent.trim()};
                }""")

            # 挪到一个明确的位置 + 缩放
            page.evaluate("""() => {
                const w = document.querySelector('.mm-canvas-wrap');
                w.scrollLeft = 1200; w.scrollTop = 900;
            }""")
            page.wait_for_timeout(300)
            page.evaluate("() => document.querySelector('.mm-canvas').focus()")
            page.keyboard.press("Control+=")
            page.wait_for_timeout(700)
            moved = view()
            # 等防抖写入 localStorage
            page.wait_for_timeout(900)

            # 回列表再打开同一份文档
            page.evaluate("() => window.__mindmap.back()")
            page.wait_for_timeout(1200)
            page.evaluate("""() => {
                const st = window.__mindmap.state();
                const target = st.docs.find(d => d.title === '视口记忆导图');
                window.__mindmap.open(target.id);
            }""")
            page.wait_for_timeout(2000)
            restored = view()
            record(
                "5B0",
                "重新打开导图会回到上次的视口位置和缩放",
                restored["left"] == moved["left"]
                and restored["top"] == moved["top"]
                and restored["zoom"] == moved["zoom"],
                f"{json.dumps(moved)} → {json.dumps(restored)}",
            )

            # 换一份文档不应该串用别的文档的视口
            page.evaluate("() => window.__mindmap.back()")
            page.wait_for_timeout(800)
            other = page.evaluate("""() => {
                const st = window.__mindmap.state();
                const t = st.docs.find(d => d.title === '视口记忆导图');
                return t ? t.id : null;
            }""")
            record("5B1", "视口记录按文档区分（存在 localStorage 里）",
                   page.evaluate("""(id) => !!window.localStorage.getItem('dsh-mindmap:view:' + id)""", other))

            pg.shot("04B-view")
        except Exception as exc:
            for key, name in [
                ("5B0", "重新打开导图会回到上次的视口位置和缩放"),
                ("5B1", "视口记录按文档区分（存在 localStorage 里）"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04B-view-fail")

        # ---------- 5C 内容搜索定位 ----------
        try:
            pg.reset_workspace("搜索定位导图")
            page.wait_for_timeout(1200)
            page.evaluate("""() => {
                const st = window.__mindmap.state();
                for (let i = 1; i <= 20; i++) {
                    st.doc.root.children.push({
                        id: 'sc' + i,
                        text: (i % 4 === 0 ? '硬脂酸锌' : '普通节点') + i,
                        children: [],
                    });
                }
                window.__mindmap.mutate(st.doc.root);
            }""")
            page.wait_for_timeout(1200)

            # Cmd/Ctrl+F 打开搜索框
            page.evaluate("() => document.querySelector('.mm-canvas').focus()")
            page.keyboard.press("Control+f")
            page.wait_for_timeout(600)
            record("5C0", "Ctrl/Cmd+F 打开搜索框", page.locator('[data-mm-search-input]').count() == 1)

            page.fill('[data-mm-search-input]', '硬脂酸锌')
            page.wait_for_timeout(900)
            count_text = page.locator('[data-mm-search-count]').inner_text()
            highlighted = page.locator('.mm-node[data-match="true"]').count()
            record(
                "5C1",
                "搜索会高亮所有匹配节点并显示计数",
                count_text == "1/5" and highlighted == 5,
                f"计数={count_text} 高亮={highlighted}",
            )

            selected = page.evaluate("() => window.__mindmap.state().selectedId")
            record(
                "5C2",
                "搜索自动跳到第一个匹配并选中它",
                selected is not None
                and page.locator('.mm-node[data-match-current="true"]').count() == 1,
            )

            page.keyboard.press("Enter")
            page.wait_for_timeout(700)
            second = page.locator('[data-mm-search-count]').inner_text()
            page.keyboard.press("Enter")
            page.wait_for_timeout(700)
            third = page.locator('[data-mm-search-count]').inner_text()
            record(
                "5C3",
                "Enter 在匹配之间循环跳转",
                second == "2/5" and third == "3/5",
                f"{count_text} → {second} → {third}",
            )

            page.fill('[data-mm-search-input]', '这个词一定不存在')
            page.wait_for_timeout(700)
            record(
                "5C4",
                "没有匹配时明确提示「无匹配」且不高亮",
                page.locator('[data-mm-search-count]').inner_text() == "无匹配"
                and page.locator('.mm-node[data-match="true"]').count() == 0,
            )

            page.fill('[data-mm-search-input]', '硬脂酸锌')
            page.wait_for_timeout(600)
            page.keyboard.press("Escape")
            page.wait_for_timeout(600)
            record(
                "5C5",
                "Esc 关闭搜索并清掉高亮",
                page.locator('[data-mm-search-input]').count() == 0
                and page.locator('.mm-node[data-match="true"]').count() == 0,
            )

            pg.shot("04C-search")
        except Exception as exc:
            for key, name in [
                ("5C0", "Ctrl/Cmd+F 打开搜索框"),
                ("5C1", "搜索会高亮所有匹配节点并显示计数"),
                ("5C2", "搜索自动跳到第一个匹配并选中它"),
                ("5C3", "Enter 在匹配之间循环跳转"),
                ("5C4", "没有匹配时明确提示「无匹配」且不高亮"),
                ("5C5", "Esc 关闭搜索并清掉高亮"),
            ]:
                if not any(r["key"] == key for r in results):
                    record(key, name, False, str(exc)[:200])
            pg.shot("04C-search-fail")

        # ---------- 6 保存 + 刷新后仍在 ----------
        try:
            page.evaluate("window.__mindmap.flush()")
            page.wait_for_timeout(1200)
            # 用「当前文档」的真实标题做断言，不硬编码：
            # 前面的用例会新建/改名，写死的标题早就不存在了，
            # 那样失败信息会指向错误的方向。
            before = page.evaluate("window.__mindmap.state().doc.title")
            before_nodes = len(pg.tree_sig())
            page.reload(wait_until="load", timeout=90000)
            page.wait_for_timeout(5000)
            pg.open_panel()
            page.wait_for_selector(".mm-doc", timeout=15000)
            titles = page.locator(".mm-doc-title").all_inner_texts()
            record(
                "6",
                "刷新后导图仍在（Host 持久化生效）",
                before in titles,
                "列表=" + json.dumps(titles, ensure_ascii=False)[:200] + " 期望=" + str(before),
            )

            # 打开它，确认节点数也一致（不只是列表里有这一条）
            page.evaluate("""async (t) => {
                const st = window.__mindmap.state();
                const found = st.docs.find(d => d.title === t);
                if (found) await window.__mindmap.open(found.id);
            }""", before)
            page.wait_for_timeout(1500)
            after_nodes = len(pg.tree_sig())
            record(
                "6b",
                "刷新后节点数与刷新前一致",
                after_nodes == before_nodes,
                f"{before_nodes} → {after_nodes} 节点",
            )
            pg.shot("05-after-reload")
        except Exception as exc:
            record("6", "刷新后导图仍在（Host 持久化生效）", False, str(exc)[:200])
            pg.shot("05-reload-fail")

        # ---------- 7/8 Markdown ----------
        try:
            # 6b 打开过文档，此刻可能已经在画布上；只在确实停在列表时才点进去。
            if page.locator(".mm-doc").count() > 0:
                page.locator(".mm-doc").first.click()
            page.wait_for_selector(".mm-node", timeout=15000)
            page.wait_for_timeout(600)
            page.click('[data-mm-action="markdown"]')
            page.wait_for_selector('[data-mm-panel="markdown"]', timeout=15000)
            headings_md = page.input_value(".mm-md-text")
            record(
                "7",
                "标题形态 Markdown 输出（以 # 开头）",
                headings_md.lstrip().startswith("#"),
                headings_md[:80].replace("\n", "\\n"),
            )
            pg.shot("06-markdown-headings")

            # 切到列表形态
            page.get_by_role("button", name="列表", exact=True).click()
            page.wait_for_timeout(500)
            list_md = page.input_value(".mm-md-text")
            record(
                "8",
                "列表形态 Markdown 输出（以 - 开头）",
                list_md.lstrip().startswith("- "),
                list_md[:80].replace("\n", "\\n"),
            )
            pg.shot("07-markdown-list")
        except Exception as exc:
            record("7", "标题形态 Markdown 输出（以 # 开头）", False, str(exc)[:200])
            record("8", "列表形态 Markdown 输出（以 - 开头）", False, str(exc)[:200])
            pg.shot("06-markdown-fail")

        # ---------- 9 复制按钮 ----------
        try:
            # 授权剪贴板（headless 里 clipboard-write 需要显式给权限）
            ctx.grant_permissions(["clipboard-read", "clipboard-write"])
            page.get_by_role("button", name="标题", exact=True).click()
            page.wait_for_timeout(300)
            page.click('[data-mm-action="copy-md"]')
            page.wait_for_timeout(700)
            clip = page.evaluate("navigator.clipboard.readText()")
            record("9a", "复制 Markdown 到剪贴板成功", len(clip or "") > 0, (clip or "")[:60].replace("\n", "\\n"))
            record("9b", "下载按钮存在", page.locator('[data-mm-action="download"]').count() == 1)
        except Exception as exc:
            record("9a", "复制 Markdown 到剪贴板成功", False, str(exc)[:200])
            record("9b", "下载按钮存在", False, str(exc)[:200])

        # ---------- 10 删除 ----------
        try:
            # 回到列表：Markdown 只是侧栏，不在列表页出现，所以只需点「← 返回」。
            for _ in range(3):
                if page.locator(".mm-doc").count() > 0:
                    break
                page.get_by_role("button", name="← 返回").first.click()
                page.wait_for_timeout(700)
            if page.locator(".mm-doc").count() == 0:
                raise RuntimeError("没能回到导图列表")
            # 删一份：断言"数量确实减一"，而不是"归零"——
            # 之前断言归零是脆的：任何前面多建一份文档的用例都会让它失败，
            # 而失败原因和"删除功能坏了"完全无关。测删除就要只测删除。
            before_count = page.evaluate("window.__mindmap.state().docs.length")

            # 只删**测试自己建的**那份，不点"列表第一个"：
            # 列表里可能还有用户的真实导图，按位置点会删错东西。
            target_id = page.evaluate("""(foreign) => {
                const s = window.__mindmap.state();
                const f = new Set(foreign);
                const own = s.docs.find(d => !f.has(d.id));
                return own ? own.id : null;
            }""", sorted(pg.foreign_ids))
            if target_id is None:
                raise RuntimeError("列表里没有测试自己创建的文档可删")
            page.once("dialog", lambda dialog: dialog.accept())
            page.click(f'[aria-label^="删除"][data-mm-doc="{target_id}"]')
            page.wait_for_timeout(1200)
            after_count = page.evaluate("window.__mindmap.state().docs.length")
            record(
                "10",
                "删除导图后列表减少一份",
                after_count == before_count - 1,
                f"{before_count} → {after_count}",
            )

            # 清掉测试自己建的，保证下次跑测试是干净起点（用户的不动）。
            # 识别不出既有文档时跳过清理——宁可留垃圾，不可删数据。
            if pg.foreign_ok:
                page.evaluate("""async (foreign) => {
                const st = window.__mindmap.state();
                const f = new Set(foreign);
                for (const d of st.docs) {
                    if (f.has(d.id)) continue;
                    await fetch('/mindmap/docs.remove', {method:'POST',
                        headers:{'content-type':'application/json'},
                        body: JSON.stringify({type:'client-request', rpcId:'cleanup-'+d.id,
                            method:'docs.remove', payload:{id:d.id}})});
                }
            }""", sorted(pg.foreign_ids))
            page.wait_for_timeout(800)
            page.reload(wait_until="load", timeout=90000)
            page.wait_for_timeout(5000)
            pg.open_panel()
            pg.shot("08-deleted")
        except Exception as exc:
            record("10", "删除导图后列表归零", False, str(exc)[:200])
            pg.shot("08-delete-fail")

        return finish(browser, console_errors)


def finish(browser, console_errors) -> int:
    # 只看插件自身的报错：宿主的其它插件（modsearch 等）会有无关噪音
    plugin_errors = [
        line
        for line in console_errors
        if PLUGIN_ID in line or "mindmap" in line.lower() or "mindmap" in line.lower()
    ]
    record("11", "控制台无插件自身报错", len(plugin_errors) == 0, "; ".join(plugin_errors[:3])[:300])
    if console_errors:
        print("\n[全部 console error，仅供参考]", flush=True)
        for line in console_errors[:12]:
            print("   " + line, flush=True)

    browser.close()

    passed = sum(1 for r in results if r["ok"])
    total = len(results)
    print(f"\n===== {passed}/{total} 通过 =====", flush=True)
    for r in results:
        if not r["ok"]:
            print("  FAILED: " + r["key"] + " " + r["name"] + " " + r["detail"], flush=True)
    return 0 if passed == total else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
