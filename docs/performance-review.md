# 性能评估与改造记录

日期：2026-10-23
对象：`@local/dsh-jupyterlab` 0.1.0（改造前快照 `cf1f252`）
环境：macOS，Jupyter Server 2.21.1 @ `http://jupyterbox.local:9002/lab`（10.0.0.10），密码认证

## 结论先说

**"慢"不是插件逻辑慢，是 DNS 慢。**

`jupyterbox.local` 是 mDNS 名字。macOS 上解析它一次要 **约 5.02 秒**：`mDNSResponder` 先发多播
查询（还要重试），失败后才回落到 `/etc/hosts`。而 `fetch` 和内置 `WebSocket` **每条连接都会自己
解析一次**，解析器不可注入 —— 于是插件里**每一次 HTTP 请求**都白付 5 秒。

实测（同一台机器、同一台服务器）：

| 操作 | 改造前 | 改造后 |
| --- | --- | --- |
| `GET /api/status` 单次请求 | 5 020 ms | **6 ms** |
| 面板一次点击（view + 内核状态） | 5 019 ms | **6 ms** |
| 首次执行（挂载后） | 20 222 ms | **132 ms** |
| 热执行 `jupyter_execute` | 10 122 ms | **83 ms** |
| 一次 10 连点（每次回传整个笔记本） | — | 104 ms |
| 上面的 7 次调用合计 | 45 347 ms | 5 176 ms（其中 5 000 ms 是进程内唯一那次解析） |

补充证据（改前，直接打网络层）：

```
tcp connect 到 jupyterbox.local:9002    5020 ms   （每次新建连接都是）
dns lookup                             5006 ms
curl 走已建好的连接                      10 ms
按 IP 直连 10.0.0.10                    12 ms
```

另外两条路都走不通，这也是为什么必须换传输层而不是"改成连 IP"：

- `fetch` 里传 `Host` 头会被 undici 覆盖（实测 `host: 127.0.0.1:9128` 照发），内置 `WebSocket`
  同样覆盖；
- Jupyter 会校验 `Host`：拿着有效 token、把 `Host` 换成 `weird.local:9003` 访问本机服务器，
  答案是 **403**。

## 改了什么

### 1. 传输层换成 `node:http`/`node:https`（主因修复）

新增 `lib/dns-cache.js` + `lib/transport.js`：

- 进程级 DNS 缓存（一条 host 一个地址，TTL 5 分钟，并发去重），以 `lookup` 形式注入
  `http.request`，`Host` 与 TLS SNI 仍然来自原主机名，所以 Jupyter 的校验照旧通过；
- keep-alive Agent，第二次请求只付 RTT；响应整体读干，socket 才能回池；
- 超时/取消统一走 `AbortSignal`，错误码保留 `JUPYTER_UNREACHABLE` / `JUPYTER_TIMEOUT` 等。

### 2. 内核通道换成自带的 WebSocket 客户端

新增 `lib/websocket.js`（握手走 `http.request` 的 upgrade，复用同一个 `lookup`；实现 masking、
16/64 位长度、分片、ping/pong、close）。握手也要正确 `Host`，只有自己建 socket 才能同时满足
"不解析"和"Host 正确"。

### 3. 挂载时预热解析

`runtime` 构造/改地址时在后台解析一次，把这一次 5 秒从"第一次执行"挪到"插件加载时"。

### 4. 面板侧的四笔账

| 问题 | 处理 |
| --- | --- |
| 每次 `view()` 都查一次内核状态（一次网络往返） | 2 秒 memo，内核动作时失效 |
| `Shift+Enter` = `updateCell` + `runCell` 两次往返 | 草稿随 `runCell` 一起发，一次往返 |
| `view()` 用 `structuredClone` 深拷贝每个单元格（含 base64 图） | 浅拷贝；路由马上序列化，不需要两份 |
| 每次改动同步写镜像文件（含整份 base64、还带缩进） | 小笔记本立即写（便宜且更可靠），大的延后 60 ms 合并写；运行前与 `dispose` 强制落盘 |

### 5. 顺手修掉的可用性问题

- **运行中也能点"中断"**：原来 `busy` 把整条工具栏禁用，长单元格跑起来就无法中断。
- **面板会自己刷新**：4 秒一次、只在可见时、带 `?since=<revision>`，没变化时返回两个字段、
  根本不碰 Jupyter。这样 agent 在共享内核里跑的东西能自己出现在面板上。
- `jupyter_status` 的内核查询与服务器探测并行，不再串行。

### 6. 测试

新增 `test/transport.mjs`（14 项，自带 HTTP/WS 服务器，不需要 Jupyter）：DNS 缓存命中、并发去重、
IP 字面量不解析、**5 次请求只开 1 条 TCP 连接**、`Host` 保持主机名、请求体/响应体/`Set-Cookie`、
超时拒绝、文本帧往返、300 字节（16 位长度）、200 KiB（64 位长度）、close 只报一次、握手被拒、
关闭后 `send` 抛错。

回归：`client.mjs` 26 项、`notebook.mjs` 26 项、`e2e.mjs` 29 项全绿（`e2e.mjs` 里
`no sockets outlive the runtime` 在本机原本就会把进程自己的 stdio 管道算进去，已排除 `PipeWrap`）。

## 第二轮：把剩下的空间做完（同日晚）

上一轮把"每次请求 5 秒"变成"每进程 5 秒"。这一轮处理报告里按收益排的前三项，外加渲染和
两处小账。

### A. 输出流式回传（原第 1 项，收益最大）

链路：`execute_request` → iopub 逐条消息 → `KernelConnection.execute({ onOutput })` →
`Notebooks` 的 `OutputRenderer` 增量渲染 → 每个会话的事件订阅 → SSE 路由 → 浏览器。

关键决定：**执行归模型所有，不归请求所有。** `POST runCell` 在 20 ms 内返回，执行在后台继续，
不再有"请求断了所以单元格被杀"的问题——原来刷新页面会 abort 掉 POST，那个 signal 一路接到
`POST /api/kernels/<id>/interrupt`，等于刷新即中断。

实测（真内核，`print(i); time.sleep(0.6)` ×5，本地 9003，`scripts/bench-stream.mjs`）：

```
runCell answered after 22 ms (still running: true)
    16 ms  cell   "running"
   315 ms  text   "0\n"
   929 ms  text   "1\n"
  1540 ms  text   "2\n"
  2149 ms  text   "3\n"
  2760 ms  text   "4\n"
  3368 ms  text   "'done'"
  3401 ms  cell   "ok"
```

改造前：这一格要 3 401 ms 才有第一次响应，中途面板只有一个 `running…`。

实现细节：

- SSE 帧按 60 ms 合并。一个 print 循环能在一秒里产生上百条 iopub 消息，一条一帧的框架开销比
  它喂的渲染还贵。`cell`（开始/结束）事件不合并，立即下发。
- 增量渲染把**连续同名 stream 合并成一个节点**，否则一千次 print 就是一千个 `<pre>`。
  这一条对 `renderableOutputs` 同样生效，批量与增量两条路径结果一致。
- 结束时用内核的完整输出列表**重算一次**，所以落盘和留存的状态与"非流式"完全一致；增量那份
  只是给人看的。
- 心跳 25 秒一次注释帧；请求 abort 时释放订阅与计时器，反复开关面板不留东西。

### B. 图片不再进笔记本 JSON（原第 2 项）

`lib/assets.js`：按内容哈希落盘（`$DSH_HOME/jupyterlab/assets/<sha256 前 20 位>.<ext>`），
单元格里只留 `api/jupyterlab/asset?name=<hash>.png`，路由带 `immutable`，浏览器永久缓存。
同一张图重绘一次复用同一个 URL；内存 32 MiB LRU，磁盘 256 MiB 上限并按最旧优先清理。

实测（一格 4 张图，每张 base64 933 KiB，`scripts/bench-payload.mjs`）：

| `view()` 载荷 | 大小 |
| --- | --- |
| 改造前（data URL 内联） | 3 734 KiB |
| 改造后（资源 URL） | **1 KiB** |

注意路由是**精确路径**匹配（宿主 `connection.fetch` 就是精确注册表），所以名字走 query 而不是
路径段——`/api/jupyterlab/asset/<name>` 会 404。

### C. `React.memo` 与长笔记本（原第 4 项）

`Cell` 包了 `React.memo`，但要它真的生效还需要两件事：

1. **对象身份**：每次 `view()` 都是新解析的 JSON。每个单元格加了 `rev` 计数，拉回来的视图在
   `rev` 未变（且不在运行中）时复用上一个对象，于是没变的单元格引用相等。
2. **回调稳定**：原来每个单元格拿到 8 个内联箭头函数，永远不相等。改成 `useCallback` +
   `useRef` 读当前状态，引用恒定。

没有这两条，`memo` 只会多一层比较然后照样全量重渲染。虚拟滚动没做：`memo` 之后每个 SSE 帧
只会重渲染一个单元格，实测值不值得再引入一套行高测量与滚动同步，留作后续。

### D. 顺带修掉的小账

- **刷新不再打断单元格**：见 A，`runCell` 不再带 `request.signal`。
- **`jupyter_status` 的 `version` 恒为空**：`/api/status` 在 jupyter_server 2.x 上确实没有这个
  字段，`/api/version` 是 404；但 **`GET /api` 返回 `{"version":"2.21.1"}`**。改成并行取
  `/api`，实测输出 `version: "2.21.1"`。
- **`/etc/hosts` 别名**：环境里 `/etc/hosts` 只有 `10.0.0.10 jupyterbox.local`，不带 `.local`
  的名字仍未定义，而改 hosts 需要 root。给了幂等脚本 `scripts/alias-host.sh`（自动备份，
  `dscacheutil -flushcache` + `killall -HUP mDNSResponder`），一条命令即可：
  `sudo scripts/alias-host.sh jupyterbox 10.0.0.10`。**这条没有在本机执行**（沙箱里 sudo 不可用），
  需要你自己跑一次，然后把 `url` 换成 `http://jupyterbox:9002/lab`。

### 测试

`test/notebook.mjs` 26 → 33 项（后台执行不阻塞、事件顺序、取消订阅、资源存储去重与路径穿越、
SSE 路由真的推帧、资源路由的 immutable 头与 404）；`test/client.mjs` 26 → 30 项（流式补丁、
clear 事件、图片走 URL、poll 不改变对象身份）。

全套：transport 14 / notebook 33 / client 30 / e2e 29 / register 21 = **127 项全绿**。

## 第三轮：渲染（高亮 / Markdown / 富输出）

这一轮不追吞吐，追的是"面板能看见什么"。性能上的判断只有三条：

### A. 高亮用分词器，不用 parser

没有构建步骤、没有客户端依赖，所以 highlight.js / Prism 这类东西不可用。一次全局正则按优先级
出 token（行首 magic → 注释 → 字符串 → 装饰器 → 数字 → 标识符 → 运算符），再做一遍
"`def`/`class` 之后是名字、`(` 之前是调用"的二次标记。

成本是每次重绘对单元格源码扫一遍，O(字符数)，没有语法树。正确性的下限是**字符串里的 `#`
不能被当成注释**——这是唯一会让代码读错的地方；f-string 内部表达式、括号深度明确不做。

编辑器不改输入路径：透明 textarea 盖在高亮副本上，光标、选区、IME 都是原生行为；组字期间
（`data-composing`）把高亮层藏起来，让 textarea 自己的字显示出来，否则拼音候选看不见。

### B. HTML 输出挂 shadow root，不用 iframe

`text/html` 是 pandas / polars / Styler 的默认表示。两条路：

| 方案 | 代价 |
| --- | --- |
| iframe + `srcdoc` | 高度必须写死（或 postMessage 量高），每条输出多一个文档 |
| shadow root | 无额外文档，自然高度，CSS 完全隔离 |

选后者：`DOMParser` 解析 → 洗掉 `script`/`iframe`/`object`/`link`/`meta`/`base`/`form`、
所有 `on*`、`srcdoc`、`javascript:`（含 `<style>` 里的 `@import`）→ 挂到 shadow root。
链接在 scheme 检查之后补 `target`/`rel`，否则点一下就把整个对话页导航走了。

### C. 富输出有预算，超了退回纯文本

`MAX_HTML_BYTES` 256 KiB、`MAX_TEXT_PER_CELL` 200 000 字符、`MAX_IMAGES_PER_CELL` 8、
`MAX_IMAGE_BYTES` 2 MiB。视图每次点击都要重发，所以宁可退回纯文本并留一行说明，也不把
一份 5 MiB 的 HTML 塞进每一次 `view()`。

### 实测与回归

- `df` 在真内核上产出**一条 644 字节的 `text/html`**，`display(df)` 相同；渲染进 shadow root
  后是一张真表格，不再是等宽字符画。
- markdown 单元格的 `runCell` **14 ms** 返回，不启动内核、不产生执行计数。
- jsdom + 真 React 挂载面板：表格在 `shadowRoot` 内；敌意输出跑完 `window.pwned` 仍是
  `undefined`；两层编辑器的 `font`/`padding` 计算值相等。
- 套件：notebook 33 → 37，client 30 → 41；五套 14 / 37 / 41 / 29 / 21 = **142 项全绿**。
  2026-10-24 又离线复跑前三套：14 / 37 / 41 = 92 项全绿。

## 还剩下的空间

按收益排，都不如上面三项大：

1. **多会话共享一个内核。** 现在一个内核只允许一个 DSH 会话绑定；要共享需要把 binding 从
   session 提到 profile。属于能力扩展，不是性能。
2. **`jupyter_execute` 自己还没有流式**。面板有了，工具面（模型看结果）仍是一次性返回；
   对 agent 来说通常更好（少一轮）、但跑长任务时模型无法中途看到进度。
3. **输出落盘策略**。`maxOutputChars` 默认 2 万字符，超出按头 6/尾 4 截断；大输出更适合
   "写文件 + 报路径"。
4. **`maybeComplete` 的 2 秒宽限与 `interruptAndSettle` 的 3 秒兜底**：只在异常路径出现，
   正常路径不受影响。
5. **虚拟滚动**：见第二轮 C，`memo` 之后每帧只重渲染一格，等真有上百单元格的实际反馈再决定。
6. **剩下的 MIME**：`application/json` 与 LaTeX 现在只报类型名。要画，得各写一个渲染器，
   而 LaTeX 还要额外引入一个排版库——与"无构建、无依赖"冲突，暂时不做。
7. **`.ipynb` 导入导出**：Contents API 没接，单元格的 `path` 字段目前只是占位。要做的话，
   落点分别在 `lib/server.js`（读写文件）和 `lib/notebook.js`（格式转换）。

## 复测方法

```bash
# 三套离线套件（不需要 Jupyter）
node test/transport.mjs && node test/notebook.mjs && node test/client.mjs

# 传输层单跑
node test/transport.mjs

# 真实服务器上的端到端对比（BEFORE 用快照 worktree）
git worktree add /tmp/dsh-old cf1f252
node /tmp/jl-cmp2.mjs /tmp/dsh-old/lib                     # 旧
node /tmp/jl-cmp2.mjs "$PWD/lib"                           # 新

# 流式：真内核上打印 5 行、每行间隔 0.6 秒，看首帧时间与命令返回时间
JUPYTER_URL=http://127.0.0.1:9003/lab JUPYTER_TOKEN=... node scripts/bench-stream.mjs

# 图片载荷：同一格 4 张图，比较 view() 的字节数（不需要服务器）
node scripts/bench-payload.mjs
```
