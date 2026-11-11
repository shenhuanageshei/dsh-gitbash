# 安装 / 卸载（v2：并行 bash 工具；本流程是唯一权威源）

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
```

`bashPath` 换成你机器上 Git for Windows 的 `bin\bash.exe`；留空则走候选链（环境变量 / 常见安装目录 / PATH，见 `lib/resolve.js`）。

**语法要点（v1/v2 都栽过）**：顶层 `- id: X` 是「按 id 覆盖**既有**行」，
对不存在的 id 是**静默空操作**；新增行必须放进 `- insert:` 列表，缩进为 4 空格再写 `- id:`。

要点：**不要**停用 `pwsh-sandbox` / `tool-pwsh`（预设依赖它们）；本插件不注册 `ctx.shell`，
所以与其他行没有竞争关系。

### 4. 重启 DSH，然后验收

| 检查 | 操作 | 通过判据 |
|---|---|---|
| A2 工具出现 | 看工具表 | 有 `bash`，且 `pwsh` 仍在 |
| A3 真实执行 | bash 工具跑 `uname -s` | `MINGW64_NT-...` |
| A4 无副本 | 调用前后数 `$env:TEMP\dsh-*`、看 TEMP 盘可用空间 | 数量不增、差值 < 50 MB |

机械验收（A1-A4，两阶段，见脚本头注释）：

```powershell
pwsh -File tools\acceptance.ps1 -Phase before
# 让 agent 用 bash 工具跑一条命令
pwsh -File tools\acceptance.ps1 -Phase after
```

离线测试（不需要重启）：

```powershell
cd <path-to-this-repo>
node --test
```

## 回滚

从 `cordis.patch.yml` 删掉 `- insert:` 起的**整个块（5 行：insert / id / name / config / bashPath）**，重启。其他任何行都不需要动。

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 重启后没有 `bash` 工具 | insert 未解析（包名/路径） | 看宿主控制台 insert 报错；确认 `node_modules\dsh-gitbash` 可解析 |
| 调用返回 `GITBASH_UNAVAILABLE` | `bashPath` 不存在/不可执行 | 改成正确的 `bin\bash.exe`（不会回退 PATH） |
| 调用返回 `EXECUTOR_UNAVAILABLE` | 宿主 subprocess 服务不可用 | 这是宿主问题，不是配置问题 |
| 命令卡住到超时 | 前台同步执行，没有后台作业 | 把长任务拆短或用 `start`/`&` 自行脱离（注意：脱离的进程不受管） |
