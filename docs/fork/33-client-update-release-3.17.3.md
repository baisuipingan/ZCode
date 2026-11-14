# MiloCode 3.17.3 发布记录

记录日期：2026-11-14（Asia/Shanghai）。Sub2API 生产与 Windows x64、Mac ARM64 3.17.3 均已发布；实际验证范围及未覆盖项单独记录，不把本地构建成功视为全部实机升级通过。

## 已上线的服务端

Sub2API 生产已从 0.2.21-ds.14 升至 **0.2.21-ds.16**。正式 CI `baisuipingan/sub2api/actions/runs/43467450281` 全部通过，源码 `d3c30869a8f17810d9dcb6dae76b667b0653e8af`，不可变镜像摘要 `sha256:9219289302905e17132e97bafd299ea1f687c74159b348fec95720f8b2e1485d`。部署使用现有 release helper，先完成 PostgreSQL 备份，应用与数据库、Redis 健康。本轮无新增数据库迁移，schema epoch 仍为 4；不要据此忽略部署器既有 backup-required 回退合同。

生产桌面发布存储已测试并保存：独立桶 `milocode-releases`、公开域名 `https://download.editor.vip`、根 `https://download.editor.vip/milocode/`。连接与权限复用备份 S3。真实随机对象读写、公网映射及清理测试通过；未修改备份桶、私有图库或系统信任。

导航最后增加「MiloCode 下载」，普通用户、管理员、控制台与工作台均有对应上下文路由。下载数据只读取公开 stable 元数据，缓存 60 秒；安装包正文直接从发布域名下载，不经过 Sub2API 代理。

## Windows x64 已发布

版本 **3.17.3**，源码 `419507b4`。EXE 大小 198,142,576 字节，SHA256：

```text
e6fc2570dc0bcdd342c9ae77ae2ba263a08d4f557692c33611df69d4dbda0aee
```

安装器、blockmap 和 Ed25519 签名 stable 清单均已发布。发布工具完成不可变条件上传、公网 HEAD、Range 与流式完整 SHA512 对照后，最后发布 stable。生产 `/api/v1/desktop/downloads` 已返回 3.17.3 的正确直连下载地址。

真实 NSIS 离线验收通过：内包、当前 CLI 三方 SHA、11 项调用归属、9 项 x64 原生资源、品牌、登录回调 CSP、正式更新根、公钥及实际 updater enabled。AST 验证 Windows / Mac 走异步 OS 加密，Linux 单独保留原安全同步实现并拒绝 basic_text。尚未执行 Windows x64 实机安装、启动或跨版本升级，不能用离线验收代替。

## Mac ARM64 已发布

3.17.3 DMG 与 ZIP 已生成，同为 `419507b4`。实际 DMG 内应用、Sparkle.framework 和 Node-API 桥的 `codesign --verify --deep --strict` 通过；应用为完整免费 ad-hoc 签名，不是 Developer ID 或公证。固定 feed、公钥、强制验签及手动安装策略通过。解锁后两轮实际包验收通过，Mac ZIP、DMG 与签名 appcast 已发布。发布工具完成三个对象的公网 HEAD、Range 与完整 SHA512 对照；生产下载接口已返回 3.17.3 的 ZIP 直连，独立 DMG 同时保留。

旧同步加密包首次隔离登录出现 5 秒安全存储错误与 Main 日志长暂停，后续三轮正常登录、取消与界面验收通过；未记录到首次具体 native 调用耗时，不能伪称精确根因。为消除已知同步阻塞风险，Mac / Windows 改用 Electron 异步 safeStorage，并共用 120 秒有界等待；每个写入固定发起动作，取消、退出及关闭 Host 后迟到结果不得保存旧凭据。Linux 因异步 provider 有固定 key fallback，保持既有安全后端。

最终异步包的实际冷启动验收发生于电脑锁屏：系统 `CGSSessionScreenIsLocked=Yes`，OS Keychain 等待位于后台 worker，Main 在正常 RunLoop；120 秒后安全存储失败、取消和 Host 退出生效。该结果只证明有界错误与生命周期保护，不代表正常登录通过。用户解锁后已分别完成全新 userData 冷启动 / reload 登录取消，以及真实旧同步测试密文兼容，两轮结果均通过、页面错误均为空。首次系统加密异步初始化约 4.2 秒，点击至登录授权等待约 4.9 秒；旧测试会话由新接口成功读取，未使用真实用户凭据。共 10 张截图已检查，无旧品牌、裁切或横向溢出。原锁屏失败证据保留，不用后续成功覆盖。

Mac 正式包 SHA256：

```text
ZIP f33013909dcc7f3e44a4a1aca3f20562161aeb9c7b9a1839704cce8938841ba0
DMG 80b7207596ca426b0ebddede5f2db2bb146c5191542ede97b98d842e26473d39
```

发布前独立验签直接使用客户端固定公钥，分别验证 appcast 的完整签名块和 ZIP 归档签名，未依赖钥匙串私钥验证。正式 Mac-only 计划只包含三个 darwin-arm64 对象；公网独立验证确认 appcast 完整签名及 ZIP 签名均正确，ZIP/DMG 的完整 SHA256、SHA512 与冻结计划一致，HEAD、MIME、Range 及缓存头符合合同。Windows stable 清单发布前后 SHA256 均为 `d25cf9c7f23ffe814680525769049f9e62835b962d1567631fc205455a3443fc`，没有被改写。

发布后，用实际 DMG 内 3.17.3 应用的隔离副本触发原生菜单「检查更新」。客户端从 checking 回到 idle，真实 Sparkle 系统日志于 09:33:36 明确记录 `OK: EdDSA signature is correct for appcast`，确认客户端接受正式公网清单签名。未观察到「已是最新版本」原生提示，不把 idle 单独当作成功证据，也未借此验证跨版本下载或安装。人工证据等待先于最终文件写入而超时，原 runner 的失败记录保留，`final-public-feed/final-accepted-event-result.json` 与 `PRODUCTION-FEED-REPORT.md` 单独记录已发生的真实 native 成功事件。该轮 App 与 Host 已退出，自有 719 MiB 应用副本已清理，未操作用户已安装的应用或下载更新归档。

## 验证与交接

全项目 typecheck、lint（0 errors，84 条既有 warnings）、生产构建、架构检查通过。新增安全存储运行时 15/15、账号真实 HTTP / 跨 Host 10/10、浏览器授权 7/7；其余更新签名与发布工具 31/31。推送前门禁通过；首次分支 push 使用真实任务基线 a9fe401e，工程 affected 选择全部 158 个规格后按仓库合同跳过全量，不能把此跳过说成全量工程测试通过。

本地证据：`output/milocode-release-3.17.3-acceptance/`、`output/milocode-release/3.17.3-windows/`、`output/milocode-release/3.17.3-mac/`、各平台 prepare / dry-run / publish 日志及 `3.17.3-artifact-inventory.json`。正式安装包保留在 `packages/desktop/dist-milo-20261114/`。只清除可再生 unpacked staging、临时测试副本及 Go 缓存，保留正式包、旧 fix3 与验证证据。

Windows 正式私钥在受保护的本机 ReleaseKeys 目录，Mac 私钥在登录钥匙串 `milocode-updates`，未写入源码或发布桶；独立加密备份仍未完成，不声称已备份。旧 3.17.2 首次需手动安装新引导版，之后才具有应用内检查更新能力。免费更新验签不消除 Windows SmartScreen / macOS 的发行来源提示。
