# Publishing Journey — How this repo came to be

> 把飞书 IM 接到本地 dsh agent 之后，怎么把这个集成开源出来、收录到 awesome 列表的全过程。
> 记录时间：2026-08-14

---

## TL;DR

`dsh-feishu` 是从「在本地跑通」到「公开仓库 + awesome 收录」的一次端到端开源化实验。
整个过程分三阶段：

1. **集成**：先在本地打通飞书 ↔ dsh agent（参考外部调试文档）
2. **发布**：把代码 + 配置推到 GitHub，让别人能 install
3. **Review**：被 awesome-dsh-plugin 维护者 review 后按反馈做了 4 项 refactor

---

## 阶段一：本地集成（前置）

在写这个 README 之前，集成本身已经跑通了——详细调试手记见
[`dsh-feishu-debug-journey`](https://github.com/itr-del/dsh-feishu/blob/master/docs/debug-journey.md)
（340 行，含 6 个真实坑、5 条铁律）。

关键结论：

- dsh 的 cordis patch 文件**只读** `~/.dsh/profiles/<profile>/cordis.patch.yml`，不是 plugin 目录
- 同一个飞书 appId 只能有一个 WS 长连接——多个进程会争抢
- dsh 的 `agent/status` 是 agent-scoped 事件，必须在 agent 创建后立刻注册

---

## 阶段二：公开发布

### 2.1 仓库选址

候选目标：

| 仓库 | 状态 |
|---|---|
| `deepseek-ai/deepseek-harness` | ❌ 不接受外部 PR（内部 mono-repo 镜像） |
| `awesome-dsh-plugin` (599⭐) | ✅ 官方点名，**主推** |
| `Dominic789654/awesome-deepseek-harness` (25⭐) | ⏸️ 次选（社区维护） |
| `dsh-handbook` Discussions (133⭐) | 📝 文档分享通道 |

最终决定：建 `itr-del/dsh-feishu` 个人仓库 + PR 到 awesome-dsh-plugin。

### 2.2 文件结构

公开仓库包含 7 个文件：

```
dsh-feishu/
├── LICENSE              # MIT
├── README.md            # 安装 + 配置
├── README.zh.md         # 中文版
├── package.json         # 名字 dsh-feishu + dsh.bundle manifest
├── cordis.yml           # 极简元数据
├── cordis.patch.yml     # 极简 bundle patch
├── src/index.js         # 插件主代码（脱敏）
└── .gitignore           # node_modules + .env
```

### 2.3 发布管道

由于在中国境内服务器，`git push` 直连 GitHub 超时。**解决方案**：用 GitHub
Contents API 逐文件 PUT，绕过 git 协议。

```bash
PUT /repos/{owner}/{repo}/contents/{path}
  - message: "..."
  - content: base64(file)
  - sha: <existing-sha>     # 修改时必填
```

完整管道（7 步）：
1. `POST /user/repos` — 创建仓库
2. `PUT /contents/{file}` × 7 — 上传所有文件
3. `PUT /topics` — 加 topic tags
4. `POST /repos/awesome/.../forks` — fork awesome 仓库
5. `PUT /contents/README.md` — 在 fork 上加 dsh-feishu 一行
6. `POST /pulls` — 开 PR
7. （可选） `POST /issues/{n}/comments` — 跟维护者互动

---

## 阶段三：PR Review 反馈

### 3.1 Review 反馈（4 项）

PR #127 维护者 `fkysly` 的 review 摘要：

| # | 反馈 | 原状态 |
|---|---|---|
| 1 | 加 `dsh.bundle` manifest | ❌ 没声明，dsh 不识别为 bundle |
| 2 | `cordis.patch.yml` 不该写 credentials | ❌ 写了 30+ 行 appId/appSecret 注释 |
| 3 | 包名 `@local/dsh-feishu` 是占位 | ❌ 需要 publishable name |
| 4 | `README.zh.md` 缺条目 + 描述太长 | ❌ 没加 zh、英文描述 332 字符 |

### 3.2 修复后的最终结构

**`package.json`**：

```json
{
  "name": "dsh-feishu",
  "version": "0.1.0",
  ...
  "dsh": {
    "plugin": { ... },
    "bundle": { "patch": "./cordis.patch.yml" }
  }
}
```

**`cordis.patch.yml`**（极简 bundle patch）：

```yaml
- insert:
    - id: feishu-bridge
      name: dsh-feishu
```

credentials 全部搬到 README 的 `## Environment variables` 表格。

**README.md / README.zh.md**：双双简化到 `dsh plugin add` 一行安装 + 4 步走完。

### 3.3 PR 修订记录

| Commit | 内容 |
|---|---|
| `e6e3a32` | Initial release |
| `55bdb56` | docs: add author info + PR template |
| `f86a7ba` | docs: add awesome-dsh-plugin PR body |
| `d43265e` | refactor: declare dsh.bundle manifest + minimal bundle patch |

---

## 给后来者：开源一份 cordis 插件的清单

如果你也想把 dsh 插件开源到 awesome-dsh-plugin：

1. ✅ README 必须有 `dsh plugin add <name>` 一行安装流程
2. ✅ `package.json` 必须声明 `dsh.bundle.patch`
3. ✅ `cordis.patch.yml` 只能写 bundle patch 结构（`- insert:` / `- id:` / `- config:`）
4. ✅ 包名不能含 `@local` / `@example` 占位 scope
5. ✅ 同时维护 `README.md` + `README.zh.md`
6. ✅ 单行 description（参考 awesome 现有条目的平均长度）

---

## 链接

- 仓库: https://github.com/itr-del/dsh-feishu
- PR: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/127
- 调试手记: [`docs/debug-journey.md`](./docs/debug-journey.md)
- 兄弟项目: https://github.com/imetn/dsh-lark-bridge

---

**作者**: [itr-del](https://github.com/itr-del)
**协议**: MIT