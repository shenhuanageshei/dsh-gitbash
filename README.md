# dsh-gitbash

给 DeepSeek Harness（dsh）用的**并行 Bash 工具**：直接 spawn 你本机的 Git for Windows `bash.exe`。

- **不拷贝、不解包**：每次调用只拉起一个 `bash.exe` 进程。
- **不碰 `ctx.shell`**：与 pwsh 共存，最坏情况只是本工具不出现，不会影响现有 shell。
- 输出语义对齐官方 shell 工具：stdout → `[stderr]` 段 → `[error: ...]` / `[timed out]` / `[signal: ...]` / `[exit code: N]`。

> **v0.1.0 的边界**：不做沙箱 confinement。`danger-full-access` 下与官方工具等价；
> `workspace-write` / `read-only` 下本工具**不提供**文件效果隔离。沙箱与路径配置的下一版方案见
> `docs/v0.2-design.md`。

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

> 要的是 `bin\bash.exe`，**不是** `git-bash.exe`（后者是打开终端窗口的启动器）。

候选链（`bashPath` 留空时，见 `lib/resolve.js`）：`DSH_GITBASH_PATH` →
`DSH_GITBASH_ROOT` / `GIT_INSTALL_ROOT` → 常见 Git 安装目录（`%ProgramFiles%` 等）→ `PATH`。

## 测试

```powershell
node --test           # 路径解析 + 功能测试；用例清单与判据见 docs/design.md 的「防偏离」A0/A1
```

功能测试通过注入的 spawn 适配器真实调用 Git Bash（as-of 2026-11-11 全绿）；**前提**：Windows + 已安装 Git for Windows，否则该档按 `skip` 处理。

## 安装

见 `docs/install.md`：备份 → 装包 → patch 加一行 insert → 重启 → 验收。

## 已知限制

1. **不做沙箱 confinement**：`workspace-write` 下本工具不提供文件效果隔离（`danger-full-access` 下等价）。
2. **前台同步**：没有后台作业/任务 id；长跑命令会占满一次调用。
3. **PATH 兜底可能命中 WSL**：候选链最后一档是 `PATH`，其中可能包含 `%SystemRoot%\System32\bash.exe`（WSL 启动器）。在 Git 装在非标准目录且装了 WSL 的机器上，可能静默选到它（`uname -s` 返回 `Linux`）。0.2.1 的路径增强会加候选校验（见 `docs/v0.2-design.md` 的「非目标」）。

## 许可

MIT，见 `LICENSE`。
