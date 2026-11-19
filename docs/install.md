# 安装 / 卸载（v2.1：并行 bash 工具 + 宿主沙箱；现行版本 0.2.2；本流程是唯一权威源）

> 只加**一行** insert，不动任何既有行，所以不会影响 pwsh。insert 行仍需**重启**才挂载。

## 安装（4 步）

### 1. 备份 profile 的 patch 文件

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\cordis.patch.yml" "$p\cordis.patch.yml.bak-gitbash-v2" -Force
```

### 2. 把本仓库加入 profile 依赖

在 profile 的 `package.json` 里加一行（`link:` 后面换成你克隆本仓库的绝对路径）：

```json
"dsh-gitbash": "link:<path-to-this-repo>"
```

然后安装：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
pnpm install --no-frozen-lockfile
```

### 3. 在 profile 的 `cordis.patch.yml` 末尾加一条 insert 块

```yaml
- insert:
    - id: gitbash
      name: 'dsh-gitbash'
      config:
        bashPath: 'C:\Program Files\Git\bin\bash.exe'
        unconfinedWhenSandboxMissing: false
```

`bashPath` 换成你机器上 Git for Windows 的 `bin\bash.exe`；留空则走候选链（环境变量 / 常见安装目录 / PATH，见 `lib/resolve.js`）。

`unconfinedWhenSandboxMissing`（默认 `false`）只服务于**没有沙箱策略服务**的 profile：置 `true` 时退回 v0.1.0 的不受限执行
（**会绕过宿主策略**）。沙箱 provider 缺失或策略非法时该开关不生效，仍拒绝执行。

**语法要点（v1/v2 都栽过）**：顶层 `- id: X` 是「按 id 覆盖**既有**行」，
对不存在的 id 是**静默空操作**；新增行必须放进 `- insert:` 列表，缩进为 4 空格再写 `- id:`。

要点：**不要**停用 `pwsh-sandbox` / `tool-pwsh`（预设依赖它们）；本插件不注册 `ctx.shell`，
所以与其他行没有竞争关系。

#### 沙箱行为（v0.2.0）

- 每次调用先解析宿主策略；`danger-full-access` 不调用沙箱，行为与 v0.1.0 完全一致。
- `workspace-write`：写工作区外被拒；`read-only`：所有写被拒；**读不受限**（Windows 后端只限制写）。
- 被拒输出 `[sandbox: file access denied under <mode> mode]`（策略拒绝，不要换路径重试）；
  沙箱 runner 自身故障输出 `[sandbox: the sandbox runner itself failed under <mode> mode — the command did not run; ...]`。
- 策略解析失败 / policy 非法 / 沙箱 provider 缺失：**拒绝执行**并返回 `SANDBOX_UNAVAILABLE: …` 文案，不会静默不受限跑。
- **额外可写目录（0.2.2-rc.5 起）**：会话配置的 `additionalWritableRoots` 对**进程沙箱不生效**（只对文件工具生效）；
  `confine` 不再抛 `SANDBOX_UNSUPPORTED_POLICY`，写这些目录会被 ACL 拒（与官方 bash 一致）。
- **准备阶段失败（0.2.2-rc.5 起）**：ACL / 私有临时目录准备失败返回 `SANDBOX_PREPARATION_FAILED: …`，
  TEMP 落在工作区内返回 `SANDBOX_INVALID_TEMP_ROOT: …`；两者都在 spawn 之前返回，**命令没有运行**。
- **Windows 受限模式无法启动 Git Bash（2026-11-19 rc.5 实测）**：受限令牌下 MSYS 需要 `\BaseNamedObjects`
  被拒（`0xC0000022` / 退出码 `3221225794`），命令不会运行；受限会话请用官方 `pwsh` 或切 `danger-full-access`。
  0.2.2 起该失败返回 `SANDBOX_UNAVAILABLE: Git Bash cannot start under the Windows restricted-token sandbox … The command did not run.`（命令未运行，不渲染原始退出码）。
- `load-ok.txt` 里的 `sandboxServicesAtApply=present|missing` 是 **apply 时点**读数（服务按可用性激活），**不代表**运行期缺服务；
  运行期 `execute()` 每次重新读取，缺服务时按上文 fail closed。

### 4. 重启 DSH，然后验收

| 检查 | 操作 | 通过判据 |
|---|---|---|
| A2 工具出现 | 看工具表 | 有 `bash`，且 `pwsh` 仍在 |
| A3 真实执行 | bash 工具跑 `uname -s` | `MINGW64_NT-...` |
| A4 无副本 | 调用前后数 `$env:TEMP\dsh-*`、看 TEMP 盘可用空间 | 数量不增、差值 < 50 MB |
| B1–B6 沙箱 | 见 `docs/v0.2-design.md` 的 B1–B6 | **rc.5 实测：仅 B5 通过**；B1/B2/B3/B6 因受限令牌无法启动 MSYS 而阻塞；B4 受限模式不可测、`danger-full-access` 补测 PASS |

编号映射：**A 系** = 装载 / 功能检查，但两处含义不同——`tools/acceptance.ps1` 内 A1=语法、A2=load 标记、A3=临时目录增量、A4=磁盘差值；`docs/design.md`「防偏离」A0–A6 是另一套（A1=功能测试 28 例等）。**B 系** = v0.2.0 真机沙箱验收（B1–B6，判据见 `docs/v0.2-design.md`）。执行时以各自表格为准。

> **2026-11-19 rc.5 实测**：B5 通过；B1/B2/B3/B6 因受限令牌无法启动 MSYS 而阻塞（`exit 3221225794`，无 denial 标记）；B4 受限模式不可测、`danger-full-access` 补测 PASS。**受限会话请用 `pwsh`，或把会话切到 `danger-full-access`。**

机械验收（A1-A4，两阶段，见脚本头注释）：

```powershell
pwsh -File tools\acceptance.ps1 -Phase before
# 让 agent 用 bash 工具跑一条命令
pwsh -File tools\acceptance.ps1 -Phase after
```

> 注意：`node --test` 会通过 `apply()` 刷新 `load-ok.txt`（T13 用例）。因此 **A2 装载检查要在重启后、跑离线测试之前执行**。
>
> **A2 加固（0.2.2 起）**：A2 除 `tool=bash` 外还断言
> ① `bashPath=` 字段存在，且（期望值已知且非空时）其值非空并等于期望值（优先 `-ExpectedBashPath`，否则读 profile 的 `cordis.patch.yml` 里的 gitbash 行；
> 文件读不到或无 gitbash 行则只要求字段存在并提示；配置 `bashPath` 为空即候选链模式时同样只要求 `bashPath=` 字段存在并提示，不再要求非空）；
> ② `loaded=` 落在 [最老 `DeepSeek Harness` 进程 StartTime, +10min]（多进程取最老；找不到进程报 FAIL，不静默 PASS）。
> ③ 双开 DSH 时 A2 可能误红（「最老进程」可能来自旧实例）；**关掉旧实例后复跑**即可确认。
> 先跑 `node --test` 会让标记变成 `bashPath=…node.exe`；**配置了非空 `bashPath` 时 A2 必然失败**（路径不一致）；候选链 / 期望值未知时由 ② 的时间窗兜底（宿主启动超过 10 分钟后才红）。

离线测试（不需要重启）：

```powershell
cd <path-to-this-repo>
node --test
```

## 回滚

从 `cordis.patch.yml` 删掉 `- insert:` 起的**整个块（6 行：insert / id / name / config / bashPath / unconfinedWhenSandboxMissing）**，重启。其他任何行都不需要动。

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 重启后没有 `bash` 工具 | insert 未解析（包名/路径） | 看宿主控制台 insert 报错；确认 `node_modules\dsh-gitbash` 可解析 |
| 调用返回 `GITBASH_UNAVAILABLE` | `bashPath` 不存在/不可执行 | 改成正确的 `bin\bash.exe`（不会回退 PATH） |
| 调用返回 `EXECUTOR_UNAVAILABLE` | 宿主 subprocess 服务不可用 | 这是宿主问题，不是配置问题 |
| 调用返回 `SANDBOX_UNAVAILABLE: the sandbox policy service is not composed…` | profile 没有 `sandboxPolicy` 服务 | 这是安全默认；确认宿主装配，或在明确接受「绕过宿主策略」的前提下设 `unconfinedWhenSandboxMissing: true` |
| 调用返回 `SANDBOX_UNAVAILABLE: sandbox provider service is not composed` | 有策略服务但沙箱 provider 缺失 | 宿主装配问题；本工具不会降级执行 |
| 输出 `[sandbox: file access denied under <mode> mode]` | 策略拒绝（写越界） | 预期结果：改到允许的路径或让用户调整策略；**不要**换工具绕过 |
| 输出 `[sandbox: the sandbox runner itself failed …]` | 沙箱 runner 自身故障，命令没有运行 | 沙箱环境问题（不是命令问题）；按提示排查 runner，不要当命令失败重试 |
| 调用返回 `SANDBOX_UNAVAILABLE: Git Bash cannot start under the Windows restricted-token sandbox …` | 受限模式（`workspace-write` / `read-only`）下 MSYS 无法创建 `\BaseNamedObjects`（退出码 3221225794），bash 在命令执行前退出 | 这是宿主令牌与 MSYS 的边界，不是 `bashPath` 配置问题；受限会话请用官方 `pwsh`，或把会话切到 `danger-full-access` |
| 调用返回 `SANDBOX_PREPARATION_FAILED: …` | 沙箱准备失败（ACL 授权 / 私有临时目录准备失败），命令未运行 | 沙箱环境问题（不是命令问题）；按提示排查 ACL / 临时目录，不要当命令失败重试 |
| 调用返回 `SANDBOX_INVALID_TEMP_ROOT: …` | `TEMP` 落在工作区内，宿主拒绝准备沙箱，命令未运行 | 把 `TEMP` / `TMP` 指到工作区外（例如用户临时目录）后重试 |
| 命令卡住到超时 | 前台同步执行，没有后台作业 | 把长任务拆短或用 `start`/`&` 自行脱离（注意：脱离的进程不受管） |
