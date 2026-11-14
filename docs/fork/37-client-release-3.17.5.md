# MiloCode 3.17.5 发布规格与记录

2026-11-14。用户已授权发布本轮 [全面品牌复审](36-user-visible-branding-audit.md) 修复，目标为 Windows x64 与 macOS ARM64 正式 stable。

## 发布规则

- 根 `package.json` 为版本唯一来源，版本递增为 `3.17.5`，根 lock 元数据同步；不得覆盖 3.17.4 的安装包、签名或资源。
- 品牌修复、版本及规格先提交，再从该 source HEAD 真实编译 Agent、Main、Host、Renderer。每个平台的 runtime staging 与打包顺序执行，不并行覆盖平台资源。
- Windows 沿用 `milocode-win-2026-r2`，SPKI DER SHA256 为 `998ee4347085aa9e4ad109c2c99d6b76386be0f816b60c71d8244f8a053792f9`；macOS 沿用 Sparkle `milocode-updates`。不生成或轮换密钥。
- Windows 继续采用完整固定 NSIS 工具链与现有安装器；Mac 继续提供拖入 Applications 的 DMG 和 Sparkle ZIP，使用现有免费 ad-hoc 签名，不声明 Apple 签名或公证。
- 固定 Node 24.14.0、pnpm 10.33.2，生产构建配置，更新根 `https://download.editor.vip/milocode/`。产物目录 `packages/desktop/dist-milo-3.17.5-20261114/`，证据目录 `output/3.17.5-release-audit/`。
- 最终 Windows EXE 冻结摘要后，更新既有 Windows 验收清单并用同一份字节运行 CI。后续仅验收脚本或发布记录提交不冒充 App 编译来源。

## 验证与切换

沿用 [31 号发布操作合同](31-client-update-release-guide.md) 与 [35 号上一版记录](35-client-release-3.17.4.md)：先验证源码门禁，后验证最终安装包。Windows 需要真实向导、安装、可点击登录页与卸载；Mac 需要 DMG/ZIP、应用身份、当前菜单、冷启动与登录发起检查。保留原生菜单中英文验收，不发送付费模型请求。

由既有发布工具签署计划并验证，再按不可变资源、完整公网摘要检查、平台 stable feed 的顺序发布。通过生产下载 API 确认两平台 `3.17.5`；无需因客户端发包重部署 Sub2API。每个平台独立记录验收与发布时间，不把本地生成清单视为上线成功。

## 执行结果

业务源码为 `76aed295e51311bba596d91573bcbf12d06f9cfb`，两平台 Main metadata 都记录 `76aed295`。后续 `b2a38797` 只更新本版 Windows 验收脚本与冻结清单，不是 App 的编译来源。两平台 source、staging、包内 CLI SHA256 均为 `baa289259dce7fb9c66c2f085c2827f43d3abe2f54f9761f1f0a5761f8ea8b61`。

| 产物 | Bytes | SHA256 |
| --- | ---: | --- |
| Windows x64 EXE | 198,160,394 | `054939d89ed84cd3e6a514b206f5cce03256f4c0c6a4a69ec4186f35d6812cd4` |
| macOS ARM64 ZIP | 228,065,433 | `db132e3bceafc424137676223867c85fa529f72be14e3ddf448d36869c3a060c` |
| macOS ARM64 DMG | 235,819,248 | `b84314f8d83cd2336f11fe87172562e88a4155f6ccbed4936eaa81ebd5aa5256` |

根 typecheck、Lint 与架构门禁通过；更新和发布工具回归 31/31 通过。推送前门禁通过；首次 affected selector 选中了整个 158 文件工程套件，按现有工具规则跳过，未将其记为实际运行通过。品牌审计的范围回归与原生双语菜单验证见 36 号记录。

Windows 静态检查通过，覆盖完整归档、46 个已修改插件资源三方字节一致、CLI 三方摘要、9 个 x64 资源、11 项费用归属检查、安全存储、更新策略和固定公钥、NSIS ABI 与全部图标帧。初次审计只看 Main 入口未跟踪共享 chunk，导致 tray 文案假阴性；审计工具修为静态遍历 Main 的实际相对依赖，最终精确检查中英文 About/Open 文案，未修改包或放宽品牌要求。

[Windows CI 43572886479](https://github.com/baisuipingan/ZCode/actions/runs/43572886479) 对同 SHA256 的最终 EXE 实际验证安装向导、安装、可点击登录页与卸载全部通过，安装/卸载均退出 0，截图及前后严格 DOM probe 已核对。没有执行付费模型调用，未将该场景称为完整原位升级验收。

两平台计划均经独立固定正式公钥验证：Windows 清单及完整 EXE、Mac feed 整体签名及 ZIP 归档签名均通过。计划只包含各自三个正确对象，无凭据、签名 URL 或本机绝对路径。

Mac 最终静态检查 21/21 通过，覆盖 ARM64、ad-hoc 签名、Sparkle 身份、DMG 拖入 Applications 布局、ZIP/DMG/builder 的关键字节及 CodeResources 一致。首次静态检查把 Windows 专用且已在 Mac 构建中被 tree-shaking 移除的托盘文案列入 Mac 预期，已修正平台审计范围，未修改最终包。

同一份最终 Mac app 的原生菜单与关于窗口通过中英文验收；正式 `app.name` 为 MiloCode，未使用 E2E 名称豁免。第一次冷启动登录检查遇到系统锁屏，证据保留在 `ui-final/`；用户解锁后用新隔离目录 `ui-unlocked/` 重试通过，登录发起约 11.1 秒（首次钥匙串可用性检查约 10.5 秒，其后读写均为 0–1 毫秒），成功构造本站授权地址、S256 PKCE 和 loopback 回调，并可取消后重新操作。检查使用真实 UI 控件，在打开浏览器边界截获导航，不包含账号登录、token 交换或付费模型请求。页面错误为 0，更新状态为 enabled/idle，进程正常退出。

## 正式发布

2026-11-14 两平台均已使用既有管理员发布入口和同一份已签署计划发布成功，退出码为 0。工具先验证不可变文件的公网完整摘要，再切换各自 stable；未创建管理员 Key、轮换签名身份或修改发布存储配置。两平台公网独立检查均通过，覆盖固定公钥清单/feed 验签、实际下载 Mac ZIP 的归档签名，以及 EXE/blockmap/ZIP/DMG/feed 的完整 SHA256/SHA512、HEAD、Range、MIME 和缓存头。不可变文件使用长期 immutable 缓存，stable 使用 no-cache。

生产 `/api/v1/desktop/downloads` 已确认两平台 `available=true` 且 `version=3.17.5`，尺寸分别为 Windows EXE 198,160,394 bytes、Mac 更新 ZIP 228,065,433 bytes。现有下载页从该接口动态读取，本轮没有修改或重部署 Sub2API。Mac 拖入 Applications 的 DMG 同时发布在相同版本目录，可从 GitHub Release 取得；当前网站接口提供的是 Sparkle ZIP，不把它描述为 DMG。

[GitHub MiloCode 3.17.5](https://github.com/baisuipingan/ZCode/releases/tag/milocode-v3.17.5) 已于 `2026-11-14T08:08:55Z` 公开，`draft=false`、`prerelease=false`。四份资产均为 uploaded，大小及 GitHub SHA256 digest 与正式计划和完整本地字节一致，未覆盖旧版资产。Windows 3.17.4 可继续使用应用内更新；Windows 3.17.3 及更早需手动安装一次新版。Mac 仍采用既有免费 ad-hoc 签名，未声明 Apple Developer ID 签名或公证。

发布证据包括 `windows-publish.log`、`mac-publish.log`、`windows-public-verification.json`、`mac-public-verification.json`、`github-assets-independent-verification.json`、`github-release-final.json`、`production-downloads-final.json` 和 `production-downloads-final-verification.json`。完整应用内原位安装升级未在本轮重跑，不用安装向导或 feed 验证替代该结论。

验收及发布结束后，已清理本轮可再生 Windows unpacked、Mac builder `.app`、隔离验收用户目录和公网核验临时下载。正式 EXE/blockmap/ZIP/DMG、已签署计划、JSON 结果、日志及截图保留，未触及用户安装、真实用户数据或签名密钥；最后一轮清理记录为 `release-cleanup.json`。
