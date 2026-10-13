#!/usr/bin/env python3
"""
bundle-regression.py — 兜兜 GoSim 真实运行回归（端到端，非静态检查）

它驱动真实的 card-host 进程跑一遍应用，断言的不是"代码里有没有这段字符串"，
而是"人在界面上真的能看到这些数字和行为"。

两个阶段：
  Phase A  全新数据：建档 -> 预设情景 -> 自定义事件 -> 决策回执 -> AI 降级
  Phase B  用同一份 app-data 重启：验证事件持久化与月份映射真的恢复了

历史遗留：v0.3.1 候选包证据里有两项 FAIL（已保存事件恢复 / 事件列表第2月）。
根因是旧脚本的两处缺陷，不是应用缺陷：
  1. 旧脚本找 "做决定" 按钮，但界面上真实存在的是 "做下去 / 先留着 / 等一等"；
  2. 旧脚本的 click_visible 只会向下滚，找不到按钮时把页面滚到底，
     导致顶部导航按钮被滚出视口（rect 归零）后永远点不到。
本脚本修掉这两点：用真实按钮名，并在点导航按钮前先回滚到顶部；
持久化改为"重启进程后检查"，这比"来回点页面"更能证明事件真的落盘了。

用法：
    python3 test/bundle-regression.py                    # 默认跑仓库里的 bundle/
    python3 test/bundle-regression.py --bundle path/to/bundle
环境变量：
    OCTO       octo 工具路径（默认 ~/octosense-ws/OctoScript-App-Design-Flow/tools/octo）
"""

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request

DEFAULT_OCTO = os.path.expanduser("~/octosense-ws/OctoScript-App-Design-Flow/tools/octo")


class App:
    """A running card-host process driven over the makepad remote bridge."""

    def __init__(self, bundle, port, app_data):
        self.bundle = bundle
        self.port = port
        self.app_data = app_data
        self.octo = os.environ.get("OCTO", DEFAULT_OCTO)
        self.op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.proc = None

    # ---- lifecycle -------------------------------------------------------
    def start(self):
        cmd = [sys.executable, self.octo, "run", self.bundle,
               "--port", str(self.port), "--hidden", "--detach",
               "--app-data", self.app_data]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        out = (r.stdout or "") + (r.stderr or "")
        if r.returncode != 0:
            raise RuntimeError("octo run failed:\n" + out)
        time.sleep(1.5)

    def stop(self):
        try:
            self.op.open(f"http://127.0.0.1:{self.port}/quit", timeout=5).read()
        except Exception:
            pass
        time.sleep(1.5)

    # ---- bridge ----------------------------------------------------------
    def fetch(self, path):
        return self.op.open(f"http://127.0.0.1:{self.port}{path}", timeout=20).read()

    def snap(self):
        return json.loads(self.fetch("/snap?all=1")).get("s", [])

    def texts(self):
        out = []
        for w in self.snap():
            if w.get("ty") == "Splash":
                continue
            t = str(w.get("t", "")).strip()
            if t and len(t) < 200:
                out.append(t)
        return out

    def buttons(self):
        out = []
        for w in self.snap():
            if w.get("ty") in ("Button", "ButtonFlat", "ButtonFlatter"):
                r = w.get("r")
                if r and r[2] > 0 and r[3] > 0 and r[1] > 0:
                    out.append((str(w.get("t", "")),
                                int(r[0] + r[2] / 2), int(r[1] + r[3] / 2)))
        return out

    def scroll(self, dy):
        self.fetch(f"/m?k=scroll&dx=0&dy={dy}&x=206&y=500&wait=1")
        time.sleep(0.35)

    def scroll_top(self):
        for _ in range(10):
            self.scroll(-500)

    def click(self, label, scroll=True, max_scroll=25):
        """Click the first visible button whose text contains `label`.

        Unlike the script this replaces, we scroll back to the top before each
        sweep: a top-of-page nav button that was pushed out of the viewport by a
        previous downward sweep gets a zero rect and would never be clickable.
        """
        for _ in range(max_scroll + 1):
            self.scroll_top()
            for t, x, y in self.buttons():
                if label in t:
                    self.fetch(f"/click?x={x}&y={y}&wait=1")
                    return True
            if not scroll:
                return False
            self.scroll(220)
        return False

    def type_into_first_input(self, text):
        for w in self.snap():
            if w.get("ty") in ("TextInput", "TextArea"):
                r = w.get("r")
                if r and r[2] > 0:
                    x = int(r[0] + r[2] / 2)
                    y = int(r[1] + r[3] / 2)
                    self.fetch(f"/click?x={x}&y={y}&wait=1")
                    break
        time.sleep(0.3)
        for _ in range(30):
            self.fetch("/k?k=down&c=Backspace")
            self.fetch("/k?k=up&c=Backspace")
        time.sleep(0.2)
        self.fetch("/t?text=" + urllib.parse.quote(text))
        time.sleep(0.4)


class Report:
    def __init__(self):
        self.rows = []

    def check(self, name, cond, detail=""):
        self.rows.append((name, bool(cond), detail))
        print(("PASS " if cond else "FAIL ") + name + (" | " + detail if detail else ""),
              flush=True)
        return bool(cond)

    @property
    def failed(self):
        return [r for r in self.rows if not r[1]]

    def summary(self):
        total = len(self.rows)
        failed = len(self.failed)
        print(f"\n=== 共 {total} 项，PASS {total - failed}，FAIL {failed} ===")
        for n, ok, d in self.rows:
            print(f"{'PASS' if ok else 'FAIL'} {n}")
        return failed == 0


def onboard(app):
    app.click("建立我的家庭情况", scroll=False)
    time.sleep(2)

    def step(val):
        app.type_into_first_input(val)
        time.sleep(0.3)
        if not app.click("继续", scroll=False):
            app.click("完成", scroll=False)
        time.sleep(1.5)

    # 月收入 4 万 / 房贷 0 / 生活 2.7 万 / 存款 80 万 / 安全底线 12 个月
    for v in ("40000", "0", "27000", "800000", "12"):
        step(v)
    time.sleep(2)


def phase_a(app, rep):
    onboard(app)
    ts = app.texts()
    rep.check("建档成功(基线 29.6 个月)", any(t == "29.6" for t in ts),
              "80 万 / 2.7 万 = 29.6")

    # --- 预设情景 1：买车 30 万 -------------------------------------------
    app.click("买车", scroll=False)
    time.sleep(2.5)
    ts = app.texts()
    rep.check("买车情景(安全垫 29.6 → 19 个月)",
              any(t == "19" for t in ts) and any("29.6" in t and "19 " in t for t in ts),
              "第 1 月一次性 -30 万：80 万 + 1×1.3 万 - 30 万 = 51.3 万；51.3/2.7 = 19.0")
    rep.check("买车情景(期末现金 51.3 万)", any("51.3" in t for t in ts))

    app.click("← 回到现在", scroll=False)
    time.sleep(1.5)

    # --- 预设情景 2：休息 18 个月 -----------------------------------------
    app.click("休息 18M", scroll=False)
    time.sleep(2.5)
    ts = app.texts()
    rep.check("休息18月(第 18 月跌破 12 个月底线)",
              any("第 18 个月跌破" in t for t in ts))
    rep.check("休息18月(安全垫 11.6 个月 / 期末现金 31.4 万)",
              any(t == "11.6" for t in ts) and any("31.4" in t for t in ts))

    # --- 决策回执 ---------------------------------------------------------
    # 界面上真实存在的按钮是「做下去 / 先留着 / 等一等」，没有「做决定」。
    rep.check("决策按钮存在(做下去)", app.click("做下去", scroll=True))
    time.sleep(2.5)
    ts = app.texts()
    rep.check("决策回执(已记录决定)", any("已记录决定" in t for t in ts))
    app.click("回到现在", scroll=False)
    time.sleep(1.5)

    # --- 自定义事件：第 2 月一次性支出 30 万 -------------------------------
    app.click("自定义事件", scroll=True)
    time.sleep(2)
    ts = app.texts()
    rep.check("进入自定义事件页", any("自定义事件 · 不用 AI 也能算" in t for t in ts))
    rep.check("发生月份默认为 1(1-based)", any(t.startswith("发生月份：1") for t in ts))

    app.click("一次性购买", scroll=False)
    time.sleep(1)
    app.type_into_first_input("回归购车")
    app.click("名称", scroll=False)
    time.sleep(0.8)
    app.type_into_first_input("300000")
    app.click("一次性现金变化", scroll=False)
    time.sleep(0.8)
    app.type_into_first_input("0")
    app.click("持续月数", scroll=False)
    time.sleep(0.8)
    app.type_into_first_input("2")
    app.click("发生月份", scroll=False)
    time.sleep(0.8)
    ts = app.texts()
    rep.check("发生月份回显 2(1-based)", any(t.startswith("发生月份：2") for t in ts))

    app.click("确认并计算", scroll=True)
    time.sleep(2.5)
    ts = app.texts()
    rep.check("第 2 月一次性支出(期末现金 52.6 万)",
              any("52.6" in t for t in ts),
              "80 万 + 2×1.3 万 - 30 万 = 52.6 万")
    rep.check("扣款标注在第 2 月", any("第 2 月" in t for t in ts))

    # --- AI：探测与真实调用 ------------------------------------------------
    app.click("← 回到现在", scroll=False)
    time.sleep(1.2)
    app.click("自定义事件", scroll=True)
    time.sleep(1.5)

    app.click("检查 AI 通道", scroll=True)
    time.sleep(1.5)
    ts = app.texts()
    rep.check("AI 通道探测如实说明(不宣称已接通)",
              any("host.has 只是提示" in t for t in ts))

    app.type_into_first_input("从第 3 个月开始，连续 2 个月没有工资收入")
    time.sleep(0.5)
    app.click("用 AI 理解这句话", scroll=True)
    time.sleep(4)
    ts = app.texts()
    degraded = any(("没有提供模型服务" in t) or ("未获授" in t) or ("Provider" in t)
                   or ("模型调用失败" in t) or ("预算" in t) for t in ts)
    rep.check("无 model 服务时诚实降级", degraded,
              "card-host 不提供 model 服务，这是真实调用后的返回")
    rep.check("未伪造 AI 草稿(不出现已生成草稿)",
              not any("已生成草稿" in t for t in ts))
    rep.check("降级后手动建事件路径仍在",
              any("确认并计算" in t for t in ts))


def phase_b(app, rep, app_data):
    """同一份 app-data 重启：证明事件真的落盘并恢复了。"""
    path = os.path.join(app_data, "doudou", "events.json")
    if os.path.exists(path):
        try:
            data = json.loads(open(path).read())
            ev = (data.get("events") or [{}])[0]
            rep.check("events.json 落盘", True, json.dumps(ev, ensure_ascii=False))
            rep.check("start_month 以 0-based 存(第 2 月 → 1)",
                      ev.get("start_month") == 1, f"start_month={ev.get('start_month')}")
        except Exception as exc:  # noqa: BLE001
            rep.check("events.json 落盘", False, str(exc))
    else:
        rep.check("events.json 落盘", False, f"不存在：{path}")

    ts = app.texts()
    rep.check("重启后已保存事件恢复", any("回归购车" in t for t in ts))
    rep.check("重启后事件列表显示「第 2 月起」", any("第 2 月起" in t for t in ts))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default=os.path.join(root, "bundle"))
    ap.add_argument("--port", type=int, default=8877)
    ap.add_argument("--app-data", default="/tmp/doudou-regression-appdata")
    args = ap.parse_args()

    if os.path.exists(args.app_data):
        subprocess.run(["rm", "-rf", args.app_data], check=True)
    os.makedirs(args.app_data, exist_ok=True)

    rep = Report()
    app = App(args.bundle, args.port, args.app_data)

    print("=== Phase A：全新数据 ===", flush=True)
    app.start()
    try:
        phase_a(app, rep)
    finally:
        app.stop()

    print("\n=== Phase B：同数据重启（持久化恢复）===", flush=True)
    app.start()
    try:
        # 重启后应在首页，直接进入事件页看已保存事件
        app.click("自定义事件", scroll=True)
        time.sleep(2)
        phase_b(app, rep, args.app_data)
    finally:
        app.stop()

    ok = rep.summary()
    out = os.path.join(here, "bundle-regression-progress.txt")
    with open(out, "w") as f:
        for n, c, d in rep.rows:
            f.write(f"{'PASS' if c else 'FAIL'} {n} | {d}\n")
    print(f"\n结果已写入：{out}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
