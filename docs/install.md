# 安装 / 卸载（v2.1：并行 bash 工具 + 宿主沙箱；本流程是唯一权威源）

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

### 4. 重启 DSH，然后验收

| 检查 | 操作 | 通过判据 |
|---|---|---|
| A2 工具出现 | 看工具表 | 有 `bash`，且 `pwsh` 仍在 |
| A3 真实执行 | bash 工具跑 `uname -s` | `MINGW64_NT-...` |
| A4 无副本 | 调用前后数 `$env:TEMP\dsh-*`、看 TEMP 盘可用空间 | 数量不增、差值 < 50 MB |
| B1–B6 沙箱 | 见 `docs/v0.2-design.md` 的 B1–B6 | 需临时把会话切到 `workspace-write` / `read-only`；当前 `danger-full-access` 会话无法覆盖 |

编号映射：**A 系** = 装载 / 功能检查，但两处含义不同——`tools/acceptance.ps1` 内 A1=语法、A2=load 标记、A3=临时目录增量、A4=磁盘差值；`docs/design.md`「防偏离」A0–A6 是另一套（A1=功能测试 23 例等）。**B 系** = v0.2.0 真机沙箱验收（B1–B6，判据见 `docs/v0.2-design.md`）。执行时以各自表格为准。

机械验收（A1-A4，两阶段，见脚本头注释）：

```powershell
pwsh -File tools\acceptance.ps1 -Phase before
# 让 agent 用 bash 工具跑一条命令
pwsh -File tools\acceptance.ps1 -Phase after
```

> 注意：`node --test` 会通过 `apply()` 刷新 `load-ok.txt`（T13 用例）。因此 **A2 装载检查要在重启后、跑离线测试之前执行**；先跑测试会让 A2 在未重启的情况下误绿。

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
| 命令卡住到超时 | 前台同步执行，没有后台作业 | 把长任务拆短或用 `start`/`&` 自行脱离（注意：脱离的进程不受管） |
