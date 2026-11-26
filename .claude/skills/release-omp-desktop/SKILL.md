---
name: release-omp-desktop
description: 发布 OMP Desktop 新版本（bump 四处版本、构建并核验自包含安装包与 AV 门禁、按上个稳定 tag 之后的提交生成更新日志、跑门禁、提交、打 tag vX.Y.Z、推送并核对 GitHub Release 与 latest.json）。用户说“发版 / 发布新版本 / 打 tag / 写更新日志”时使用。
---

# 发布 OMP Desktop 新版本

## 何时用

- 用户要求发版、发布新版本、打 `vX.Y.Z` tag、更新 GitHub Release 或写更新日志。
- 一次发布只对应一个版本、一个 tag；不混入未完成的功能开发。

## 何时不用

- 升级 SDK 但未要求发布：用 `upgrade-omp-sdk`。
- 只改代码、不发布：按 `rules.md` 的普通改动流程。
- 用户没有明确要求发版：不 bump、不打 tag、不 push。

## 边界

- 先读 `AGENTS.md`、`rules.md`（Release versions and publishing、Version axes、Artifact rebuild）。
- 语义化版本：`MAJOR` = 旧安装读不了的协议或存储变化，`MINOR` = 用户可见功能，`PATCH` = 修复；tag 只允许 `vX.Y.Z`，带 `-beta`/`-rc` 的 tag 会被发布流程拒绝。
- 更新日志（Release body）每次从上一个稳定 tag 到本次 tag 的提交生成，禁止沿用固定文案或复用旧日志。
- 已发布的 tag 不 force-push、不移动；同一版本不重发不同内容；回滚只能发更高版本，绝不把更新源指回旧版本。
- 签名私钥只在用户机器与 CI secret（`TAURI_SIGNING_PRIVATE_KEY`），不进仓库、日志或输出。
- 安装包必须自包含：应用、嵌入前端、完整 host bundle 全在包内；安装版用户不执行 checkout、toolchain、Bun/Node/npm 或任何构建命令。禁止 `externalBin` 编译 host；缺失、过期或协议不匹配的 host 是发布失败（`rules.md#updates-and-upgrades`、`src-tauri/build.rs`）。
- 安装包不提权、不开端口：`tauri.conf.json` 写明 `installMode: "currentUser"`，NSIS hooks 不写任何防火墙规则，`src-tauri/src/**`、`host/src/**`、`host/scripts/**` 不绑 `0.0.0.0`/`::`，每个 `Bun.serve` 自带 loopback `hostname`（`scripts/check-installer-surface.mjs`）。UAC、防火墙、杀软排除提示即发布失败，不让用户点“允许”。
- 只发布 bundle 布局（vendor-signed runtime + plain files），绝不打包 compiled self-extracting host。对产出的 NSIS 安装包跑 Windows Defender 扫描；检出即撤回该版本，不要求用户点“允许/忽略”。无 Authenticode 证书时在交付说明写明 SmartScreen 残留——这是唯一允许出现的提示，其余一律按失败处理。
- 发布核对以安装包内容为准，不只看 `latest.json`：包内必须有 `bundle/` 的 runtime、entry、addon 文件与 `manifest.json`，`protocol`/`sdkVersion` 与源码一致，且没有 `omp-host.exe`/`omp-host.json`。
- 不关闭安装版实例；需要重建时按 `AGENTS.md#instances` 只关对应 profile 的实例。

## 步骤

### 1. 定版本、确认基线

```bash
git status --porcelain          # 必须干净；有别人的改动就停
git describe --tags --abbrev=0 # 上一个稳定 tag
git log --oneline "$(git describe --tags --abbrev=0)..HEAD"
```

- 决定 `X.Y.Z`；确认要发布的提交都已在当前分支（默认 `main`），没有未合并的升级分支。没有上个 tag 时直接看全量日志。
- 起一条发布提交（如 `chore: release vX.Y.Z`），不与功能改动混在一起。

### 2. Bump 四处版本，并让锁文件跟上

四处必须同时等于 `X.Y.Z`：

| 位置 | 字段 |
|---|---|
| `package.json` | `version` |
| `src-tauri/tauri.conf.json` | `version` |
| `src-tauri/Cargo.toml` | 首个 `version = "…"` |
| `host/src/constants.ts` | `HOST_VERSION` |

```bash
pnpm host:install              # 重建 bundle，manifest 记下本次 HOST_VERSION/protocol/SDK
pnpm tauri:build --no-bundle   # 让 Cargo.lock 记录新版本；本会话先按 AGENTS.md 准备 MSVC 环境
```

- `src-tauri/Cargo.lock` 由构建写入，不手改；确认它把 workspace 包记成了 `X.Y.Z`。
- `src-tauri/binaries/bundle/manifest.json` 的 `hostVersion` 必须是 `X.Y.Z`，`protocol`、`sdkVersion` 与源码一致，`files[]` 全部通过 `pnpm host:install` 的 sha256 校验；任一不符不进入发布。
- 构建前只关占用 release profile 的实例；本会话祖先实例交给用户。

### 3. 生成更新日志

```bash
TAG=vX.Y.Z
PREV=$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' "${TAG}^")
git log --no-merges --pretty=format:'%s' "$PREV..$TAG"
```

- `$TAG` 还没创建时用 `HEAD` 代替 `${TAG}^` 和 `$TAG`（先确认 HEAD 就是要打的提交）；生成后核对 range 两端。
- 先剔除 `chore(…)?: release …` 发版提交和合并提交；同一句只列一次。
- 归组：`feat` → Features；`fix` / `revert` → Fixes；`perf` → Performance；`chore` / `refactor` / `docs` / `test` / `ci` / `build` → Other changes（SDK 升级、许可证、发布脚本等也在这里）。
- `type(scope): x` 渲染为 `**scope**: x`；提交信息本身就是面向用户的句子，照它写，不要合并出提交里没有的承诺，也不要漏掉用户可见的修复或行为变化。
- 正文用固定结构，尾注与 compare 链接保留：

```markdown
### Features
- …

### Fixes
- …

### Performance
- …

### Other changes
- …

Windows x64 installer. The application checks this release feed for updates.

**Full changelog**: https://github.com/Arctic07/omp-desktop/compare/<PREV>...<TAG>
```

- 没有上一个 tag（首个版本）写 `Initial release.`；范围内没有可展示提交写 `No user-visible changes.`。
- 语言跟随提交与仓库：默认英文；用户明确要中文才写中文。
- 存成仓库外的临时文件（如 `release-notes.md`）；它是 Release body，不提交。

### 4. 跑门禁

```bash
pnpm --filter src typecheck
pnpm --filter src lint
pnpm --filter src test
pnpm check:repo
git diff --check
```

- Rust 有改动：`cargo fmt --check`、`cargo check`、`cargo test --lib`（本会话用 MSVC wrapper）。
- `check:repo` 已含安装面包面检查（`scripts/check-installer-surface.mjs`）：`installMode` 非 `currentUser`、`externalBin`、NSIS 里的防火墙规则、非 loopback 绑定都会让它红。
- `host/src/**` 有改动：`cd host && bun test`、`bun run scripts/seam-check.ts`；`host/dist/bundle/` 与 `src-tauri/binaries/bundle/` 两份一致性按 `rules.md#artifact-rebuild` 核对。
- `check:repo` 因许可证清单变化报 notices：`pnpm notices:generate` 后重跑。
- 本次同时含 SDK 升级：按 `upgrade-omp-sdk` 的全套门禁与旧数据验证跑。
- 改了前端：`pnpm --filter src build`；发布 workflow 会重建，但本地门禁必须先绿。

### 5. 提交、打 tag、推送

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock host/src/constants.ts
git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z
git push origin main            # 或用户指定的分支
git push origin vX.Y.Z
```

- 只暂存发布相关文件；不带入无关改动，更新日志文件不提交。
- 只在用户明确要求发布后推送 tag；tag 是发布决定。
- 推送前再核对：tag 与四处版本一致、`Cargo.lock` 已提交、工作区干净。

### 6. Release body 由 workflow 生成

- 仓库 `.github/workflows/release.yml` 已用 `fetch-depth: 0` 和 `node scripts/release-notes.mjs --tag "$GITHUB_REF_NAME"` 生成正文，并通过 `releaseBody` 传给 `tauri-action`；不要改回固定文案，也不要把旧日志手工塞进 workflow。
- 发布后打开 Releases 页，确认 body 与第 3 步一致、compare 链接以本次 `vX.Y.Z` 结尾。

### 7. 发布后核对

```bash
gh release view vX.Y.Z --json body,assets,isLatest
curl -sL https://github.com/Arctic07/omp-desktop/releases/latest/download/latest.json
```

- 资产齐全：NSIS `.exe`、`.exe.sig`、`latest.json`、源码包；`latest.json.version` = `X.Y.Z`，且严格大于上一版。
- **安装包内容与 AV 门禁（发布后立即做）**：下载 release 的 NSIS `.exe` 到 `$TEMP`，先跑 Windows Defender：
  ```bash
  powershell -NoProfile -Command 'Start-MpScan -ScanType CustomScan -ScanPath (Join-Path $env:TEMP "omp-setup.exe")'
  ```
  检出即按失败判据撤回该版本（删 release / 停止推广），不改文案让用户放行。随后用 `7z x` 解包到临时目录，核对 `bundle/` 的 runtime、entry、addon、`manifest.json` 全部 `sha256`/`bytes` 与 manifest 一致，`protocol`/`sdkVersion` 与源码一致，`bun.exe` Authenticode 有效，且没有 `omp-host.exe`/`omp-host.json`。
- 安装版 15 秒后或 6 小时内检查更新，标题栏 / 关于页出现新版本；安装始终由用户按下。
- workflow 失败：修因后重跑；已经发布错误内容：发更高版本，不回指 feed。

## 失败判据（遇到就停，不绕过）

- 四处版本任一不一致 → 不 tag。
- `Cargo.lock` 未记录新版本 → 重新构建后提交，不手改。
- 更新日志与提交 range 不符、或沿用旧文案 → 重做。
- tag 带预发布后缀、或 tag 与版本不一致 → 发布流程会拒绝；改版本，不绕。
- 签名失败、`latest.json` 不更新 → 停下报告 secret 与公钥问题，不重发同版本。
- 安装包缺 `bundle/`、出现 `omp-host.exe`/`omp-host.json`、manifest 的版本/协议/SDK 不符，或 Defender 检出 → 撤回该版本、停止推广，修因后发更高版本。
- 安装版用户需要运行任何构建命令，或被要求允许/忽略杀软、SmartScreen、防火墙 → 发布失败，改安装包与文案，不改用户步骤。
