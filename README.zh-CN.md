# 面向 DeepSeek Harness 的 JupyterLab

[English](README.md) · 简体中文

一个把 DeepSeek Harness 接到 Jupyter 服务器上的插件包。给它一个 JupyterLab 地址——比如
`http://aimax395.local:9002/lab`——模型就能在一个**常驻的远端内核**里运行代码：变量、导入和
工作目录在多次工具调用之间都还活着，于是一段对话可以像一次 notebook 会话那样，把分析一层层
搭起来。

这里没有任何东西在本地执行：插件直接用 `fetch` 和一个 WebSocket 讲 Jupyter Server 的 REST API
与内核消息协议，没有 Python、没有 `jupyter_client`，除了 DSH 自己带的包以外也没有任何 npm 依赖。

## 模型能拿到什么

| 工具 | 作用 |
| --- | --- |
| `jupyter_connect` | 让 Harness 指向一个 JupyterLab 地址并验证凭据。会归一化 `/lab`、`/tree` 和 `?token=...`；报告服务器版本、kernelspec 和正在运行的内核。 |
| `jupyter_status` | 连接状态、服务器版本、kernelspec、运行中的内核，以及这段对话绑定在哪个内核上。 |
| `jupyter_execute` | 在会话的内核里运行代码；返回 stdout、最后一个表达式的值、stderr、traceback，以及存下来的图片/PDF 输出路径。这次运行同时会作为一格记录进面板，并标上 `模型` 徽标。 |
| `jupyter_notebook` | 读取面板里的笔记本（单元格、源码、输出、执行计数），并对其中一格做 `add`、`update`、`delete` 或 `run`。`ifRevision` 会拒绝一个基于模型没看过的版本的修改；`update` 会在面板里留下可复核的 diff，而不是悄悄换掉你的代码。 |
| `jupyter_kernel` | `list`、`start`、`restart`、`interrupt`、`shutdown`，或者 `attach` 到服务器上已经存在的某个内核。 |

会话按 DeepSeek Harness 的对话分别绑定，所以两个聊天不会共享命名空间。绑定关系镜像到
`$DSH_HOME/jupyterlab/kernels.json`，因此插件重载或应用重启之后会重新接上同一个内核，而不是
悄悄起一个空的。

## 笔记本面板

插件还在**右侧边栏**放了一本笔记本，就在对话旁边：

- **单元格**：`+ 单元格` 在末尾加一格，`✕` 删除，`↑`/`↓` 上下移动，`⌫` 清掉某一格的输出，
  工具栏的 `清空输出` 清掉全部。单元格头部的标签在代码与 markdown 之间切换；它写着面板用的是
  哪种语言（`Py`、`R`、`Jl`，内核没有对应分词器时是 `<>`）。markdown 单元格是渲染而不是运行，
  并且从不碰内核。
- **编辑**：双击单元格的源码就地编辑；`完成`、`Esc` 或直接运行它都会提交改动。点 `运行` 则
  按当前内容跑。代码在静态显示和输入过程中都上色——用的是内核自己的语言（取自 kernelspec），
  所以 R 单元格不会被 Python 的关键字染色，认不出的内核按纯文本显示而不是猜一个。编辑器是一层
  透明的 textarea 压在自己文字的彩色副本之上，光标、选区和输入法都保持原生（输入法组字期间
  下层让位）。
- **快捷键**：`Shift+Enter` 运行并退出编辑，`Ctrl/Cmd+Enter` 原地运行、编辑器保持打开，
  `Ctrl/Cmd+S` 只保存不运行，`Tab`/`Shift+Tab` 缩进与反缩进（有选区时逐行处理），`Enter` 继承
  当前缩进、并在 `:` 或 `{` 之后多加一级，`Esc` 退出编辑且不保存。输入法组字期间按的键属于
  输入法。
- **运行**：编辑器里 `Shift+Enter` 就是保存并运行——和 JupyterLab 同一个手势，而且只发一个
  请求：单元格的草稿随这次运行一起走，不必先保存。输出渲染在单元格下方：stdout、stderr、
  最后一个表达式的值、traceback、图片（PNG/JPEG/GIF/WebP）、markdown 和 HTML。
- **全部运行**：自上而下执行每一个非空代码单元格，作为一个序列，逐格等待完成，所以第 3 格能
  看到第 2 格定义的东西。运行期间按钮变成 `停止`：它中断正在执行的那一格，并且不再往下发。
  markdown 单元格和空单元格会跳过，序列进行中新加的格子不会被带上。
- **中间插入**：单元格头部的 `+` 在它正下方加一格，而不只是在笔记本末尾加。
- **未保存的改动能扛过一次刷新**：你打了但没有提交的文字存在这个标签页的 `sessionStorage` 里，
  所以手滑按了 F5，编辑器会带着那段文字回来。它从不离开浏览器——草稿不是一条命令。草稿按笔记本
  分层保存，所以你切到别的页看一眼再回来，那段没写完的段落还在原处。
- **一个会话里可以有好几本笔记本**：头部的选择器在它们之间切换，`+ 新建` 再开一本（最多十二本，
  名字由宿主起）。每一页有自己的单元格、输出和导出；它们共用这个会话的内核，所以在一页上定义的
  变量换到下一页仍然在。离开 `全部运行` 正在跑的那一页时它会停下——看不见的停止按钮等于没有。
- **长输出会折叠**：超过 24 行（或 4 000 字符，HTML 是 2 000）的输出默认收起，带一个 `展开`
  开关，于是一个刷屏的日志单元格不会把其余内容顶出屏幕。
- **富输出**：一个 MIME bundle 会取面板能画的最富的那一种来渲染。`text/html`——pandas、polars
  和 Styler 输出的就是它——挂载成一个真正的表格，放在 shadow root 里，于是它自己的 CSS 生效
  却又够不到面板；HTML 会先被剥掉脚本和事件处理器。`text/markdown` 走面板自己的 markdown 解析器
  （标题、列表、表格、带高亮的代码块）。`text/plain` 是兜底；超过 256 KiB 的标记会有意地回退到
  它上面。

- **运行过程中看得见**：`运行` 在内核拿到代码时就返回，输出则随着产生被推送到面板。一个要打印
  一分钟的单元格，一秒后就出现第一行；关掉或刷新页面都不会让它停下。
- **会告诉模型**：一次编辑、一次运行（连同结果和它打印内容的末尾）、一次删除、一次清空输出——
  每一件都排进队列，在模型下一步时作为**归属本插件的上下文提示**送达，而不是当成用户打的字。
  头部显示还有多少条在等（`2 条待同步`），点这个徽标会列出将要发送的具体内容，并提供丢弃选项。
  一次运行的「开始」会被它的结果替换，所以模型每一格只看到一条准确的提示，而不是一串。一个会话
  的第一批提示还会附带一张「一行一格」的地图，这样一条提示可以对一本还没看过的笔记本说「第 3 格」。
- **实时**：面板可见时还会轮询宿主，并且带上自己已有的 revision。模型在共享内核里的一次运行
  会作为单独的一格出现，标着 `模型`，于是这本笔记本记录的是整段分析，而不只是用户的另一半。
  什么都没变时答复只有两个字段，根本不会碰到 Jupyter。
- **可复核的改动**：当模型改写你写的某个单元格（`jupyter_notebook` 的 `update`）时，那一格会
  出现 `有改动` 标记，而不是悄悄变成另一段代码。展开它能看到被替换掉的内容的逐行 diff；`保留`
  接受它，`撤销` 用一条命令恢复你的版本。你自己的编辑是新的基线，会清掉这个标记。
- **内核**：头部显示绑定的内核，并提供 `中断` 与 `重启内核`。
- **可移植**：`导出` 把笔记本下载成 `.ipynb`（nbformat 4.5，带执行计数和输出）；`导入` 用你选的
  文件替换它。这次转换是**有损**的，并且写在文档里——raw 单元格变成 markdown，面板画不出的输出
  类型被丢弃，过大的图片和标记会回退或被删——但每一处损失都会在工具栏下方的一行里报告出来，
  而不是悄悄发生。

**面板与模型共用一个内核、一本笔记本。**你在单元格里定义的变量，`jupyter_execute` 立刻能看见，
反过来也一样，双向且立即——不存在另一个「笔记本内核」。并发由同一个按内核排的队列处理，所以
模型在执行时你运行一格，它只是排队等一等。模型也能用 `jupyter_notebook` 读和改你写的单元格，
这正是「修一下第 3 格」这类请求可以被执行、而不必靠猜的原因。一个会话可以容纳好几本笔记本；
工具的每次回复都会说明面板上是哪一本，而切换页面会告诉模型：之前的单元格编号已经不指向原处了。

单元格镜像到 `$DSH_HOME/jupyterlab/notebooks/<session>.json`，所以刷新页面或重启应用都能恢复。

### 打开它

会话第一次挂载时，面板会自动打开一次。之后：

- 输入框工具行里的 **笔记本** 按钮可以重新打开它；
- 右侧边栏的 **+** 控件把它列为一种页面（即 guide 条目）；
- 一旦打开过，布局按会话记住，下次加载页面时恢复。

关掉它不花任何代价：右栏收起，同一个按钮就能把它叫回来。

`attach` 是通向交互式工作的桥：先在 JupyterLab 里起一个内核，再让模型接上去，直接接管你已经
定义好的变量。

## 安装

在这个目录下，于一个 DeepSeek Harness 会话中执行：

```
plugin_manager { action: "install_bundle", target: "/Users/yanhaopeng/MyProjects/dsh-jupyterlab" }
```

插件包会装进当前 profile，写进 `dsh.profile.bundles`，并通过 HMR 激活。读一下结果的
`application` 字段——`applied` 表示已经生效。

**首次**安装需要重启一次应用，原因有两个且互相独立：宿主那一半不 import 任何东西，但 Node 按
URL 缓存已导入的模块，所以一个正在运行的进程会一直用它最初加载的代码；另外宿主是从启动时读到的
manifest 里解析一个包的客户端产物的。重启之后，宿主的改动仍需重启，而客户端那一半的改动用刷新
页面即可生效。如果宿主对 `@deepseek-ai/*` 的 import 在当前进程里解析不了，重启一次 DeepSeek
Harness 应用；之后源码改动就直接从这个目录生效。

## 配置

上手只需要 `url` 一个字段，其余都有默认值。

**让模型来配。** 插件在完全没有配置的情况下也会加载。说「连到 http://aimax395.local:9002/lab，
token 是 XYZ」，模型就会调用 `jupyter_connect`。运行时设置一直有效，直到插件重新挂载。

**或者写进 profile。** 在 `$DSH_PROFILE_DIR/cordis.patch.yml` 里给这个插件那一行加一个 `config:`
映射，它会覆盖插件包自带的 patch：

```yaml
- id: jupyterlab
  name: '@local/dsh-jupyterlab'
  config:
    url: http://aimax395.local:9002/lab
    token: <your token>
    kernelName: python3
```

### 凭据

Jupyter 接受 token 或密码，两种都支持：

- **token** —— `jupyter server list`、服务器控制台输出，或 JupyterLab 打开的 URL 里的
  `?token=...`。优先级最高；如果 `url` 本身带 `?token=...`，会自动用上。
- **password** —— 你在 JupyterLab 登录页输入的明文密码。插件会走一遍 `/login` 表单流程
  （包括 `_xsrf`），并在 REST 调用和内核 WebSocket 升级时重放会话 cookie。

`jupyter_server_config.json` 里的密码**哈希**（`argon2:$argon2id$...` 那个值）不是凭据：它没法
被重放，只会被拒绝。请用明文密码，或者用 token。

凭据属于它被输入时针对的那台主机。把 Harness 指向**另一个**地址会丢掉之前的 token/密码，除非
同一次调用提供了替代值——这样「连到新服务器」永远不可能把旧服务器的秘密泄露给它。

### 选项

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `url` | — | JupyterLab 地址。`/lab`、`/tree`、结尾斜杠和 `?token=...` 都能识别。 |
| `token` / `password` / `username` | — | 凭据；`token` 优先。 |
| `kernelName` | `python3` | 为新会话内核启动的 kernelspec。 |
| `workingDirectory` | 服务器根目录 | 内核启动时所在目录（相对服务器根）。 |
| `requestTimeoutMs` | `20000` | 一次 REST 调用的时间预算。 |
| `executeTimeoutMs` | `180000` | 一次执行的时间预算，超时则中断内核。 |
| `autoStartKernel` | `true` | 首次执行时自动启动内核。 |
| `maxOutputChars` | `20000` | 每次执行保留的流式输出字符数（头与尾）。 |
| `artifactDirectory` | `$DSH_HOME/jupyterlab/artifacts` | 图片/PDF 输出的写入位置。 |

### 地址是 `.local` 名字时

在 macOS 上解析一个 `host.local` 名字大约要五秒：`mDNSResponder` 先发多播，之后才回落到
`/etc/hosts`。插件每个进程只付这一次（缓存在挂载时预热，之后每次请求或内核握手都复用它），
绝不会每次点击都付。想连这一次也省掉，就给机器一个不带 `.local` 后缀的名字：

```bash
sudo scripts/alias-host.sh aimax395 192.168.5.200   # /etc/hosts: 192.168.5.200 aimax395
```

然后把 `url` 设成 `http://aimax395:9002/lab`。脚本是幂等的，动 `/etc/hosts` 之前会先备份。
它是给这台机器的便利工具，不属于插件包本身。

## 实现方式

```
lib/index.js     Cordis 插件：Config schema、系统提示词、四个工具定义
lib/runtime.js   连接与内核会话状态：一个 DSH 会话一个内核，重连，镜像到磁盘
lib/server.js    Jupyter Server REST 客户端：URL 归一化、token/密码认证、XSRF、cookie jar
lib/transport.js 基于 node:http/https 的 HTTP：keep-alive 套接字、缓冲响应、中止处理
lib/dns-cache.js 进程级域名解析缓存，接入 http 与内核套接字
lib/websocket.js 内核信道上最小的 RFC 6455 客户端：掩码、分片、ping/pong
lib/kernel.js    在那些套接字之上的内核消息协议：执行、流式 iopub 输出、中断
lib/notebook.js  面板的模型：单元格、增量输出渲染、后台运行、镜像
lib/activity.js  用户在面板里做了什么，先缓冲，在模型下一步时交给它
lib/assets.js    按内容寻址的图片仓库：一张图一个文件，以 immutable 提供
lib/routes.js    面板的三条同源、需鉴权的路由（view/command、stream、assets）
lib/client.js    浏览器那一半：右侧边栏的标签页类型与笔记本 UI（无构建步骤）
```

几条值得知道的设计：

- **传输层用 `node:http` 而不是 `fetch`，因为 `fetch` 会自己重新解析主机名。** 一个用 mDNS
  名字寻址的 Jupyter 服务器（`http://aimax395.local:9002/lab`）在 macOS 上每次 `getaddrinfo`
  要花**大约五秒**——`mDNSResponder` 先发多播，之后才回落到 `/etc/hosts`。`fetch` 和内建的
  `WebSocket` 都在自己的每次连接里解析名字，没有传 resolver 的入口；而直接连原始 IP 会被
  Jupyter 拒绝，因为它会检查 `Host` 头（token 正确但 `Host` 不匹配就是 403）。`node:http`
  把这些一并解决：自定义 `lookup` 走 `dns-cache.js`，名字仍然作为 `Host` 和 TLS SNI 到达，
  再加一个 keep-alive agent，第二次请求只剩一个往返。针对上面那台服务器实测：面板点击从
  **5 020 ms 降到 6 ms**，热身后的 `jupyter_execute` 从 **10 122 ms 降到 83 ms**。
- **内核信道用自己的 WebSocket 客户端**，原因相同，外加一条：握手是唯一一个既要求 `Host` 头
  保持正确、又要求解析器是我们自己的地方。`lib/websocket.js` 只实现内核协议需要的部分。
- **域名解析在挂载时预热。** 每个进程那一次五秒查找无法避免，所以 `runtime` 在插件挂载时就
  发起它，而不是留给第一次工具调用；结果落进传输层要读的缓存。
- **插件永远不会加载失败。** `url` 是可选的，REST 客户端是懒构造的，所以地址缺失或写错会表现
  为一条可读的工具错误，而不是激活失败。
- **执行按内核串行。** iopub 不带请求 id，同一个内核上并发执行会把输出交错在一起。每次调用都
  排在上一次后面。
- **取消会中断内核。** `exec.signal`（来自工具超时策略或用户）和执行预算都会发
  `POST /api/kernels/<id>/interrupt`，然后返回这一格在停下之前打印的内容。内核和它的变量都
  还活着。
- **内核死掉会在发代码之前被发现。** 如果信道已关闭，就用 `GET /api/kernels/<id>` 核对绑定，
  然后重新接上或者替换掉。一次临时的重连失败从不关闭内核；只有显式的 `jupyter_kernel start`
  才会。
- **错误是可读的，不是调用栈。** 凭据不对报 `authentication failed`；主机不可达报地址和路由
  提示；不是 Jupyter 的 URL 报「响应不是 JSON」。密码被拒（401）和 XSRF token 被拒（403）分开
  报告，因为两者需要不同的修法。
- **Cookie 会话要带 XSRF token。** Jupyter 对每个修改类请求都查 XSRF，只对用请求头认证
  （token）的调用跳过。所以密码会话在每个 POST 和 DELETE 上都带 `X-XSRFToken` 头——没有它，
  登录成功、读也能用，但启动内核会失败并报
  `'_xsrf' argument missing from POST`。
- **面板路由注册在动态注入上。** 拥有 `/api` 的那个 `connection` 条目要等它自己的 inject 链，
  所以冷启动时，一个稍后挂载的插件执行 `apply` 时它**往往还没提供**。只读一次服务然后静默
  放弃，会产生最糟的症状——面板能加载，然后对一切都回 404——所以路由走
  `ctx.inject(['connection'], …)`，而 `jupyter_status` 会报告它到底注册上没有。
- **被内核丢掉的一格会重试一次。** 中断之后紧接着的下一个 `execute_request`，Jupyter 会回
  `status: "aborted"`——那一格根本没跑。这会被如实报告成 `aborted`（绝不假装成一次静默的空
  成功）并重试一次，之所以安全，正是因为第一次什么都没执行。
- **面板里的一次运行归模型所有，而不是归那个请求。** `POST runCell` 几毫秒就答复，执行在没有
  HTTP 请求挂着的情况下继续。输出从内核 iopub 信道里产生就往外面走，按 60 ms 合并（一条消息
  一帧的代价比它喂的那点渲染更高），经 `/api/jupyterlab/notebook/stream` 上的 SSE 送到浏览器。
  一个 `cell` 事件带着权威状态为这次运行收尾。这也是为什么刷新页面不再中断那一格：以前 POST 的
  中止被一路接到了 `POST /api/kernels/<id>/interrupt`。
- **一次运行的输出被渲染两遍，是有意的。** 运行中增量渲染，让面板长出来；然后再从内核的最终
  输出列表渲染一次，于是用户留下的那一格——以及磁盘上的镜像——与一次非流式运行本该产生的
  结果逐字节一致。
- **面板活动以上下文的形式到达模型，而不是聊天消息。** 用户在模型正在用的那个内核里编辑和运行
  单元格，所以没有一条提示的话，模型下一个请求描述的就是一本已经不存在的笔记本——变量被重定义、
  输出被清空、单元格被删掉。提示按会话缓冲，在 `agent/pre-step` 里追加到这一步的消息中，走的是
  `time-context` 和 `agent-instructions` 用的同一个 waterfall，并带
  `source: { kind: 'plugin', plugin: 'jupyterlab', form: 'notice' }`；转录里它们显示成一行折叠的
  上下文，而不是用户发言。两道保护很要紧：被拒绝或中止的步骤会保留它的提示；而一个没有消息的
  首步绝不会因为一条提示变成一次模型调用——一次编辑是对话的上下文，不是开启对话的理由。一次
  运行的开始与结束共用一个 key，所以只有结果活下来。
- **图片按内容寻址。** `lib/assets.js` 对字节做哈希，一张不重复的图写一个文件；单元格记住的是
  `api/jupyterlab/asset?name=<hash>.png`，路由以 `immutable` 回应。重画同一张图会复用同一个
  URL，一本有十张图的笔记本代价是十个文件而不是一份几兆的文档，每次点击也不用再序列化图片。
  （路由把名字放在查询参数里，是因为 `connection.fetch` 匹配的是**精确**路径——放在路径段里
  会 404。）
- **`React.memo` 要求 props 稳定，所以面板提供了稳定 props。** 每格带一个 `rev` 计数器；从宿主
  取回的视图在 `rev` 仍匹配时复用上一次的单元格对象，而每个处理器只创建一次、从 ref 里读当前的
  state。没有这一条，每次轮询都重渲染一百格，正好是传输层那番功夫刚从宿主身上省下来的开销。
- **一个会话是一张笔记本书桌，镜像成一个文件。** `{active, notebooks}` 是原子写入的，因为崩在
  两个文件之间可能重新打开错的那一页；多笔记本之前留下的镜像在加载时变成 `main`，所以升级从不
  丢掉当时唯一的那一页。换页作为独立事件在流上广播，并让客户端重读整份视图：另一份文档没法
  表达成对单元格列表的补丁。它同时丢掉 revision 守卫，因为 revision 只在一本笔记本内部可比。
- **高亮器是分词器，不是解析器。** 没有构建步骤也没有客户端包，所以一次正则扫描、配上刻意的
  优先级——行首的 IPython magic，然后注释、字符串、数字、名字与运算符——就产出编辑器要画的
  彩色片段。它不会弄错「字符串里含一个 `#`」这种情形，而那是真正要紧的失败；它不试图给 f-string
  里的表达式上色，也不管括号深度。语言来自 kernelspec 而不是笔记本：Python、R、Julia 各有自己的
  关键字表和正则，这三种之外的内核按纯文本渲染——用 Python 的语法给它上色等于教错一门语言。
  markdown 解析器遵循同样的原则：块结构按行，行内片段一个正则，每个节点都用 `createElement`
  造出来而不是拼 HTML 字符串。
- **内核产出的 HTML 是挂载，不是注入。** 输出是单元格自己决定要打印的东西，所以它先被
  `DOMParser` 解析，剥掉 `script`/`iframe`/`object`/`link`/`meta`/`base`/`form`、所有 `on*`
  属性、`srcdoc` 和 `javascript:` URL，然后追加到自己宿主元素上的一个 **shadow root** 里。
  shadow root 让表格拿到自然高度和完整的 CSS 隔离：pandas 的 `style scoped`、Styler 的规则都
  对它生效，而它们和 `body { display: none }` 都影响不到面板。这和 JupyterLab 用 iframe 达到的
  是同一个效果，但没有 iframe 那个固定高度。

## 文档

- **`docs/design.md`** —— 设计与索引：两半如何咬合、每个关注点住在哪（文件 + 符号），以及那些
  看起来奇怪的决定背后的原因。**改代码之前先读它**；`AGENTS.md` 给 agent 的也是这条指示。
- **`docs/performance-review.md`** —— 什么慢、量到了什么、改了什么，以及还剩多少余量。
- **`docs/dsh-client-plugin-contract.md`** —— 这个面板据以构建的宿主/插件契约，从已发布的包里
  抽取出来作为参考。

## 验证改动

两套测试要对着一台真实的 Jupyter 服务器跑。起一台一次性的，但**不要**削弱它的安全默认值——
用 `disable_check_xsrf` 起的服务器会掩盖真实的认证缺陷，这里第一轮测试里那个缺失的
`X-XSRFToken` 头正是这样活下来的：

```bash
# Token 认证。
jupyter server --no-browser --port=9003 \
  --IdentityProvider.token=dsh-test-token --ServerApp.root_dir=/tmp/dsh-jupyter-test

# 密码认证（一般部署用的就是这种配置）。trait 是
# `IdentityProvider.hashed_password`；写成裸的 `password` 选项会被静默忽略，
# 看起来和「密码错了」一模一样。
python -c "from jupyter_server.auth import passwd; print(passwd('dsh-test-password'))"
jupyter server --no-browser --port=9004 \
  --IdentityProvider.hashed_password='<hash from above>' --ServerApp.root_dir=/tmp/dsh-jupyter-test
```

然后：

```bash
npm test                 # 五个离线套件；设置 JUPYTER_TEST_URL 会加上 e2e 和 register
npm run test:offline     # 同上，显式地不连服务器

node test/e2e.mjs        # 协议与运行时：认证、执行、持久化、超时、内核生命周期
node test/register.mjs   # 在真实 cordis 上下文与真实 dsh-tools 注册表里挂载插件
node test/notebook.mjs   # 面板模型、它的路由、流式、模型写入的单元格、全部运行、导入
node test/ipynb.mjs      # .ipynb 双向：行数组、图片、预算，以及哪些内容会被丢掉
node test/activity.mjs   # 活动提示：措辞、批处理、大纲，以及 pre-step 投递的守卫
node test/client.mjs     # 浏览器产物：注册、渲染路径、点击、流式补丁
node test/transport.mjs  # DNS 缓存、套接字复用、Host 头，以及 WebSocket 帧编解码
```

```bash
# 密码路径（登录表单、XSRF、cookie 会话）——信任一个部署之前先跑这个：
JUPYTER_TEST_URL=http://127.0.0.1:9004/lab JUPYTER_TEST_PASSWORD=dsh-test-password node test/e2e.mjs

# 任何其他服务器，包括那台真的：
JUPYTER_TEST_URL=http://host:9002/lab JUPYTER_TEST_PASSWORD=... node test/e2e.mjs
JUPYTER_TEST_URL='http://host:9002/lab?token=...' node test/e2e.mjs
```

`test/transport.mjs` 不需要 Jupyter：它在 127.0.0.1 上起自己的 HTTP 与 WebSocket 对端，数客户端
开了几个套接字，并把各种长度档的帧往返一遍。

`test/e2e.mjs` 不需要 DSH 的任何包。`test/register.mjs` 会 import `@deepseek-ai/cordis` 和
`@deepseek-ai/dsh-tools`，它们要在 DSH 宿主进程里才解析得到；在宿主之外，把它们链接进来
（这只是开发期的链接，永远不属于安装后的插件）：

```bash
ln -s <extracted-dsh-packages>/node_modules node_modules
```

两套都读 `JUPYTER_TEST_URL`、`JUPYTER_TEST_TOKEN` 和 `JUPYTER_TEST_PASSWORD`。

## 已知限制

- **这个面板是笔记本，不是 JupyterLab。** JupyterLab 发送
  `Content-Security-Policy: frame-ancestors 'self'`，所以没法嵌进 Harness 的 UI 里；面板是对
  笔记本界面的原生重实现。它支持代码与 markdown 单元格的增、改、删、插入、运行、全部运行、
  排序和类型切换——没有补全、没有变量检查器、没有调试器。
- **可以同时开着好几本笔记本，但不能管理它们。** 一个会话最多十二本，每本有自己的单元格和导出；
  但都不能改名、关闭或删除，换页也仍然用同一个内核——所以变量和导入会跨页带过去，没有按笔记本
  分别绑定内核这回事。导出写的是你正在看的那一页。
- **`.ipynb` 的导入导出是有损的。** 读写笔记本文件能用，但面板只持有格式的一个子集：raw 单元格
  导入成 markdown，面板画不出的输出类型和超过 2 MiB 的图片会被丢掉，超过 256 KiB 的 `text/html`
  退化为纯文本，一份文档上限 500 格。每一处损失都会报告；文件与 JupyterLab 写出的不会逐字节相同。
- **输出支持是选定的子集。** 图片、`text/html`、`text/markdown` 和文本会被渲染；
  `application/json`、LaTeX 和任意 MIME 类型不会（一个只带这些的 `display_data` 会列出它的
  MIME 类型而不是画出来）。HTML 是被净化而不是被信任的，所以一个依赖自己 `<script>` 的输出——
  交互式控件、plotly 图——只会渲染它的静态标记。
- **单元格的输出在运行中流式出现。** `运行` 在内核拿到代码时就返回，iopub 输出产生即推到面板，
  所以一个要打印一分钟的单元格一秒后就出现第一行。中断按钮全程可点。
- **面板提示在下一步才到达。** 排队的提示是下一个模型请求的上下文，不是代替用户发出的消息：
  在模型空闲时编辑一个单元格，只会更新徽标，在对话继续之前什么都不发。已经在飞的请求不会被注入
  任何东西。
- **配置没有表单。** 一个打包的 profile 如果没有手写的客户端产物，就没有 schema 驱动的设置界面，
  所以地址和凭据来自 profile YAML 或一次 `jupyter_connect` 调用。
- **Config schema 会校验，但不会被投影。** 因为插件不 import 任何依赖，它的 `Config` 是一个手写的
  Standard Schema 而不是 schemastery 的，所以 Cordis 仍会校验并给每个选项填默认值（值不对会在
  激活时以可读消息失败），但 `Config` 的 inspect provider 报 `unsupported`，而不是渲染一份
  JSON Schema。
- **一次只有一台服务器。** 运行时只持有一个连接；`jupyter_connect` 会切换它。
- **只做代码执行。** Contents API（在服务器上读写笔记本文件）还没有暴露。
- DSH 会话结束时内核仍留着；用 `jupyter_kernel` 或在 JupyterLab 里把它们关掉。
