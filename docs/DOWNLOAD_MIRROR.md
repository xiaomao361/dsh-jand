# 备用下载源

2026-11-05，在现有 `https://jand.zhou-wei.com` 上增加独立的静态下载路径。

- 内核：`/downloads/jand/v0.5.0/`，含五个平台的官方归档、`manifest.json` 和 `SHA256SUMS.txt`。
- 插件候选包：`/downloads/dsh-jand/v0.5.3/<完整 SHA-256>/local-dsh-jand-0.5.3.tgz`，同目录提供 `SHA256SUMS.txt`。哈希目录区分同版本候选，不覆盖旧包。
- 文件索引：`/downloads/index.json`；准确列出本次软件包的 URL、大小及 SHA-256。

## 下载策略

GitHub 为主源；每个来源先自动重试一次（间隔 1 秒），传输、TLS、HTTP 失败或整次下载超过 15 秒时，使用清单中的固定备用源（最长 120 秒，含跳转与响应体）。准备期间对外上报阶段与字节进度。备用源不随用户的协作中继地址变化，不发送协作令牌或邀请。

每个源只允许 HTTPS、无 URL 凭据及同主机跳转。GitHub 额外允许原有官方资产域名。超过大小上限、不安全跳转、归档或二进制哈希不符均停止，不用其他源掩盖校验失败。双源不可用时保留错误码及逐源失败信息，不写入内核缓存。缓存和本机开发覆写流程不变。

## 来源记录与自检

准备成功后在内核目录写入 `jand.origin.json`（`primary` 或 `backup` 加主机与时间），
设置页显示候选来源和上次实际来源；写不进去不影响已校验的内核。

`npm run check:mirror` 比对 `/downloads/index.json` 与本包清单的地址与哈希；
`--download --platform win32-x64` 真实下载并核对归档与解出二进制；
`--package <tgz>` 核对候选包哈希。索引里登记的包哈希必须等于最终上传的文件。

## 归档与备份

被替换的候选构建不留在 HTTP 服务目录内，移到 `/srv/jand-downloads/archive/`
（`archive/README.md` 记录每个归档的来源与替换原因）。恢复某个归档前，先把它
复制回 `/srv/jand-downloads/downloads/` 并同时更新 `index.json`，否则下载与索引
会对不上。索引的历史版本保存在 `/var/backups/jand-downloads/`，同样不在 HTTP
服务目录内。

## 服务器维护

静态根目录 `/srv/jand-downloads`；Nginx 的 `location ^~ /downloads/` 使用该根目录，只接受 GET/HEAD，关闭目录索引，找不到的文件返回 404，不落到 Relay 代理。

本次 Nginx 配置原件保存于 `/var/backups/jand-downloads-20261105/jand.conf`，已逐字节比较。新增位置前后均执行 `nginx -t`，只重载 Nginx，没有重启 Relay；内核、Relay 配置、访问策略与数据均未改动。

后续版本先按发行清单验证归档和包内二进制，再上传新版本目录、从公网读回并核对哈希，最后更新插件清单。此实现不会自动同步未来 GitHub 发行版。

## 验证边界

本轮自动测试覆盖备用源成功、主源超时及 HTTP 错误、双源失败、损坏归档与不安全跳转。实际 DSH 桌面安装、Windows 设备与不同国内网络的下载速度仍待用户验收。
