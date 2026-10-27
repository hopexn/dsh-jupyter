# 面向 DeepSeek Harness 的 JupyterLab

[English](README.md) · 简体中文

把 DeepSeek Harness 接到一台或多台 Jupyter 服务器上。模型在**常驻的远端内核**里运行代码：
变量、导入和工作目录在多次工具调用之间都还活着。右侧边栏还有一本笔记本，每一页都运行在它绑定
的那台服务器上。

本地不需要装任何东西：插件直接用 Jupyter Server 的 REST API 和内核协议通信，不需要 Python，也
没有额外依赖。

## 安装

在这个仓库的检出目录里，于一个 DeepSeek Harness 会话中执行：

```
plugin_manager { action: "install_bundle", target: "<path to this repository>" }
```

插件包装进当前 profile 并激活。**首次**安装需要重启一次应用；之后面板的改动刷新页面即可。

## 配置

只需要 `url` 一个字段，其余都有默认值。下面三种方式任选一种。

**1. 让模型来配。** 说「连到 `http://jupyter.example.com:9002/lab`，token 是 XYZ」，模型会调用
`jupyter_connect`。运行时添加的连接会跨重启保留。

**2. 用面板。** 笔记本头部的 `连接…` 打开一个很短的表单：

- **名称**（可选）——选择器里显示它，而不是一长串地址；
- **服务器地址**——JupyterLab 的地址；
- **认证方式**——默认 `密码`，另有 `令牌`，以及 SSO 网关用的 `仅代理 Cookie`；
- **凭据**——密码、token，或浏览器 Cookie。

列表里的每条连接都可以 `编辑`（改名称或换凭据，**留空表示保持已存的值**）或 `移除`。回环地址
显示为 `localhost`。

**3. 写进 profile。** 在 `$DSH_PROFILE_DIR/cordis.patch.yml` 里给这个插件那一行加一个 `config:`
映射：

```yaml
- id: jupyterlab
  name: '@local/dsh-jupyterlab'
  config:
    name: 本地
    url: http://jupyter.example.com:9002/lab
    token: <your token>
    kernelName: python3
    # 可选：更多连接。凭据属于它被输入时针对的那台主机。
    servers:
      - name: GPU 机器
        url: http://gpu-box.example.com:9003/lab
        password: <明文密码>
```

### 凭据

Jupyter 接受 token 或密码，两种都支持：

- **token** —— `jupyter server list`、服务器控制台输出，或 JupyterLab 打开的 URL 里的 `?token=...`。
- **password** —— 你在 JupyterLab 登录页输入的明文密码。`jupyter_server_config.json` 里的密码
  **哈希**没法被重放，会被拒绝。
- **代理 Cookie** —— 见下一节，用于企业访问网关后面的部署。

凭据属于它被输入时针对的那台主机。运行时添加的连接存在 `$DSH_HOME/jupyterlab/servers.json`
（权限 `0600`，和 profile 配置一样是明文）。

### 在 SSO / 访问代理后面

有些部署会在 Jupyter 前面挡一层 SSO/访问代理，它对所有未认证路径——`/lab`、`/api/status`，
甚至 Jupyter 自己的 `/login`——都重定向到登录页，token 和密码根本到不了 Jupyter。先在浏览器里
登录，再把 Cookie 带过来：

1. 浏览器打开该地址并登录；
2. DevTools → **Network** → 该主机的任一请求 → **Request Headers** → 复制 `Cookie:` 的值；
3. 面板里 `连接…` → 地址 → 认证方式选 `仅代理 Cookie`（Jupyter 自己还要凭据时选 `密码`/`令牌`）
   → 粘进 **代理 Cookie** → `连接`。

Cookie 随连接持久化，重启后仍可用，直到网关会话过期；过期时用 `编辑` 换一个新的。如果刚粘的
Cookie 仍然被重定向，说明网关不接受这种重放——请改用可直连的地址，或向部署方申请服务 token。

### 选项

| 选项 | 默认值 | 含义 |
| --- | --- | --- |
| `url` | — | JupyterLab 地址。`/lab`、`/tree`、结尾斜杠和 `?token=...` 都能识别。 |
| `name` | — | 面板里显示的名称，用来代替地址。 |
| `token` / `password` / `username` | — | 凭据；`token` 优先。 |
| `cookie` | — | SSO/访问代理用的 Cookie 头。 |
| `servers` | — | 额外连接：`{url, name?, token?, password?, cookie?, kernelName?, workingDirectory?}`。 |
| `kernelName` | `python3` | 新内核使用的 kernelspec。 |
| `workingDirectory` | 服务器根目录 | 内核启动时所在目录（相对服务器根）。 |
| `requestTimeoutMs` | `20000` | 一次 REST 调用的时间预算。 |
| `executeTimeoutMs` | `180000` | 一次执行的时间预算，超时则中断内核。 |
| `autoStartKernel` | `true` | 首次执行时自动启动内核。 |
| `maxOutputChars` | `20000` | 每次执行保留的流式输出字符数。 |
| `artifactDirectory` | `$DSH_HOME/jupyterlab/artifacts` | 图片/PDF 输出的写入位置。 |

## 你能得到什么

模型有五个工具：

| 工具 | 作用 |
| --- | --- |
| `jupyter_connect` | 添加一条连接并验证凭据；已连接的服务器保持连接。 |
| `jupyter_status` | 已连接的服务器、它们的内核，以及这段对话正在用哪个内核。 |
| `jupyter_execute` | 在面板当前页的内核里运行代码；返回输出、错误和已保存的图片/PDF 路径。运行会显示为一格 `模型` 单元格。 |
| `jupyter_notebook` | 读取、新增、修改、删除或运行面板笔记本里的一格；修改会留下可复核的 diff。 |
| `jupyter_kernel` | 列出、启动、重启、中断、关闭内核，或 attach 到已有内核。 |

笔记本面板：

- **单元格**——新增、删除、在下方插入、上下移动、清空输出；代码与 markdown；按内核自己的语言上色。
- **编辑**——`Shift+Enter` 运行并退出，`Ctrl/Cmd+Enter` 原地运行，`Ctrl/Cmd+S` 保存，
  `Tab`/`Shift+Tab` 缩进，`Esc` 退出；输入法组字期间按键交给输入法。
- **运行**——`运行` 立即返回，输出边产生边显示。`全部运行` 按顺序执行代码格，按钮变成 `停止`。
- **输出**——图片、`text/html`（净化后渲染）、markdown、纯文本；长输出默认折叠。
- **模型改动**——被改写的格子显示 `有改动` 与逐行 diff；`保留` 接受，`撤销` 恢复你的版本。
- **一个会话多本笔记本**（最多十二本）与**多台服务器**——选择器切换当前页的服务器；回环地址显示
  为 `localhost`。
- **草稿**——没提交的文字能扛过一次页面刷新。
- **导入 / 导出**——`.ipynb` 进出。
- **实时**——模型跑出来的内容显示为 `模型` 格子；你编辑或运行的内容会在模型下一步作为上下文送达。

## 已知限制

- **面板是笔记本，不是 JupyterLab。** 没有补全、变量检查器或调试器。
- **可以同时开着好几本笔记本，但不能管理。** 不能改名、关闭或删除。
- **输出支持是子集。** `application/json`、LaTeX 和任意 MIME 类型只显示占位；HTML 会被净化，
  依赖自身脚本的交互控件只渲染静态部分。
- **远端服务器必须能被 Harness 所在机器直接访问。** 没有 SSH 隧道或端口转发：只监听另一台机器
  `127.0.0.1` 的 Jupyter 没法通过它的名字连上。
- **`.ipynb` 导入导出是有损的。** 每一处丢弃都会报告。
- **凭据是明文文件**（`servers.json`，权限 `0600`），没有钥匙串集成。
- **面板提示在下一步才到达**——它是下一个请求的上下文，不是聊天消息。
- 对话结束时内核仍留着；用 `jupyter_kernel` 关掉。

## 给开发者

设计说明、仓库结构、开发约束和验证命令都在 [`AGENTS.md`](AGENTS.md) 和
[`docs/design.md`](docs/design.md)。README 有意只面向用户。
