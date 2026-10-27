# 面向 DeepSeek Harness 的 JupyterLab

[English](README.md) · 简体中文

一个把 DeepSeek Harness 接到**一台或多台 Jupyter 服务器**上的插件包。给它一个 JupyterLab
地址，模型就能在一个**常驻的远端内核**里运行代码：变量、导入和工作目录在多次工具调用之间都还
活着。本地服务器和远端机器可以同时连着，右侧边栏里每一页笔记本都运行在它绑定的那台服务器上。

这里没有任何东西在本地执行：插件直接用 Jupyter Server 的 REST API 和内核协议通信，不需要
Python，除了 DeepSeek Harness 自带的包以外也没有任何 npm 依赖。

## 模型能拿到什么

| 工具 | 作用 |
| --- | --- |
| `jupyter_connect` | 添加一条 JupyterLab 连接并验证凭据。已连接的服务器保持连接，新的成为默认。 |
| `jupyter_status` | 每一台已连接的服务器、默认那台的版本与内核，以及这段对话绑定在哪个内核上。 |
| `jupyter_execute` | 在面板当前页的内核（或指定连接）里运行代码，返回 stdout、最后一个表达式、错误和已保存的图片/PDF 路径。这次运行会记录为一格 `模型` 单元格。 |
| `jupyter_notebook` | 读取、新增、修改、删除或运行面板笔记本里的一格。修改会留下可复核的 diff，而不是悄悄换掉你的代码。 |
| `jupyter_kernel` | 在某台服务器上列出、启动、重启、中断、关闭内核，或 attach 到已有内核。 |

内核按对话、也按服务器绑定，绑定关系镜像到 `$DSH_HOME/jupyterlab/kernels.json`；插件重载或
应用重启之后会重新接上，而不是悄悄起一个空内核。

## 笔记本面板

笔记本在**右侧边栏**里，就在对话旁边：

- **单元格**：新增、删除、在下方插入、上下移动、清空输出；代码与 markdown；按内核自己的语言上色。
- **就地编辑**：`Shift+Enter` 运行并退出，`Ctrl/Cmd+Enter` 原地运行，`Ctrl/Cmd+S` 保存，
  `Tab`/`Shift+Tab` 缩进，`Enter` 继承缩进，`Esc` 退出编辑；输入法组字期间按键交给输入法。
- **运行**：`运行` 在内核拿到代码时就返回，输出边产生边显示。`全部运行` 按顺序执行代码格，
  按钮会变成 `停止`。
- **富输出**：图片、`text/html`（净化后挂在 shadow root 里）、markdown、纯文本；长输出默认折叠。
- **可复核的改动**：模型改写某一格时会显示 `有改动` 与逐行 diff；`保留` 接受，`撤销` 恢复你的版本。
- **一个会话可以有多本笔记本**：最多十二本，各有自己的单元格、输出与导出；同一台服务器上的页
  共用一个内核。
- **一个会话可以有多台服务器**：头部选择器决定当前页跑在哪台，`连接…` 添加连接（名称、地址、
  密码/令牌/代理 Cookie）。每条连接都能 `编辑`（改名称、换凭据）或 `移除`；回环地址显示为
  `localhost`。
- **草稿能扛过刷新**：没提交的文字存在标签页的 `sessionStorage` 里。
- **可移植**：`导出` 下载当前页为 `.ipynb`，`导入` 载入一份。
- **实时**：模型跑的代码会作为 `模型` 格子出现；你编辑或运行的内容会在模型下一步作为上下文送达
  （头部徽标显示排队数量）。

## 安装

在这个仓库的检出目录里，于一个 DeepSeek Harness 会话中执行：

```
plugin_manager { action: "install_bundle", target: "<path to this repository>" }
```

插件包会装进当前 profile 并激活。**首次**安装需要重启一次应用；之后宿主的改动需要重启，浏览器
那一半的改动刷新页面即可。

## 配置

上手只需要 `url` 一个字段，其余都有默认值。

**让模型来配。** 插件在完全没有配置的情况下也会加载。说「连到 `http://jupyter.example.com:9002/lab`，
token 是 XYZ」，模型就会调用 `jupyter_connect`。运行时添加的连接记在
`$DSH_HOME/jupyterlab/servers.json`。

**或者用面板。** 笔记本头部的 `连接…` 打开连接列表和一个很短的表单：可选名称、地址、认证方式
（默认 `密码`，另有 `令牌`、`仅代理 Cookie`）以及凭据。

**或者写进 profile。** 在 `$DSH_PROFILE_DIR/cordis.patch.yml` 里给这个插件那一行加一个 `config:`
映射，它会覆盖插件包自带的 patch：

```yaml
- id: jupyterlab
  name: '@local/dsh-jupyterlab'
  config:
    name: 本地
    url: http://jupyter.example.com:9002/lab
    token: <your token>
    kernelName: python3
    # 可选：再预置一个连接，打开面板之前就能用。凭据属于它被输入时针对的那台主机，
    # 这里的 token 不会被发给另一台服务器。
    servers:
      - name: GPU 机器
        url: http://gpu-box.example.com:9003/lab
        password: <明文密码>
        kernelName: python3
```

### 凭据

Jupyter 接受 token 或密码，两种都支持：

- **token** —— `jupyter server list`、服务器控制台输出，或 JupyterLab 打开的 URL 里的 `?token=...`。
- **password** —— 你在 JupyterLab 登录页输入的明文密码。`jupyter_server_config.json` 里的密码
  **哈希**没法被重放，会被拒绝。
- **代理 Cookie** —— 见下一节，用于企业访问网关后面的部署。

凭据属于它被输入时针对的那台主机。运行时添加的连接存在 `$DSH_HOME/jupyterlab/servers.json`
（权限 `0600`，和 profile 配置一样是明文）；profile 里点名的服务器每次启动重新生效，不会复制
进这个文件。

### 在 SSO / 访问代理后面

有些部署会在 Jupyter 前面挡一层 SSO/访问代理，它对所有未认证路径——`/lab`、`/api/status`，
甚至 Jupyter 自己的 `/login`——都重定向到登录页，所以 token 和密码根本到不了 Jupyter。先在浏览器
里登录，再把浏览器的 Cookie 带过来：

1. 在浏览器里打开该地址并登录；
2. DevTools → **Network** → 该主机的任一请求 → **Request Headers** → 复制 `Cookie:` 的值；
3. 面板里 `连接…` → 地址 → 认证方式选 `仅代理 Cookie`（Jupyter 自己还要凭据时选 `密码`/`令牌`）
   → 把 Cookie 粘进 **代理 Cookie** → `连接`。

Cookie 会随 REST 调用和内核 WebSocket 升级一起发送，其中的 `_xsrf` 会成为 XSRF 头。它随连接
持久化，重启后仍然可用，直到网关会话过期；过期时用 `编辑` 换一个新的。

如果刚粘的 Cookie 仍然被重定向，说明网关不接受这种重放（有些会绑定设备或浏览器指纹）。这时请
改用可直连的地址，或向部署方申请服务 token。

### 选项

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `url` | — | JupyterLab 地址。`/lab`、`/tree`、结尾斜杠和 `?token=...` 都能识别。 |
| `name` | — | 面板里显示的名称，用来代替一长串地址；不参与连接的身份。 |
| `token` / `password` / `username` | — | 凭据；`token` 优先。 |
| `cookie` | — | SSO/访问代理用的 Cookie 头。 |
| `servers` | — | 额外连接：`{url, name?, token?, password?, cookie?, kernelName?, workingDirectory?}`。 |
| `kernelName` | `python3` | 新内核使用的 kernelspec。 |
| `workingDirectory` | 服务器根目录 | 内核启动时所在目录（相对服务器根）。 |
| `requestTimeoutMs` | `20000` | 一次 REST 调用的时间预算。 |
| `executeTimeoutMs` | `180000` | 一次执行的时间预算，超时则中断内核。 |
| `autoStartKernel` | `true` | 首次执行时自动启动内核。 |
| `maxOutputChars` | `20000` | 每次执行保留的流式输出字符数（头与尾）。 |
| `artifactDirectory` | `$DSH_HOME/jupyterlab/artifacts` | 图片/PDF 输出的写入位置。 |

## 注意

- **远端服务器必须能被 Harness 所在机器直接访问。** 插件里没有 SSH 隧道或端口转发：只监听另一台
  机器 `127.0.0.1` 的 Jupyter 没法通过那台机器的名字连上。DNS 名、可路由 IP 或网关都可以。
- **`.local` 地址每个进程要付一次慢解析。** macOS 上 mDNS 解析这种名字大约五秒，插件在挂载时付
  一次并缓存。用 `/etc/hosts` 别名可以连这一次也省掉——`scripts/alias-host.sh` 只是个便利脚本，
  不属于插件包本身。
- **`.ipynb` 的导入导出是有损的。** raw 格变成 markdown，面板画不出的输出类型被丢弃，过大的图片
  或标记会退化或被删；每一处损失都会报告。
- **凭据是明文文件。** `servers.json` 权限 `0600`，没有钥匙串集成。

## 文档

- **`docs/design.md`** —— 插件是怎么搭起来的、为什么这样搭：传输层、连接、内核生命周期、面板
  协议，以及这些看起来奇怪的取舍背后的原因。
- **`docs/performance-review.md`** —— 测量结果与仍然存在的优化空间。
- **`docs/dsh-client-plugin-contract.md`** —— 面板所依据的宿主/插件契约。

## 验证改动

```bash
npm test                  # 离线套件；设置了 JUPYTER_TEST_URL 时再加上 e2e 与 register
npm run test:offline      # transport、ipynb、notebook、activity、client
```

e2e 套件需要一台真实的 Jupyter。起一台一次性的，但**不要**削弱它的安全默认值（用
`disable_check_xsrf` 起的服务器会掩盖真实的认证缺陷）：

```bash
# Token 认证。
jupyter server --no-browser --port=9003 --IdentityProvider.token=<token> \
  --ServerApp.root_dir=/tmp/jupyter-test

# 密码认证。trait 是 `IdentityProvider.hashed_password`；写成裸的 `password` 选项会被静默忽略，
# 看起来和「密码错了」一模一样。
python -c "from jupyter_server.auth import passwd; print(passwd('<password>'))"
jupyter server --no-browser --port=9004 \
  --IdentityProvider.hashed_password='<hash from above>' --ServerApp.root_dir=/tmp/jupyter-test
```

然后：

```bash
JUPYTER_TEST_URL=http://127.0.0.1:9003/lab JUPYTER_TEST_TOKEN=<token> node test/e2e.mjs
JUPYTER_TEST_URL=http://127.0.0.1:9004/lab JUPYTER_TEST_PASSWORD=<password> node test/e2e.mjs
```

`test/register.mjs` 还需要把 `node_modules` 链接到 DeepSeek Harness 的包（开发期链接，永远不
属于安装后的插件）。

## 已知限制

- **这个面板是笔记本，不是 JupyterLab。** 没有补全、变量检查器或调试器；JupyterLab 发送
  `frame-ancestors 'self'`，所以也没法嵌进 Harness 的 UI。
- **可以同时开着好几本笔记本，但不能管理它们。** 不能改名、关闭或删除；导出写的是你正在看的那一页。
- **输出支持是选定的子集。** `application/json`、LaTeX 和任意 MIME 类型只显示占位；HTML 会被净化，
  依赖自身脚本的输出只渲染静态部分。
- **面板提示在下一步才到达。** 排队的提示是下一个模型请求的上下文，不是代替用户发出的消息。
- **只做代码执行。** Contents API（在服务器上读写笔记本文件）没有暴露。
- 对话结束时内核仍留着；用 `jupyter_kernel` 关掉。
