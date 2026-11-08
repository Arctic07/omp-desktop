# Omp-Desktop
Omp-Desktop

## 数据落点与卸载

Omp-Desktop 只在**一个数据根目录**下写数据。宿主进程启动时把 `HOME` / `USERPROFILE`、`XDG_DATA_HOME`、`OMP_DESKTOP_CODING_AGENT_DIR`（本应用对引擎数据目录的变量名，本应用定义的变量一律以 `OMP_DESKTOP_` 开头；引擎自身只读 `PI_CODING_AGENT_DIR`，宿主把两者钉为同一个值）、`PI_CONFIG_DIR`、`OMP_WORKTREE_DIR` 全部 pin 到这个数据根，并逐个断言实际落点位于数据根内，越界即拒绝启动；因此引擎不会把数据写进真实的用户主目录（`C:\Users\<用户名>`）。数据根由操作系统按应用数据目录约定给出，Windows 上是 `%LOCALAPPDATA%\com.omp.desktop`；设置页「模型 → 引擎」卡片显示运行时的实际落点。

| 路径（相对数据根） | 内容 |
| --- | --- |
| `app.sqlite` | 应用自有状态（工作区列表、宿主偏好） |
| `logs/` | 应用日志 `app.log`（单轮超 4 MiB 时下次启动轮转为 `app.log.1`）与宿主进程日志 `host.log`（超 16 MiB 轮转为 `host.log.1`）。按修改时间保留 **7 天**（`services/log_retention.rs` 的 `LOG_RETENTION_DAYS`），启动时清一次、运行中每 6 小时再清一次；本轮正在写的 `app.log` / `host.log` 永不删除 |
| `EBWebView/` | WebView2 的用户数据目录（页面运行时的配置、Local Storage 与缓存都在这里）。设置页「日志 → 清除缓存」只清其中纯缓存子目录（`Default/Cache`、`Default/Code Cache`、`Default/GPUCache`、各 shader 缓存等），不动 `Default/Local Storage`、`Default/Network` 与 `Default/Cookies` |
| `scratch/` | 无路径附件的临时副本：只发生在**粘贴**（Chromium 对粘贴的 File 不给路径；Windows 剪贴板的文件清单若同名同长会改按原路径引用）。从系统**拖入**的文件走宿主原生拖拽通道，一律按原路径引用，不复制。副本上限 256 MiB / 2000 个，超过 30 天或超限时按最旧回收 |
| `workspace/` | 会话未指定工作目录时使用的默认工作区 |
| `home/` | 被 pin 的 `HOME` / `USERPROFILE`，引擎侧的 home 落点全部在此 |
| `home/omp-desktop/` | 引擎配置根（`PI_CONFIG_DIR`）：`gpu_cache.json` 与 `logs/`（引擎自己的日志，每次宿主进程一个 `omp.<日期>.<进程号>.log`）。同一个 7 天规则约束它，另外只保留最新 20 个文件；写这些文件的进程仍在运行时，它的文件不会被删 |
| `home/.omp/natives/` | 原生 addon 的解压缓存（引擎回退到 home 时使用） |
| `home/.bun/` | Bun 包缓存（`home/.bun/install/cache`） |
| `host/` | 宿主进程独占的子树 |
| `host/agent/` | 引擎数据目录（`OMP_DESKTOP_CODING_AGENT_DIR`）：引擎数据库（`agent.db`、`history.db`、`models.db`）与导入的会话文件 |
| `host/sessions/` | 会话记录，每会话一个 `*.jsonl` |
| `host/xdg/omp/` | 引擎的 `XDG_DATA_HOME`；`host/xdg/omp/natives` 是原生 addon 的主要解压落点 |
| `host/worktrees/` | `OMP_WORKTREE_DIR`，引擎的 worktree 基线 |

设置页「日志」分区是这些落点的出口：把 `logs/` 与引擎日志目录的文件列成一张表（名称 / 大小 / 时间，并标注是「应用」还是「引擎」写的）、复制两个目录的路径、在文件管理器中分别打开、清除日志（两个目录里的日志文件都删；`app.log` 清空后本轮继续记录，正在运行的宿主保留自己的文件）、清除缓存（只清 `EBWebView` 的纯缓存子目录）。`scratch/` 不参与「清除缓存」：那里的副本是用户粘贴的**唯一**一份（prompt 只带路径，引擎在执行轮次时才读文件），清掉会打断尚未发送的附件；它由启动时的回收按容量与 30 天年龄自行收敛。页面自身的失败也会经 `logs_write` 记进 `app.log`：未捕获异常、未处理的 Promise 拒绝，以及 React 渲染边界接住的渲染失败（带组件栈）。同一条文本每轮只写一次，最多 40 条，之后写一行说明并停止——因此一个死循环里的报错不会把本轮日志的预算花光。

API 密钥不在数据根内：它们存放在操作系统的凭据存储中（Windows：凭据管理器），服务名为 `com.omp.desktop`，每个已配置的供应商一条，条目名以 `provider:` 开头。引擎启动时由宿主从凭据存储读出、以环境变量注入，不写入磁盘、日志或进程参数。

### 卸载

1. 退出应用。
2. 删除数据根目录（Windows：`%LOCALAPPDATA%\com.omp.desktop`）。引擎数据、会话记录、日志、原生 addon 缓存与 Bun 缓存都在其中，没有其他落点。
3. 在操作系统的凭据存储中删除服务名 `com.omp.desktop` 下的条目（Windows：凭据管理器中搜索 `com.omp.desktop`），否则 API 密钥会残留。

## 上游 SDK 版本检查

`bun run check:upstream`（`scripts/check-upstream.mjs`）读取 `host/package.json` 里 `@oh-my-pi/pi-coding-agent` 的锁定版本，向 npm registry 取一次 `latest`，打印一行 `upstream <v> / local <v> (<status>)`；只读文件 + 一次 GET，无副作用。

退出码：`0` 已最新；`10` 上游有新版本（CI 据此开升级任务）；`1` 读取或网络失败、或版本无法比较（如上游是 `18.7.0-beta.1` 这类预发布），原因打印在 stderr，不静默。

挂定时：crontab 每小时 `0 * * * * cd <repo> && bun run check:upstream`；Windows 计划任务每小时触发、程序 `bun.exe`、参数 `run check:upstream`、起始目录为仓库根；CI（Gitee Go / GitHub Actions 等）用 cron 触发同一命令，按 0 / 10 / 1 三个退出码分支。本检查就是 §13.4「SDK 升级必须是有意为之」的落地：锁定版本只能被主动改，不能靠偶然发现。
