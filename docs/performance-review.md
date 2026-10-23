# 性能评估与改造记录

日期：2026-10-23
对象：`@local/dsh-jupyterlab` 0.1.0（改造前快照 `cf1f252`）
环境：macOS，Jupyter Server 2.21.1 @ `http://aimax395.local:9002/lab`（192.168.5.200），密码认证

## 结论先说

**"慢"不是插件逻辑慢，是 DNS 慢。**

`aimax395.local` 是 mDNS 名字。macOS 上解析它一次要 **约 5.02 秒**：`mDNSResponder` 先发多播
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
tcp connect 到 aimax395.local:9002     5020 ms   （每次新建连接都是）
dns lookup                             5006 ms
curl 走已建好的连接                      10 ms
按 IP 直连 192.168.5.200                12 ms
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

## 还剩下的空间（按收益排序）

### A. 单元格输出流式回传 —— 收益最大

现状：`runCell` 一个 POST 顶到执行结束才回，中途只有 `running…`。跑 60 秒的单元格，用户盯着
60 秒的空白。内核本来就在 iopub 上逐块给数据，缺的是这一段通路。

建议：`GET /api/jupyterlab/notebook/stream?sessionId=…` 用 SSE，把 `stream` / `display_data` /
`error` 增量推给浏览器；`POST runCell` 立刻返回（命令已受理），输出走 SSE 补齐。风险：多一条长连接
的生命周期管理，以及宿主 route 是否支持流式响应需要确认。

### B. 图片不再塞进笔记本 JSON

现状：每个单元格最多 8 张图、每张 2 MiB，全部 base64 内联在 `view()` 里。没有图时无所谓，一旦
有图，每次完整回传都是几 MB 的序列化 + 传输。

建议：`GET /api/jupyterlab/asset/<cellId>/<index>` 输出二进制并带 `immutable` 缓存头，单元格里只留
URL 和尺寸；`?since=` 已经保证了轮询不重传。收益：图多的笔记本从 MB 级回传降到 KB 级。

### C. 再省掉进程里那次 5 秒

mDNS 解析一次就够（已预热），但进程重启后还会再付一次。彻底的办法是不要 `.local`：

```
# /etc/hosts 里加一个不带 .local 的别名
192.168.5.200  aimax395
```

然后把 `url` 配成 `http://aimax395:9002/lab`。不带 `.local` 的名字走 `/etc/hosts` 是毫秒级。
（这条是环境建议，插件不再依赖它 —— DNS 缓存已经让"每请求 5 秒"变成"每进程 5 秒"。）

### D. 长笔记本的渲染成本

现在每次 `view` 变化都会重算所有 `Cell`。几十个单元格无感；上百个 + 多张图时，React 侧的 diff
会成为新的瓶颈。建议 `React.memo` 包 `Cell`（props 已经是纯数据），必要时再上虚拟滚动。

### E. 页面刷新会打断正在跑的单元格

`routes.js` 把 `request.signal` 一路传到内核，浏览器取消请求（刷新、关标签）会转成 interrupt。
多数人希望刷新后单元格继续跑完。建议：面板发起的执行不绑定 `request.signal`，只保留宿主超时；
中断交给显式的"中断"按钮。

### F. 其它小账

- `jupyter_status` 报告的 `version` 在 jupyter_server 2.x 上恒为空（`/api/status` 不含该字段，
  `/api/version` 是 404）。要么去掉，要么从别处取。
- `maybeComplete` 在缺少 `idle` 状态时有 2 秒宽限，`interruptAndSettle` 有 3 秒兜底 —— 只在异常
  路径上出现，正常路径不受影响。
- `maxOutputChars` 默认 2 万字符，超出按头 6/尾 4 截断；大输出更适合"写文件 + 报路径"。
- 一个内核只允许一个 DSH 会话绑定；多会话想共享同一内核，需要把 binding 从 session 提到 profile。

## 复测方法

```bash
# 传输层（无需 Jupyter）
node test/transport.mjs

# 真实服务器上的端到端对比（BEFORE 用快照 worktree）
git worktree add /tmp/dsh-old cf1f252
node /tmp/jl-cmp2.mjs /tmp/dsh-old/lib                     # 旧
node /tmp/jl-cmp2.mjs "$PWD/lib"                           # 新
```

`jl-cmp2.mjs` 的三段分别是：首次执行（含内核握手）、5 次面板视图、一次热执行。
