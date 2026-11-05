# dsh-jand 0.5.5

修复空闲时任务控制监控长期空转的问题。功能与协议不变，只改监控取数方式与
内核校验的缓存策略。

## 问题

任务控制监控是一个 250 ms 的定时器，用来在两轮任务之间发现 `halted` 控制，
再执行 `finishStop`。旧实现每个 tick 都对磁盘上**每一个历史 scope** 调一次
`ledger.scopes()`，而 `scopes()` 会 `execFileSync` 同步启动 controller
（`jand task --root ...`）取状态；每次调用前还会把 9 MB 内核整份读入并重新算
SHA-256。

于是代价随历史 scope 数线性放大，而且 tick 本身比 250 ms 还长：定时器总是
"上一轮没跑完、下一轮立刻触发"，等于在主线程上常驻空转。实测一台机器上 8 个
11 月 3 日遗留的已完成 scope，让宿主进程稳定占 32%–59% CPU，活动监视器里
12 小时能耗 793.99 —— 用户那边**没有任何任务在跑**。

## 变更

- 控制监控改读本地 scope 记录（`src/tasks.js` 的 `TaskLedger.local()`）：
  `halted`、`control_id`、`owner`、`scope`、`runs`、`coordinator` 本来就在
  scope JSON 里，判定不需要再问内核，也不再启动任何进程。
- 记录按 `ino`/`size`/`mtime`/`ctime` 缓存：文件没变就不重新解析，历史 scope
  再多也只退化成一次 `stat`。
- 内核 digest 同样按 `ino`/`size`/`mtime`/`ctime` 缓存（`TaskLedger.pinned()`），
  不再每次 `call()` / `probe()` 都重读 9 MB 内核。缓存键含 `ctime`，用户态无法
  在改内容或回拨 `mtime` 时不动 `ctime`，因此"先校验后执行"没有放宽。
- 读不出来的 scope 记录会让 `controlMonitor` 报 `failed`，恢复可读后自动清除，
  不会静默当作"没有控制"。

## 语义不变

- `halted` + `control_id` 的"每个控制只处理一次"逻辑、`finishStop` 的取消与
  清理顺序、`controlMonitor` 在 `jand_task_status` 里的呈现都保持原样。
- 派发、复核、停止、恢复仍然只通过内核执行；本地读取只用于监控判定。
- `dispose()` 仍在拆除时向内核确认一次，不变。

## 验证

- `npm test`：87 项，80 通过、7 跳过（需要真实内核的用例），0 失败。
- `npm run test:tasks`（用 `/Volumes/E61/jand` 源码现场构建内核）：
  15/15 通过，含既有派发/停止/并发准入集成用例。
- 新增用例锁定回归：控制监控 tick 不调用 `scopes()`（不 spawn 内核）、同一
  `control_id` 只处理一次、未 halted 的 scope 不被停止、读不到的记录报
  `failed` 并可恢复、digest 缓存命中且内容变化后仍拒绝执行、`local()`
  跳过坏文件并在重写后重新读取。
- 性能实测（8 个真实历史 scope）：单个 tick 0.050 ms，CPU 0.093 ms，按 250 ms
  节奏折算约 0.04% 单核；修复前同样 8 个 scope 每 tick 要 8 次进程启动。

## 已知边界

- scope 记录损坏时只跳过该条并报 `failed`，不再借内核复核这一条；其它 scope
  的监控不受影响。
- 已在运行中的进程要重载插件后才生效：开发链接按 unlag 的刷新按钮，正式安装
  升级到本版本。
