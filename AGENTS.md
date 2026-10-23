# AGENTS.md

给在这个仓库里动手的 agent（和人）的工作约定。用户视角的用法在 `README.md`，这里只说
"改之前要知道什么"。

## 第一件事：先读设计稿，把它当索引

**改任何代码之前，先读 `docs/design.md`。**

它不是教程，是地图：第 0 节把"想改什么"映射到章节，章节里给的是**文件和符号**。顺序固定：

1. 在 `docs/design.md` 的索引表里定位要改的东西。表里没有，说明地图缺了一条——先补表，再改代码。
2. 打开被点名的文件，读**文件顶部的注释**。每个 `lib/*.js` 开头都写了"为什么是这样"。
3. 读对应的测试（`test/*.mjs`）。测试写的是行为契约，不是实现细节。
4. 改完跑套件；**结构变了**（新模块、新路由、新符号、新常量）就回来更新索引。

不要跳过这一步直接 grep：这个仓库里几乎每个"看起来绕"的写法都是被一个具体故障逼出来的
（5 秒 DNS 解析、`Host` 校验 403、刷新页面即中断、SSE 订阅泄漏、路由只认精确路径）。
不知道原因就会把它们改回去。

设计稿与代码不一致时，**以代码为准**，然后修设计稿。

## 文档分工

| 文件 | 面向谁 | 什么时候改 |
| --- | --- | --- |
| `README.md` | 用户 | 安装、配置、能力、限制变了 |
| `docs/design.md` | 改代码的人 | **结构**变了：模块、路由、符号、预算常量、事件类型 |
| `docs/performance-review.md` | 判断性能的人 | 有新的测量或决策；只追加，不改写历史结论 |
| `docs/dsh-client-plugin-contract.md` | 查宿主契约的人 | 从发布包摘录的参考资料，不随本仓库演进 |
| `AGENTS.md` | 本文件 | 工作方式变了才改 |

## 仓库形态

```
lib/index.js     Cordis 插件：Config、系统提示、五个工具
lib/runtime.js   连接与会话内核状态：绑定、重连、落盘、DNS 预热
lib/server.js    Jupyter REST 客户端：URL 归一化、token/密码、XSRF、cookie
lib/transport.js 出站 HTTP（node:http + keep-alive + 自定义 lookup）
lib/dns-cache.js 进程级解析缓存
lib/websocket.js 最小 RFC 6455 客户端（内核通道）
lib/kernel.js    内核消息协议、输出归一化、产物落盘
lib/notebook.js  面板模型：单元格、增量渲染、后台运行、镜像、模型侧读写
lib/ipynb.js     .ipynb 的读写（纯函数，无 I/O：调用方注入 image 回调）
lib/activity.js  面板活动 → 模型的上下文：缓冲、note 文案、agent/pre-step 交付
lib/assets.js    内容寻址图片仓库
lib/routes.js    四条同源路由 + SSE
lib/client.js    浏览器半边（工厂字符串，无构建、无 JSX）
```

**两半的生效方式不同**：宿主半边（`index/runtime/server/transport/dns-cache/websocket/kernel/
notebook/ipynb/assets/routes`）改完要**重启 DeepSeek Harness**；浏览器半边（`client.js`）刷新
页面即可。先确认自己在改哪一半，否则会以为改动没生效。

## 不能破的约束

1. **不引入依赖，不引入构建步骤。** 客户端只能 `require('react')`，没有 JSX、没有 npm 包、
   没有 bundler。高亮、Markdown、HTML 清洗都是手写的，这是有意的。
2. **访问 Jupyter 只能走 `lib/transport.js` 和 `lib/websocket.js`。** 换成 `fetch` 或内置
   `WebSocket` 会同时丢掉 DNS 缓存和正确的 `Host`：前者让每次请求多 5 秒，后者换来 403。
3. **面板路由只能注册精确路径。** `connection.fetch` 是精确匹配表，参数必须走 query；
   想加 `/asset/<name>` 这种子路径会 404。
4. **面板命令不带 `request.signal`。** 带着它，刷新页面等于取消命令，`runCell` 甚至会一路
   中断内核。执行归笔记本所有，不归请求所有。
5. **一次执行一个队列。** iopub 消息没有 request id，所有执行必须经过
   `KernelConnection.#queue`，不要另开并发路径。
6. **大 payload 不进笔记本 JSON。** 图片走 `AssetStore` 换 URL；视图是每次点击都要重发的。
7. **面板活动只走 `agent/pre-step` 的 notice。** 不要直接往会话 `append` 一条 user/message：
   一条 note 不该凭空开出一轮对话，交付时机归 agent 决定；来源必须是 `kind:'plugin'`，
   不能伪装成用户输入。模型自己经 `jupyter_notebook` 做的增删改必须传 `{ note: false }`，
   否则下一轮会把模型的动作描述成用户做的。
8. **新格子只能靠 `insert` 事件出现。** `cell` 事件只更新已存在的格子——一个被删掉的格子不该
   被收尾事件重新加回来。`insert` 要带 `index`，客户端才能把它放在正确的位置。
9. **测试服务器不要 `disable_check_xsrf`。** 它会把真实的 XSRF 缺陷藏起来——第一轮就是这么
   漏掉 `X-XSRFToken` 的。
10. **有意不做的事**（别"顺手"补上，先看 `docs/design.md` §10）：`.ipynb` 的无损往返
    （现在是有损的，每一处丢失都要报 warning）、LaTeX/JSON 输出、虚拟滚动、`jupyter_execute`
    流式、Agent 格子的自动折叠。

## 验证

```bash
node test/transport.mjs   # 传输层，自带 peer，无需 Jupyter
node test/ipynb.mjs       # .ipynb 往返与丢失项（纯函数）
node test/notebook.mjs    # 面板模型与四条路由
node test/activity.mjs    # 面板活动 → 模型上下文（note 文案、交付守卫）
node test/client.mjs      # 浏览器半边（假 React 装载，不跑真实 DOM）

# 需要真服务器（起法见 README「Verifying a change」）
node test/e2e.mjs
node test/register.mjs    # 需要 node_modules 链接到 DSH 包
```

`test/register.mjs` 依赖 `node_modules` 指向 DSH 的包（开发用软链，不进包清单）：

```bash
ln -s <extracted-dsh-packages>/node_modules node_modules
```

`npm test` 跑全部七套（`scripts/test-all.mjs`）：五条离线套件总会跑，`e2e` 与 `register` 只在
`JUPYTER_TEST_URL` 存在时加入。只改渲染或面板行为时，离线五套够了；动了协议、认证、生命周期，
必须跑 `e2e`。

## 提交

沿用现有风格：`type(scope): 一句话`（`feat` / `fix` / `perf` / `docs` / `test` / `chore`），
正文说明**为什么**以及怎么验证的。一次提交一件事，文档改动可以单独一次。
