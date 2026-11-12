# dsh-gitbash

给 DeepSeek Harness（dsh）用的**并行 Bash 工具**：直接 spawn 你本机的 Git for Windows `bash.exe`。

- **不拷贝、不解包**：每次调用只拉起一个 `bash.exe` 进程。
- **不碰 `ctx.shell`**：与 pwsh 共存，最坏情况只是本工具不出现，不会影响现有 shell。
- **沙箱优先（v0.2.0）**：每次调用先解析宿主的 `sandboxPolicy`；非 `danger-full-access` 时把 argv 交给 `ctx.sandbox.confine()` 再 spawn。沙箱不可用时**拒绝执行**，不静默降级。
- 输出语义对齐官方 shell 工具：stdout → `[stderr]` 段 → 沙箱标记 → `[timed out]` / `[error: ...]` / `[signal: ...]` / `[exit code: N]`。

> **沙箱边界（如实说明）**：Windows 后端（`windows-acl`）的 enforcement 是 `partial` —— 它**只限制写**，
> 不限制读、网络、进程可见性（宿主 `dsh-sandbox-local` 源码注释原文如此）。`workspace-write` 下写工作区外会被拒；
> `read-only` 下所有写会被拒；`danger-full-access` 下与 v0.1.0 完全一致（不调用沙箱）。被拒时输出
> `[sandbox: file access denied under <mode> mode]`，这是策略拒绝，**不要换路径重试**；
> 沙箱 runner 自身故障则输出 `[sandbox: the sandbox runner itself failed under <mode> mode — the command did not run; ...]`。

## 为什么不是「替换执行器」

`ctx.shell` 只有一个实现；Windows 的内置预设又要求它是 pwsh（停用 `pwsh-sandbox` 会让预设装配失败、
会话不可用）。所以「替换」这条路在本机不成立——v1 就是这么失败的，详见 `docs/design.md` 的 v1 事故记录。

## 配置

patch 行的 `config` 直接传给插件（无 schema 校验）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `bashPath` | `''`（走候选链） | Git for Windows 的 `bin\bash.exe` 绝对路径 |
| `timeoutMs` | 120000 | 默认超时 |
| `maxTimeoutMs` | 600000 | 单次调用超时上限 |
| `maxOutputBytes` | 64000 | 每路流内存保留上限（超出由宿主 spill） |
| `maxSpillBytes` | 67108864 | spill 文件上限 |
| `graceMs` | 3000 | 终止宽限 |
| `unconfinedWhenSandboxMissing` | `false` | 只用于**没有**沙箱策略服务的 profile：置 `true` 才退回 v0.1.0 的不受限执行（**会绕过宿主策略**）。沙箱 provider 缺失或 policy 非法时该开关不生效，仍拒绝执行 |

> 要的是 `bin\bash.exe`，**不是** `git-bash.exe`（后者是打开终端窗口的启动器）。

候选链（`bashPath` 留空时，见 `lib/resolve.js`）：`DSH_GITBASH_PATH` →
`DSH_GITBASH_ROOT` / `GIT_INSTALL_ROOT` → 常见 Git 安装目录（`%ProgramFiles%` 等）→ `PATH`。

## 测试

```powershell
node --test           # 路径解析 + 功能 + 沙箱用例；用例清单与判据见 docs/design.md 的「防偏离」A0/A1
```

功能与沙箱用例不需要真实 DSH 进程（spawn 与沙箱服务都是注入的，fake 用例用 `process.execPath` 当作可解析的假 `bashPath`）。其中**真实调用档（4 例）**的 `skip` 条件不是「完全没有 bash.exe」，而是「解析到的不是 Git Bash」：候选链里的 `System32\bash.exe`（WSL 启动器）被排除，并对候选跑 `uname -s`，只有 MINGW/MSYS/CYGWIN 才算 Git Bash；其余 19 例在任何 PATH 下都照常运行。

## 安装

见 `docs/install.md`：备份 → 装包 → patch 加一行 insert → 重启 → 验收。

## 已知限制

1. **Windows 只限写**：宿主 `windows-acl` 后端只限制写；读、网络、进程可见性不受限（源码注释原文如此）。要读隔离需另走容器方案（不在 0.2.x 范围）。
2. **额外可写目录不支持**：Windows 下若会话配置了 `additionalWritableRoots`，`confine` 抛 `SANDBOX_UNSUPPORTED_POLICY`；本工具原样透传为可读错误，不降级。
3. **`sandbox_permissions` 升级未实现**：留待 0.2.1；denial 后可改用官方 `pwsh` 走批准流程。
4. **前台同步**：没有后台作业/任务 id；长跑命令会占满一次调用。
5. **PATH 兜底可能命中 WSL**：候选链最后一档是 `PATH`，其中可能包含 `%SystemRoot%\System32\bash.exe`（WSL 启动器）。在 Git 装在非标准目录且装了 WSL 的机器上，可能静默选到它（`uname -s` 返回 `Linux`）。0.2.1 的路径增强会加候选校验（见 `docs/v0.2-design.md` 的「非目标」）。

## 许可

MIT，见 `LICENSE`。
