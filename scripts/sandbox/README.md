# 受限环境专用工具

这个目录里的脚本**正常开发用不到**。它们是给「`spawnSync` / `execSync` / `execFileSync`
一律返回 `EBUSY`、只有异步 `spawn` 可用」的受限环境准备的（本项目开发时就遇到过）。

在正常机器上（比如 Windows 本机），`spawnSync` 是好的，直接用项目自带的命令就行，
**不需要这个目录**。删掉它也不影响任何功能、任何测试。

| 脚本 | 什么时候用 | 正常环境该用什么 |
|---|---|---|
| `sync-shim.js` | 被下面两个脚本 `require`，把异步 `spawn` 包成 `spawnSync` 的替身 | 用不到 |
| `run-apk.js` | 受限环境里打安卓包：`node scripts/sandbox/run-apk.js` | `npm run build:apk` |
| `mutate-store.js` | 改完 `store.js` 做反向验证（变异测试）：`node scripts/sandbox/mutate-store.js` | 手动改坏再跑 `npm run test:store` |

## 原理（`sync-shim.js`）

`spawnSync` 要求「调用后立刻拿到结果」，而异步 `spawn` 只能回调。做法是：

1. 起一个 `worker_threads` worker，在 worker 里 `spawn` 目标进程；
2. 主线程用 `Atomics.wait` 阻塞（Node 主线程允许这么做）；
3. worker 结束后把结果写成临时 JSON，再 `Atomics.notify` 唤醒主线程读取。

`build-apk.js` 一行都不用改 —— 脚本只是把 `child_process.spawnSync` 换掉再加载它。

## 注意

- `run-apk.js` 里 `require` 的是**项目根目录**下的 `mobile/build-apk.js`（用 `__dirname` 定位），
  所以从哪个目录执行都行。
- `mutate-store.js` 会**改写** `src/main/store.js` 再还原。跑之前最好确认工作区是干净的
  （`git status`），万一被中断可以用 `git checkout -- src/main/store.js` 复原。
- 两个脚本的 `require('./sync-shim.js')` 是相对**文件位置**解析的，别单独挪走其中一个。
