# Sidebar actions · 侧边栏快捷操作

给 DeepSeek Harness 的左侧边栏底部加三个按钮：**刷新 / 重启 / 退出**。
刷新只是重新加载页面；重启和退出会让整个桌面端退出（重启后自动拉起）。

A DSH plugin that puts **reload / restart / quit** in the sidebar footer.

---

## 功能

- **刷新**：重新加载 Web 界面（桌面端没有 Ctrl+R 菜单项，这个按钮补上）。
- **重启**：退出桌面端后用同一条命令行重新启动，插件改动、profile 改动随之生效。
- **退出**：关闭桌面端。
- 侧边栏展开时显示「图标 + 文字」，折叠成 56px 窄栏时收成一个按钮，点开是三行菜单。
- 重启 / 退出需要**连点两次**确认（4 秒内），避免误触把应用关掉。
- 按钮会读宿主状态：非桌面环境（纯 `dsh web`）下重启/退出自动禁用；失败时按钮旁出现小红点，悬停可看原因。

## 安装

### DSH Desktop

1. 打开 **设置 → 插件**（或插件市场）。
2. 选「从本地目录安装」并选中本包的目录，或把 `dist/dsh-sidebar-actions-1.0.0.tgz` 的路径填进安装框。
3. 安装完成后刷新一次页面（页面里的「刷新」按钮就行），底部就会出现三个按钮。

### 普通 `dsh web`

```sh
dsh plugin --profile <profile> add ./dsh-sidebar-actions-1.0.0.tgz
# 已发布到 npm 后：
dsh plugin --profile <profile> add dsh-sidebar-actions
# 或直接从 GitHub 源码安装：
dsh plugin --profile <profile> add github:<owner>/dsh-sidebar-actions
```

装完重启一次 `dsh web`。

## 重启 / 退出是怎么实现的

桌面端本身没有把「退出」暴露给插件：页面拿不到 `app.quit()`，宿主进程也只是 Electron 的一个子进程。所以插件按机器能力选两条路径，并在 `GET /dsh-sidebar-actions/api/state` 里如实报告用的是哪一条。

### 1. 优雅桥接（graceful，推荐）

桌面端主进程里加一小段轮询（见文末「可选：让重启走优雅路径」），插件写请求文件，主进程自己调用 `app.relaunch()` / `app.quit()`——和托盘菜单同一条路径，运行中的任务会走原生确认框。

插件不靠猜：桥接方启动时在 `%LOCALAPPDATA%\dsh-restart.bridge` 留下标记文件，插件看到标记才走桥接。标记过期（应用升级把补丁覆盖掉）也不会卡死——请求文件 2.5 秒没人消费就自动退回下面的独立助手。

### 2. 独立助手（forced，无人值守）

没有桥接时，插件用一个**每次用户级计划任务**（任务名 `DSH-SidebarActions`）启动 `scripts/dsh-stop.ps1`。助手跑在应用进程树之外，所以：

1. 只结束请求里的那个 shell 进程（并校验它确实是主进程，不是渲染进程）；
2. 等同一可执行文件的其余进程（渲染进程、Host）自己退出；
3. 重启用**原始命令行**（WMI `Win32_Process.Create`）把应用拉起来。

这条路径能在**未打补丁的原版应用**上工作，代价是：它是强制结束，**不会弹「当前任务会被中断」的原生确认**——所以按钮要求二次确认，悬停提示也会写明。Windows 专属；其他平台只能用桥接。

## 状态、日志与排错

| 东西 | 位置 |
| --- | --- |
| 状态接口 | `GET /dsh-sidebar-actions/api/state`（同源） |
| 插件日志 | `%LOCALAPPDATA%\dsh-sidebar-actions\host.log` |
| 助手日志 | `%LOCALAPPDATA%\dsh-sidebar-actions\helper.log` |
| 助手任务 | `schtasks /query /tn DSH-SidebarActions /v /fo list` |

常见现象：

- **按钮点了没反应，9 秒后出现「没有响应」**：看 `helper.log`。若里面连 `helper start` 都没有，多半是任务没建起来（`schtasks /query` 查不到），看 `host.log` 里的 `task ensure failed`。
- **重启后窗口没回来**：`helper.log` 里的 `replacement started` 与 `replacement processes after 4s` 会写明是否起来了；`start failed` 一般是杀毒软件拦截，手动启动一次即可。
- **想确认当前是哪种模式**：`/state` 里的 `via` 是 `graceful` / `forced` / `unsupported`。

## 卸载

1. 在「设置 → 插件」里移除本插件（或 `dsh plugin --profile <profile> remove dsh-sidebar-actions`）。
2. 可选清理：

```powershell
schtasks /delete /tn DSH-SidebarActions /f
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\dsh-sidebar-actions"
```

## 可选：让重启走优雅路径

> 这一步改的是应用自己的 `app.asar`，属于「你自己机器上的取舍」：应用每次升级都会覆盖回去，需要重新打。
> 不打也能用，只是走上面的「独立助手」强制路径。

在主进程（`resources/app.asar` 里的 `lib/main.js`）中，托盘初始化之后加：

```js
// dsh-sidebar-actions: graceful relaunch / quit requested by the sidebar.
{
  const { join } = require('node:path');
  const { existsSync, rmSync, writeFileSync } = require('node:fs');
  const base = process.env.LOCALAPPDATA || app.getPath('temp');
  const restart = join(base, 'dsh-restart.request');
  const quit = join(base, 'dsh-quit.request');
  // The marker tells the plugin this shell really polls the two files.
  try { writeFileSync(join(base, 'dsh-restart.bridge'), new Date().toISOString()); } catch {}
  setInterval(() => {
    try {
      if (existsSync(restart)) { rmSync(restart, { force: true }); app.relaunch(); app.quit(); }
      if (existsSync(quit)) { rmSync(quit, { force: true }); app.quit(); }
    } catch (error) { console.warn('dsh-sidebar-actions: request poll failed', error); }
  }, 1000);
}
```

改完重启一次应用，`/state` 的 `via` 会变成 `graceful`。
若之后不再想用桥接，删掉 `%LOCALAPPDATA%\dsh-restart.bridge` 即可，插件会退回独立助手。

## 兼容性与安全

- 目标环境：DeepSeek Harness Desktop 0.2.x（Windows）。`dsh web` 下只有「刷新」可用，这是有意为之。
- 不联网、不收集任何数据；所有逻辑都在本机。
- API 只接受同源 `POST`（`Sec-Fetch-Site` / `Origin` 校验），别的网页无法触发重启。
- 助手任务以当前用户运行，仅当需要重启/退出时被 `schtasks /run` 拉起；不会常驻。

## English

Adds **reload / restart / quit** to the sidebar footer.

- Reload is plain `location.reload()`.
- Restart and quit need the desktop shell. The plugin uses a *graceful bridge* when `%LOCALAPPDATA%\dsh-restart.bridge` exists and the shell polls `dsh-restart.request` / `dsh-quit.request`; an ignored request falls back to a *detached helper* after 2.5 s: a per-user scheduled task (`DSH-SidebarActions`) running `scripts/dsh-stop.ps1` outside the app's process tree, which stops the shell process and starts the executable again with its original command line.
- The forced path works on an unpatched app but interrupts running tasks without the native prompt, so every stop needs a second click.
- Windows only for the forced path; other platforms use the bridge exclusively.

State and logs: `GET /dsh-sidebar-actions/api/state`, `%LOCALAPPDATA%\dsh-sidebar-actions\{host,helper}.log`.

## License

MIT. See [LICENSE](./LICENSE).
