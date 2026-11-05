# dsh-jand 0.5.4

纯打包修正，功能与 0.5.3 完全相同（见 `docs/RELEASE_0.5.3.md`）。发布 0.5.3 后
核对实际产物时发现两处文档缺失：

- npm 包漏了 `docs/RELEASE_0.5.3.md`：导出仓的 `files` 列表里没有它，README 又用
  相对路径链接到它，npm 页面上那条链接是死的。本版把发布说明纳入打包，并把 README
  的链接改成指向 GitHub 的绝对地址。
- 镜像上的本地构建（`local-dsh-jand-0.5.3.tgz`）缺归档策略那段说明，因为
  `docs/DOWNLOAD_MIRROR.md` 是在该包上传之后才补充的。

## 变更

- 打包内容：`docs/RELEASE_0.5.3.md`（npm）与更新后的 `docs/DOWNLOAD_MIRROR.md`
  （两个渠道）随包发布。
- README 的发布说明链接改为绝对地址，不再依赖包内相对路径。
- 内核清单、下载来源、校验逻辑、面板行为一律不变：仍固定 jand 0.5.0，
  仍校验归档与二进制双哈希。

## 验证

- `npm test`：与 0.5.3 同一套用例，全部通过。
- `npm run check:mirror -- --package <本版 tgz>`：索引与本包哈希一致。
- 已发布 npm 与镜像两个渠道版本一致，均为 0.5.4；0.5.3 的旧构建移入
  `/srv/jand-downloads/archive/`，不再对外服务。

## 已知边界

Windows 真机（首次下载、Defender 拦截、窄屏断行）仍需在真实设备上确认；Windows
ARM64 仍只做提前提示，不提供模拟运行路径。
