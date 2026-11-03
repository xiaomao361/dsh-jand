# 接口与恢复

## DSH 原生接口

实际安装包：`DeepSeek Harness.app` 内 `@deepseek-ai/dsh-tool-jobs` 和
`dsh-jobs-local` 0.2.1-rc.5。插件使用：

```js
const id = ctx.jobs.start({
  kind: 'jand', owner: exec.agent.id, label: 'jand inbox <chat>',
  run(handle) {
    return { done: completionPromise, cancel() { /* stop owned worker */ } };
  }
});
```

Job admission 先检查 controller 和 owner；一次性 worker 在无 shell 的
独立进程中执行 `jand chat recv --json --wait 30m --wake request,reply,delivery`。
仅向 job 输出固定元数据，正文通过持久 inbox tool 正式读取。完全不依赖
completion notice 是否内联短输出，不前台等待 job 来消费完成通知。

本机原生 tool-jobs 在 settled 且未被 awaited、未 teardown 时，通过
`ctx.agents.get(owner)` 找到 owner；idle 时 `followup`，busy 时 `inject`。
插件不自行实现唤醒服务，也不使用 Codex queue 或 DSH send_message 替代传输。

官方参考：[Background Job Runtime](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/jobs)、
[tool-jobs README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/jobs/tool-jobs/README.md)。
上游行为可能变化，本机版本和自动测试是这次验证依据。

## 接收事务

1. 获取 chat 级跨进程锁，恢复上次 ready journal。
2. 复制该 chat 的本地状态到专用 transaction home；Relay 仍通过原 jand 协议读取。
3. 在 stage 中运行 recv。失败、非退出4的错误事件、格式异常或取消均不提交 stage 游标；退出4表示终止不可用。
4. 将完整事件写入 inbox，fsync 文件并原子替换；消息 id 去重。
5. fsync stage sidecar，写入并 fsync ready journal。
6. 逐个原子安装 sidecar 到 live home。中途崩溃时，后续恢复根据 journal 重做。
7. 清理已提交 stage，释放锁，job 完成。上层 ack 前保留事件。

在步骤 4 前崩溃：live 游标未推进，Relay 在保留期内可重新读取。
在步骤 4 后、5 前崩溃：事件已持久化，live 游标未推进；重读按原游标去重。
在步骤 5 后崩溃：事件已持久化，journal 支持幂等 roll-forward。
owner/job 输出销毁：事件仍在 inbox，使用原 owner session id 恢复读取。

这解决本机 jand transcript 静默写失败和 stdout 随 owner 销毁的问题；不能
承诺 Relay 过期、磁盘介质损坏或用户删除状态后的恢复。Windows Node 不支持
目录 fsync，本轮只验证程序中断恢复，未证明断电持久性。

## 资源和权限

每个 manager 对 chat 先保留启动位，避免 await 内核准备期间重复 job。
worker 的锁保护 recv 与所有本地发送/确认操作；锁获取与死 PID 恢复还通过
独立 gate 串行化，不能只按时间抢锁。owner 销毁与插件卸载都取消 job；
Mac/Linux 向 worker 发 SIGTERM，由其 AbortController 停止 Go 子进程；
Windows 用 taskkill 终止这个 worker 的进程树，随后从 journal 恢复。
Windows 清理路径需要实机验证。

令牌通过本地文件或仅 owner 页面的密码输入保存，再以子进程环境交给内核；命令参数、job label 和
通知不包含令牌或远端正文。插件不会修改系统 PATH、全局 jand 配置、DSH profile
或现有 jand 源码。来自工具的远端内容统一标为不可信。


## 0.2.0 分发与原生页面

0.3.0 的运行时清单固定 0.5.0 发行归档 URL、归档哈希和内部二进制哈希。下载只允许
HTTPS 和明确的 GitHub 资产跳转；提取器只返回一个指定的有界普通文件，不把
归档路径写到磁盘。缓存命中仍核对二进制哈希。开发用旧二进制已保留在忽略的
.local 目录，生产包只有清单，没有平台程序。未自动更新或依赖 latest API。

Host 使用标准 TypertRemoteService、Remote 标记与严格贡献 schema。Client
以 DSH module-loader factory 注册，挂入 settings.section 并复用 React、主题
及 locale。Client Remote 与 Host 使用同一浏览器安全契约；不直接接触文件、
不接收协议密钥、不执行命令。所有读写都在 Host，owner 限制额外拒绝 guest。

页面与 Agent 共用 configure/status/prepare/inspect 行为。密码输入授权属于
用户页面，不暴露为 Agent 的明文工具参数，也不写入 Session 或插件计量。
Agent 的配置工具只接收中继或本机文件路径。导入/替换前保留私密旧令牌副本。
偏好与凭据均在插件目录，不更改 DSH profile。healthz 只证明是否要求权限，
不能验证某个令牌；不可达/格式异常不会退化为正常匿名可用。

原生通知从 agent/inbox/spliced 区分 next-turn 与 next-step，再以 user/message
正式接纳确认，不把 job settled 直接计为已唤醒。工具输出字节关联 tool/call
和已提交 tool/result，读取的是会话最终内容；兼容本机将工具参数保存为 JSON
字符串的格式。接收失败与取消另记。任何记录缺失/损坏或累计数值溢出都保留
不可用状态，不能推导 token 或业务完成。

当前 0.5.0 内核提供 schema_version=1 inspect。页面按实际 help 能力探测调用；
旧 0.4.6 使用白名单文件投影。未知 schema 或命令失败不退化为正常成功。

## 0.3.0 任务控制器

任务控制器复用同一个固定且哈希校验的 0.5.0 内核。插件启用即安装受管工具 guard，
明确提交任务或准备内核时完成下载；只读状态、能力查询、停止不触发下载。
仅开发覆写需要 taskControllerPath + taskControllerSha256，发行安装无需本地路径配置。
详细状态、容量、停止和降级契约见 TASK_CONTROLLER_2026-11-02.md；通知保持查询模式。
