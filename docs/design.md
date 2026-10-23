# 设计稿 · dsh-jupyterlab

> **这份文件是索引，不是教程。**
>
> 改代码之前先读它：第 0 节按"想改什么"定位到章节，章节里给的是**文件和符号**，不是行号
> （行号会过期，符号不会）。定位到文件后，先读该文件顶部的头注释——每个 `lib/*.js` 的开头都
> 写了"为什么是这样"，那是这份索引的一级条目。最后看同名测试：测试写的就是行为契约。

面向用户的用法（怎么装、怎么连、有哪些工具）在 `README.md`，不在这里重复。

---

## 0. 索引：想改什么 → 从哪里开始

| 想改的东西 | 先读 | 主要文件 / 符号 | 对应测试 |
| --- | --- | --- | --- |
| 工具的参数、返回值、提示语 | §2.1 | `lib/index.js`: `connectTool` `statusTool` `executeTool` `notebookTool` `kernelTool` `PROMPT_TEXT` | `test/register.mjs` |
| 模型读/改面板里的单元格 | §2.1 §4.1 | `lib/index.js`: `notebookTool`；`lib/notebook.js`: `snapshot` `runCellNow` | `test/register.mjs` `test/notebook.mjs` |
| agent 执行如何出现在面板里 | §2.4 | `lib/notebook.js`: `beginAgentRun` `#settle` | `test/notebook.mjs` |
| 连接地址、token/密码、URL 归一化 | §5.2 | `lib/server.js`: `normalizeJupyterUrl` `JupyterServerClient` | `test/e2e.mjs` |
| 内核绑定、重连、绑定落盘 | §3.1 | `lib/runtime.js`: `JupyterRuntime` `sessionKernel` `ensureKernel` | `test/e2e.mjs` |
| 执行协议（execute_request / iopub / 中断） | §2.2 | `lib/kernel.js`: `KernelConnection.execute` `#runOne` | `test/e2e.mjs` |
| 出站 HTTP / DNS / WebSocket | §5.1 | `lib/transport.js` `lib/dns-cache.js` `lib/websocket.js` | `test/transport.mjs` |
| 面板命令与视图字段 | §3.2 §4.1 | `lib/notebook.js`: `Notebooks.command` `Notebooks.view` | `test/notebook.mjs` |
| 面板改动如何告知模型 | §2.3 | `lib/activity.js`: `NotebookActivity` `messageForNotes` `registerContextInjection` | `test/activity.mjs` |
| 面板新增路由 / 改协议 | §4.2 | `lib/routes.js`: `registerNotebookRoutes` | `test/notebook.mjs` |
| MIME 优先级、输出预算 | §4.3 | `lib/notebook.js`: `OutputRenderer.#bundle` `renderableOutputs` | `test/notebook.mjs` |
| 代码高亮、Markdown 解析 | §4.4 | `lib/client.js`: `tokenizePython` `Markdown` | `test/client.mjs` |
| 图片落盘与缓存 | §4.5 | `lib/assets.js`: `AssetStore` `assetUrl` | `test/notebook.mjs` |
| 面板 UI、交互、主题 | §4.6 | `lib/client.js`: `Notebook` `Cell` `Output` `CSS` | `test/client.mjs` |
| 样式/文案（中英） | §4.6 | `lib/client.js`: `en` `zh`；`locale/*.json` | `test/client.mjs` |
| 性能与载荷 | §7 | `docs/performance-review.md`，`scripts/bench-*.mjs` | 见 §9 |

**符号定位的办法**（不要靠行号）：

```bash
rg -n 'class OutputRenderer|#bundle|MAX_HTML_BYTES' lib/
rg -n 'action: .runCell.|STREAM_ROUTE' lib/ test/
```

---

## 1. 形态与边界

一个 Cordis bundle，两半：

```
DSH 宿主进程（Node，有依赖）
  lib/index.js ─ tools ─> lib/runtime.js ─> lib/kernel.js ─> lib/websocket.js
                                │                  │
                                └─> lib/server.js ─┴─> lib/transport.js ─> lib/dns-cache.js
  lib/routes.js （connection.fetch）─> lib/notebook.js ─> lib/assets.js
                                              ▲
                                              │ SSE / fetch
浏览器（无构建、无第三方包）  lib/client.js ───┘
```

三条外部约束，任何改动都不能违反：

1. **`connection.fetch` 按精确路径匹配。** 新路由只能是新的 exact path；参数只能走 query，
   不能指望 `/asset/<name>` 这种子路径（会 404）。
2. **Jupyter 校验 `Host` 头。** 出站请求必须经过 `transport.js`，内核通道必须经过
   `websocket.js`；换成 `fetch` / 内置 `WebSocket` 会同时丢掉自定义解析器和正确的 `Host`。
3. **浏览器半边没有构建步骤**，只能 `require('react')`。所以高亮、Markdown、清洗全部手写，
   没有 parser、没有 highlight.js、没有 marked。

还有一条约定：**宿主半边改动要重启 DeepSeek Harness 才生效**（模块按 URL 缓存）；浏览器半边
刷新页面即可。调试时先确认自己在改哪一半。

---

## 2. 两条执行链路

同一个内核、同一个队列，但入口不同：模型走工具，人走面板。

### 2.1 模型侧：`jupyter_execute`

```
index.executeTool
  └─ runtime.execute(sessionKey, code, {signal, timeoutMs, storeHistory})
       └─ ensureKernel（首次启动，之后复用绑定）
            └─ KernelConnection.execute
                 └─ summarizeOutputs(outputs) → {stdout, result, stderr, error}
                      └─ saveArtifacts → $DSH_HOME/jupyterlab/artifacts/jupyter-<stamp>-NN.<ext>
```

- **一次性返回，不流式。** 工具面对模型是"一问一答"，中途推消息只会在 transcript 里留下碎片。
- **截断在工具边界做。** `maxOutputChars`（默认 20000）按头 6 : 尾 4 中间省略，返回
  `truncated: true`。完整内容留在内核里，需要时应让模型写文件而不是加大上限。
- **取消 = 中断内核。** 工具超时（策略 300 s）或用户取消都会 `POST /interrupt`，然后返回已经
  产出的部分，`status` 记为 `timeout` / `aborted`；变量不丢。
- **产物按 MIME 落盘**：`ARTIFACT_MIME_EXTENSIONS` 里的六种（png/jpg/gif/webp/svg/pdf），
  base64 与 UTF-8 分开写。
- **每次执行都留一个单元格。** `notebooks.beginAgentRun` 在发代码前插入 `origin: 'agent'` 的格子，
  `onOutput` 把 iopub 直接推进面板（与用户点 Run 同一套补丁），结束时 `#settle` 用权威输出重算。
  没有 agent 会话的调用（`sessionKey` 落到 `shared`）不写面板。
- **`jupyter_notebook` 是另一半。** 它读的是**面板的模型**，不是内核历史：`snapshot` 给出格号、
  id、`rev`、源码与输出摘要；`add/update/delete` 走 `command(..., { note: false })`，`run` 走
  `runCellNow`（同一个 `#beginCodeRun`，等结果而不是立即返回）。模型自己的动作**不产生用户 note**，
  否则下一轮它会读到自己刚做的事被描述成用户的编辑。

### 2.2 面板侧：`Run`

```
client onRun ─ POST {action:'runCell', id, source}
  └─ Notebooks.command → #startRun（立即返回视图）
       └─ runtime.execute({onOutput})
            └─ iopub 每条 → OutputRenderer.push → 补丁
                 └─ Notebooks.#emit → routes SSE → client applyEvent → 渲染
       └─ 结束时 renderableOutputs(execution.outputs) 重算一次
```

- **执行归笔记本所有，不归请求所有。** `POST runCell` 只负责"把代码交给内核"，几毫秒返回；
  执行在后台继续，输出走 SSE。这也是"刷新页面不再打断单元格"的根因修复。
- **增量渲染只为看，最终状态为准。** 跑完用内核给的完整输出列表重算一次，落盘与被留存的状态
  和"非流式执行"逐字节一致；增量那份允许被丢弃。
- **markdown 单元格不碰内核。** `runCell` 遇到 `kind === 'markdown'` 直接渲染，不启动内核，
  所以在没有内核的服务器上也不会失败。
- **串行化在 `KernelConnection.#queue`。** iopub 消息里没有 request id，同一内核并发执行会串台；
  面板和工具共用这个队列，谁的先到谁先跑。

### 2.3 第三条链路：面板 → 模型（上下文注入）

```
用户编辑 / 运行 / 删除 / 清空
  └─ Notebooks 发结构化 activity 事件（只描述发生了什么，不写文案）
       └─ NotebookActivity 缓冲成 note（按 key 收敛，run-start 被 run-end 替换）
            └─ agent/pre-step：drain → 一条 user 消息（source: plugin / form: notice）
                 └─ 会话日志 → 下一次模型请求 + transcript 里一行折叠的上下文
```

- **只在下一步交付。** 编辑不是一轮对话的开始：`pre-step` 里 `step === 1` 且
  `decision.messages` 为空时直接跳过，note 留在缓冲里等下一轮；被拒或被取消的 step 也不消费。
- **来源是插件，不是用户。** `source: {kind:'plugin', plugin:'jupyterlab', form:'notice'}`，
  模型和界面都不会把它当成用户说的话——这是一条"刚才发生了什么"的上下文，不是指令。
- **按 key 收敛。** 同一格的 `run-start` 被 `run-end` 覆盖（只留结果），`reset` 会清空所有待发
  note，因为它描述的单元格已经不存在；`moveCell`、`setPath` 不产生 note。
- **预算。** 每会话最多 8 条 / 6000 字符；单条源码 900 字符、输出 800 字符；超了丢最旧的，
  单条超长在消息里截断。
- **第一批发地图。** 会话第一次交付 note 时，`Notebooks.outline` 生成一行一格的大纲（格号、
  kind、origin、`Out[n]`、首行），否则"cell 3"对从没看过笔记本的模型是悬空的。之后不再重复；
  `reset` 让 revision 归零，下一次重新发。`list()` 只读不消费，供面板预览。
- **不写会话日志。** 这里不直接 `session.append`：交付时机和"这一轮到底发不发"由 `agent` 决定，
  绕过它会让一条 note 凭空开出一轮对话。

### 2.4 第四条链路：模型 → 面板

```
jupyter_execute
  └─ notebooks.beginAgentRun → 插入 origin:'agent' 的格子（SSE insert）
       └─ onOutput → OutputRenderer → append/text（与用户运行同一套）
            └─ finish → renderableOutputs → 权威 cell 事件
```

- **反向同步是补齐记录，不是装饰。** 面板和 agent 共用一个内核；只记用户那一半，笔记本就会
  缺掉模型改过的状态。`origin` 只影响显示（格子头部的 `Agent` 徽标），不影响执行。
- **插入事件只有一种。** `insert` 带 `index` 与完整 cell；客户端按位置插入，重复 id 则替换。
  普通 `cell` 事件仍然只更新已存在的格子——一个已被删除的格子不该被它的收尾事件重新加回来。
- **工具自己的动作不改用户上下文。** `jupyter_notebook` 的增删改运行都传 `{ note: false }`；
  模型需要的是这次工具调用的返回值，不是下一轮的一条"用户编辑了…"。

---

## 3. 状态模型

### 3.1 内核绑定（宿主，按会话）

`JupyterRuntime` 持有**一个**连接（`jupyter_connect` 会切换它），内核按 DSH 会话绑定：

| 关注点 | 实现 |
| --- | --- |
| 绑定存哪 | `$DSH_HOME/jupyterlab/kernels.json`，键是 `<url>::<会话 id>`，按服务器隔离 |
| 重启后 | 读绑定 → `GET /api/kernels/<id>` 验证 → 活着就 attach，死了才新建 |
| 地址变更 | `configure()` 清掉不匹配主机的凭证与绑定；换服务器不可能泄露旧 token |
| 状态查询 | 面板的状态行用 `maxAgeMs: 2000` 的 memo；工具调用不 memo（默认 0），内核动作时失效 |
| 解析预热 | 挂载时在后台跑一次 `resolveHost`，把唯一那 5 s 从首次执行挪到加载时 |

### 3.2 笔记本（宿主，按会话）

`Notebooks` 里四张表，各自负责一件事：

| 私有字段 | 内容 | 生命周期 |
| --- | --- | --- |
| `#notebooks` | 会话 → `{cells, path, revision}` | 首次访问时从镜像加载 |
| `#pendingPersistence` | 会话 → 延迟写盘的 timer | 大笔记本 60 ms 合并写 |
| `#listeners` | 会话 → SSE 订阅者集合 | 流断开即移除 |
| `#runs` | 会话 → 在飞的 Promise 集合 | `idle()` / `dispose()` 等它 |

单元格结构（`CellView`）：`id` `kind` `source` `rev` `status` `executionCount` `durationMs`
`outputs` `error`。

**`revision` 与 `rev` 不是一回事：**

- `revision`：整本笔记本的版本号，任何变更都 +1。轮询的 `?since=` 比的是它。
- `rev`：单个单元格的版本号。`updateCell` / `clearOutput` / 一次运行结束时 +1；**只有**它变了，
  客户端才需要换掉那个单元格对象，`React.memo` 才拦得住兄弟节点。

**视图是浅拷贝。** `view()` 对每个 cell 做 `{...cell}` 而不是深拷贝：路由紧接着 JSON 序列化，
深拷贝只会把 base64 图再复制一遍。`view()` 只在有待发 note 时带 `pendingNotes`（头部徽标的计数）
与 `notes`（`[{key, summary}]`，点开徽标看的就是它）；`?since=<revision>` 命中时同样带这两个
字段，不碰 Jupyter——note 被取走后 revision 不变，徽标与列表只能靠这个短答案归零。

**落盘。** `isHeavy()` 只看长度不序列化；轻的立即写，重的延迟 60 ms 合并写；跑之前和
`dispose()` 强制落盘。写文件是 `tmp + rename`，紧凑 JSON（缩进对大 payload 是纯浪费）。

**事件表**（SSE 的 `data:`，也是 `applyEvent` 的输入）：

| `type` | 载荷 | 用途 |
| --- | --- | --- |
| `insert` | `revision` + `index` + 完整 cell | 新格子出现（模型运行）；客户端按位置插入，重复 id 替换 |
| `cell` | `revision` + 完整 cell | 开始/结束的权威状态；不合并，立即下发 |
| `append` | `cellId` + 一条 output | 新增输出（text/html/markdown/image/error） |
| `text` | `cellId` + `index` + `text` | 向第 index 条输出追加文本 |
| `clear` | `cellId` | 内核 `clear_output` |

`append` / `text` 按 60 ms 合并成帧；`cell` 与 `insert` 立即发，否则列表和状态行会滞后于输出。

---

## 4. 面板契约

### 4.1 命令（`POST /api/jupyterlab/notebook` 的 `action`）

| action | 效果 | 备注 |
| --- | --- | --- |
| `addCell` | 在 `afterId` 之后插入，缺省追加到末尾 | `kind` 缺省 code；`origin` 只有工具会传 |
| `updateCell` | 改 `source` / `kind` | 切到 markdown 时清空输出与执行计数 |
| `deleteCell` | 删除；删空后补一个空 code 格 | 不允许零单元格 |
| `moveCell` | 与相邻格交换（`delta: ±1`） | 越界静默 |
| `clearOutput` | 清一个格子的输出 | |
| `clearAllOutputs` | 清全部 | |
| `runCell` | 保存草稿并执行（markdown 直接渲染） | 立即返回，输出走 SSE |
| `startKernel` / `interrupt` / `restartKernel` | 内核生命周期 | 结果塞进 `message` |
| `discardNotes` | 丢弃待交给模型的 note | 不改 revision，只清缓冲 |
| `setPath` | 设置笔记本路径 | 尚未用于读写 `.ipynb` |
| `reset` | 丢弃内存与镜像 | 测试与"新建"用 |

### 4.2 路由

| 方法 | 路径 | 参数 | 响应 |
| --- | --- | --- | --- |
| `GET` | `/api/jupyterlab/notebook` | `sessionId`、可选 `since` | 完整视图，或 `unchanged: true` |
| `POST` | `/api/jupyterlab/notebook` | JSON：`sessionId` + `action` + 参数 | 新视图；失败时为 `{error}` |
| `GET` | `/api/jupyterlab/notebook/stream` | `sessionId` | `text/event-stream` |
| `GET` | `/api/jupyterlab/asset` | `name=<sha20>.<ext>` | 图片字节，`immutable` |

约定：

- **命令失败返回 200 + `{error}`**，只有"请求体不是 JSON"是 400。理由是面板要把错误显示在
  原位，而 4xx/5xx 会被 `callHost` 当成传输故障处理。
- **命令不带 `request.signal`。** 带着它，用户刷新页面就等于取消命令；`runCell` 更糟——中断会
  一路传到 `POST /interrupt`，把正在跑的单元格杀掉。`runCell` 不再等待执行之后，这条尤其重要。
- **注册走 `ctx.inject(['connection'])`。** 冷启动时 `connection` 往往还没提供；只读一次就放弃
  的症状是"面板能开，但所有请求 404"。状态通过 `onState` 上报，`jupyter_status` 里能看到。
- **流的生命周期挂在请求的 abort 上**：释放订阅、清心跳、关 body。反复开关面板不留东西。

### 4.3 输出渲染（MIME 优先级）

`OutputRenderer.#bundle` 决定画什么，客户端只负责把 `type` 画出来：

| 顺序 | 条件 | 结果 |
| --- | --- | --- |
| 1 | `image/png` `image/jpeg` `image/gif` `image/webp` | `{type:'image'}`，有存储时给 URL |
| 2 | `text/html` 且 ≤ 256 KiB | `{type:'html'}`，清洗后挂 shadow root |
| 3 | `text/markdown` | `{type:'markdown'}`，自写解析器 |
| 4 | `text/plain` | `{type:'text'}` |
| 5 | 只有别的 MIME | `[application/json, text/latex] output` 这样的占位 |

预算（都在 `lib/notebook.js` 顶部）：`MAX_HTML_BYTES` 256 KiB、`MAX_TEXT_PER_CELL` 200 000 字符、
`MAX_IMAGES_PER_CELL` 8、`MAX_IMAGE_BYTES` 2 MiB。任何一项超了都退回纯文本并留一行说明，
**不静默丢**。

HTML 的两个决定：

- **先清洗，再挂载。** `DOMParser` 解析 → 删 `script/iframe/frame/frameset/object/embed/link/
  meta/base/form`、删所有 `on*`、把 `href/src/action/...` 里的 `javascript:` 与 `data:text/html`
  挡掉、去掉 `<style>` 里的 `@import`。
- **用 shadow root，不用 iframe。** shadow root 有自然高度（iframe 只能给死高度），并且 CSS
  完全隔离：pandas 的 `style scoped`、Styler 的规则、以及 `body { display: none }` 都出不去。

### 4.4 高亮与 Markdown

- **高亮是分词器，不是解析器**（`tokenizePython`）。一次全局正则，分组按优先级：
  行首 magic（`%`/`!`）→ 注释 → 字符串（含三引号、前缀）→ 装饰器 → 数字 → 标识符 → 运算符。
  它不会把字符串里的 `#` 当注释，这是唯一真正要紧的正确性；不处理 f-string 内部表达式、
  不处理括号深度。关键词与内置名靠 `PY_KEYWORDS` / `PY_BUILTINS` 两个 Set 二次判定。
- **编辑器是"透明 textarea 叠在高亮副本上"。** 光标、选区、输入法全是原生行为；`data-composing`
  属性在 IME 组字期间把高亮层藏起来，否则拼音候选字看不见。两层字号/行高/内边距必须完全一致。
- **Markdown 也是手写的**（`Markdown` / `mdBlocks` / `mdInline`）：块结构逐行（标题、围栏代码、
  列表含嵌套、表格、引用、分隔线），行内一条正则（代码、加粗、斜体、删除线、链接、图片、
  裸 URL）。所有节点走 `createElement`，从不拼 HTML 字符串。代码围栏复用同一套高亮。

### 4.5 图片存储

`AssetStore.put(mime, base64)` → `sha256` 前 20 位 + 扩展名 → `$DSH_HOME/jupyterlab/assets/`。
单元格里只留 `api/jupyterlab/asset?name=<hash>.<ext>`，路由回 `immutable`。同一张图重绘复用
同一个 URL；内存 32 MiB LRU、磁盘 256 MiB LRU。没有存储时退回 data URL（`{type:'image',
dataUrl}`），客户端两种都认。

### 4.6 客户端

组件树：`Notebook`（拉视图、开流、轮询、发命令）→ `Cell`（memo，读/编辑两态）→ `Output` →
`HtmlOutput` / `Markdown`。`OpenButton` 是 composer 工具行里的入口，`NotebookTitle` 是侧栏标题。

`pendingNotes` 是唯一一个不随 `revision` 变的视图字段：头部徽标读它，轮询的 `unchanged` 答案
也带它（见 §3.2）。徽标只在大于 0 时出现，否则工具栏会一直多一个空壳；它是个按钮，点开列出
`notes` 的 summary 并可以丢弃——用户有权知道模型到底会看到什么。

`adopt(next)` 会拒绝比 `panelRevisions` 更旧的完整视图：GET 和 SSE 走两条连接，慢 GET 可能
在更新的流事件之后到达，否则会把面板倒回去。`origin: 'agent'` 的格子只在头部多一个 `Agent`
徽标，其余行为与用户格子完全一致。

三条与性能有关的约定，改 UI 时要保住：

1. **`Cell` 的 props 必须稳定**：未变的 cell 对象（靠 `rev` 复用）、`useCallback` 包过的 handler、
   同一个 `t`。否则 `React.memo` 只是多一层比较。
2. **写作状态留在本地**：`editing` / `drafts` / `busy` 是 `Notebook` 的 state，不进宿主模型；
   只有提交才发命令。
3. **编辑器高度靠 `fit()`**：textarea 自适应，高亮层绝对定位跟随；改 CSS 时两层的
   `font` / `line-height` / `padding` 必须同源。

样式全部写在 `CSS` 模板字符串里，用主题的自定义属性（`--dsh-*`）取色，所以亮/暗主题自动跟随。

---

## 5. 传输与认证

### 5.1 为什么不是 `fetch`

macOS 上解析一次 `host.local` 约 5 s（`mDNSResponder` 先多播再回落 `/etc/hosts`）。`fetch` 和
内置 `WebSocket` 每条连接自己解析一次，解析器不可注入；改成连 IP 又会被 Jupyter 的 `Host`
校验以 403 拒绝。于是：

- `lib/dns-cache.js`：进程级缓存，TTL 5 分钟，并发去重，IPv4 优先；`createLookup()` 作为
  `lookup` 注入 `http.request`，`Host` 与 SNI 仍是原主机名。
- `lib/transport.js`：`httpRequest` 基于 `node:http/https`，keep-alive Agent，响应读干回池，
  `AbortSignal` 统一超时。**不要**在这里加 `fetch` 兜底。
- `lib/websocket.js`：只实现内核协议需要的（masking、16/64 位长度、分片、ping/pong、close）。
  握手也走 `http.request`，这是同时满足"不解析"和"Host 正确"的唯一办法。

### 5.2 地址与认证

地址先归一化（`normalizeJupyterUrl`）：补 `http://`、只接受 http/https、从第一个应用段
（`/lab`、`/tree`、`/notebooks`…）起全部丢掉、保留网关前缀、`?token=` 变成凭证。

| 方式 | 流程 | 注意事项 |
| --- | --- | --- |
| token | `Authorization: token <t>` | 优先；URL 里的 `?token=` 自动提取 |
| password | `GET /login` 取 `_xsrf` → `POST /login` → 带 cookie | 需要 `X-XSRFToken` 才能启动内核 |
| 密码哈希 | 不支持 | `argon2:...` 不可重放，只能报错 |

凭证属于主机：`configure()` 在主机变化时清空旧 token/password，除非同一次调用给了新的。

### 5.3 错误码

`JUPYTER_ERROR_CODES`：`INVALID_URL` `NOT_CONFIGURED` `UNREACHABLE` `NOT_JUPYTER` `AUTH`
`HTTP` `NOT_FOUND` `KERNEL_GONE` `DISCONNECTED` `TIMEOUT`（实际值是 `JUPYTER_` 前缀）。
`JupyterError.message` 是给人看的一句话，`code` 给程序判断。401（密码错）与 403（XSRF 缺失）
必须分开报，因为修法不同。

---

## 6. 失败语义

| 场景 | 行为 |
| --- | --- |
| 内核不存在 / 已死 | 发代码前先验证绑定；活着 attach，死了重建。瞬时失败不 shutdown |
| 执行超时 / 被取消 | `interrupt`，返回已产出的输出，`status: timeout/aborted` |
| 中断后第一格被拒 | Jupyter 回 `aborted`（没跑），重试一次；第二次仍失败才报错 |
| 内核断开 | `status: disconnected`，输出保留已收到的部分 |
| 输出超预算 | 截断并标记 `truncated`，客户端显示省略说明 |
| 图片过大 / 过多 | 单张 > 2 MiB：留一行说明；一格只保留前 8 张，多余的跳过 |
| 资源名不存在 | 404（不是 500）；名字必须匹配 `^[0-9a-f]{20}\.(png|jpg|gif|webp|svg|pdf)$` |
| 面板路由没注册 | `onState('unavailable')`，工具照常可用，`jupyter_status` 里可见 |
| 镜像写不进去 | 静默忽略；编辑不能因为只读 home 而失败 |

---

## 7. 性能

所有测量、改动理由与复测命令在 **`docs/performance-review.md`**，这里只留结论：

- 5 s 的来源是 DNS，不是插件逻辑；修在传输层，不是加缓存层。
- 一次点击 = 一次往返（`Shift+Enter` 的保存随运行一起发）；稳态轮询两个字段。
- 图片走 URL + `immutable`，笔记本 JSON 保持 KiB 级。
- 流式输出的首帧取决于内核，不取决于面板（60 ms 合并是上限）。
- `React.memo` 生效依赖 `rev` 复用与稳定回调，改 `view()` 或 `Cell` 时必须一起看。

---

## 8. 文件 → 职责

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `lib/index.js` | Cordis 插件：Config、系统提示、五个工具、接线 | `apply` `Config` |
| `lib/runtime.js` | 连接与会话内核状态：绑定、重连、镜像 | `JupyterRuntime` `normalizeSettings` |
| `lib/server.js` | REST 客户端：URL、认证、XSRF、cookie | `JupyterServerClient` `normalizeJupyterUrl` `JupyterError` |
| `lib/transport.js` | 出站 HTTP（keep-alive、缓冲、abort） | `httpRequest` `combineSignals` |
| `lib/dns-cache.js` | 进程级解析缓存 | `resolveHost` `createLookup` |
| `lib/websocket.js` | RFC 6455 客户端（够用即可） | `KernelSocket` |
| `lib/kernel.js` | 内核消息协议、输出归一化、产物落盘 | `KernelConnection` `summarizeOutputs` `collectArtifacts` |
| `lib/notebook.js` | 面板模型：单元格、增量渲染、后台运行、镜像 | `Notebooks` `OutputRenderer` `renderableOutputs` |
| `lib/activity.js` | 面板活动的缓冲与交付：note 文案、批量消息、`agent/pre-step` 钩子 | `NotebookActivity` `messageForNotes` `registerContextInjection` |
| `lib/assets.js` | 内容寻址图片仓库 | `AssetStore` `assetUrl` |
| `lib/routes.js` | 三条同源路由 + SSE | `registerNotebookRoutes` `*_ROUTE` |
| `lib/client.js` | 浏览器半边：侧栏页签与笔记本 UI | `TYPE_ID` `KIND`（其余在工厂内） |

---

## 9. 测试地图

| 套件 | 覆盖 | 需要 Jupyter |
| --- | --- | --- |
| `test/transport.mjs` | DNS 缓存、连接复用、`Host`、帧编解码 | 否（自带 peer） |
| `test/notebook.mjs` | 命令、视图、增量渲染、SSE、资源路由、镜像 | 否（注入假 execute） |
| `test/activity.mjs` | note 文案、批量消息、`agent/pre-step` 的交付与守卫 | 否（假 agent 与假 ctx） |
| `test/client.mjs` | 注册、渲染路径、点击、流式补丁、memo 身份 | 否（jsdom） |
| `test/e2e.mjs` | 认证、执行、持久化、超时、内核生命周期 | **是** |
| `test/register.mjs` | 真 cordis 上下文 + 真 tools 注册表 | 部分（挂载即可） |

跑法见 `README.md` 的 "Verifying a change"。改宿主半边的协议行为，`e2e` 必须跑；
只改渲染，`client` + `notebook` 就够。**不要**用 `disable_check_xsrf` 起测试服务器——它会
把真实的 XSRF 缺陷藏起来。

---

## 10. 已知边界（有意的）

- 面板是笔记本的**子集**，不是 JupyterLab：无补全、无变量检查器、无 `.ipynb` 导入导出。
- 输出只画图片、`text/html`、`text/markdown`、纯文本；`application/json`、LaTeX 只报 MIME 名。
- HTML 输出经清洗，所以依赖自身 `<script>` 的东西（交互 widget、plotly）只画静态部分。
- `jupyter_execute` 不流式：模型一次拿全结果更省轮次；长任务的进度看面板。
- 面板活动是**下一步的上下文**，不是即时消息：agent 空闲时编辑只会让徽标加一，真正交付发生在
  下一次请求；已经在飞的请求不会被改写。
- **每次 `jupyter_execute` 都会在面板留一个 `Agent` 格子**，包括失败与超时。它是这份分析记录的
  一部分；代价是一次探索很长的会话会让笔记本变长，暂时不做折叠或清理。
- `jupyter_notebook` 的 `run` 会等结果（工具调用需要一个答案），而面板的 `Run` 立即返回
  （用户需要看到输出在长跑时流出来）。同一个 `#beginCodeRun`，两种等待策略。
- 一个大内核一个会话绑定；跨会话共享内核属于能力扩展，不在当前范围。
- 虚拟滚动没做：`memo` 之后每帧只重渲染一格，收益不足以引入行高测量与滚动同步。

---

## 11. 改完之后

1. 跑对应测试套件（§9），全绿再谈提交。
2. 行为变了就改 `README.md`；**结构**变了（新模块、新路由、新符号、新预算常量）就改这份
   索引，否则下一个人会按旧地图找路。
3. 有新的性能判断，追加到 `docs/performance-review.md`，写清"测了什么、数字多少"。
4. 提交信息沿用现有风格：`type(scope): 一句话`，正文说明为什么。
