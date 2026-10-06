# 提交材料（Submission materials）

这一目录只放**对外展示与提交用的材料**，不含代码，也不参与 App Hub 的 bundle 门禁。

```
docs/submission/
├── doudou-v0.2.0-demo.mp4       演示视频（v0.2.0，card-host 真实运行）
└── screenshots/
    ├── 01-main.png              首页：29.6 个月 / 安全底线 12 个月
    ├── 02-car-scenario.png      买车场景：18.5 个月
    └── 03-breach.png            休息 18M：11.6 个月，跌破底线
```

## 与 bundle 的关系

- `screenshots/` 里三张图是 `bundle/screenshots/` 的**副本**（md5 完全一致），**bundle 原件没有被改动**。
  副本存在的目的：README / 比赛页 / 评审材料引用时不需要触碰发布包。
- 演示视频**不在 `bundle/` 里**：App Hub 的 bundle 只允许 `.card .json .l0 .octoscript .splash .svg .png .jpg .jpeg .webp .ttf .otf .txt .md`，`.mp4` 放进去会被 `contents` 规则拒绝。视频以 GitHub Release asset 的形式提供。

## 演示视频

- 文件：`docs/submission/doudou-v0.2.0-demo.mp4`
- Release asset：https://github.com/jessicaruan6688-byte/doudou-gosim/releases/download/v0.2.0/doudou-v0.2.0-demo.mp4
- 内容路径：HOME（29.6 / 底线 12）→ 休息 6M（23.6）→ 先留着 → 回到现在 → 休息 18M（11.6，跌破底线）→ 等一等 → 回到现在 → 买车（18.5）
- 诚实说明：画面是 card-host **真实运行输出**（`/g?raw=1` 逐帧抓取）按真实点击顺序合成，**不是 macOS 屏幕录制**；应用本身无动画，因此每一帧与真实界面一致，只是没有系统光标与窗口边框。后续可用真机录屏替换，同名覆盖即可。

## 版本锚点

- commit `ae92d240115290b48ff86153445811b0d69d6c24` · tag `v0.2.0`
- `hub check bundle --allow-unsigned` → `doudou 0.2.0 — PASSED`，digest `e39f7b9d6cfadb6b5b3c2cb785cfab6a8649b8a79472952c1a50c8848eff2ab7`
- App Hub 提交状态：**已提交 OctoSense App Hub（[Issue #104](https://github.com/OctoSense-org/OctoSense-App-Hub/issues/104)），等待 maintainer review。** 表示提交已送达并进入审核队列，**不代表已上架、已收录或通过审核**。
