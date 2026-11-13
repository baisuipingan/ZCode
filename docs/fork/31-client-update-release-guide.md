# MiloCode 应用内更新发布操作

状态：实施合同，2026-11-13；用户已报告创建桶 `milocode-releases` 与域名 `download.editor.vip`，尚未由本任务验证公网下载或上传。客户端设计见 [30](30-client-update-without-paid-certificates.md)。

## 存储位置

使用用户已创建的独立 R2 桶 `milocode-releases`，通过 `download.editor.vip` 提供公开软件下载。它与存放用户图片的私有桶完全分开。安装包是公共软件资源，不附带用户 Key、会话或私钥。

客户端构建参数 `MILOCODE_UPDATE_BASE_URL` 使用完整 HTTPS 根，例如 `https://download.editor.vip/milocode/`。对象布局固定为：

```text
milocode/releases/3.17.3/win32-x64/MiloCode-3.17.3-win-x64.exe
milocode/releases/3.17.3/win32-x64/MiloCode-3.17.3-win-x64.exe.blockmap
milocode/releases/3.17.3/darwin-arm64/MiloCode-3.17.3-mac-arm64.zip
milocode/stable/win32-x64/latest.json
milocode/stable/darwin-arm64/appcast.xml
```

版本资源不可覆盖。`stable` 下只存最新版元数据，短缓存。两平台 feed 分别更新；不承诺对象存储具有跨对象原子提交。

## 首期客户端策略与验收

首期只接收 stable，所有下载和安装均需用户明确操作。设置页移除「预览版更新」「自动下载并安装」，保留硬件加速；更新弹窗移除自动更新复选框，保留下载、取消、稍后、跳过和重启操作。旧偏好值不能重新启用后台下载或退出即装，最终策略由 Main 更新适配层裁决。

安装中断确认统一由 Main 的最后退出屏障负责，Renderer 不提前做第二次确认。Main 正常返回表示用户取消或操作完成；Renderer 在 IPC settle 的 `finally` 释放按钮等待状态，因此取消后可重新操作，不把普通取消当失败提示。

浏览器验收使用真实设置与更新组件，覆盖中英文、明暗主题、390px / 1200px、下载前 / 下载中 / 下载完成、等待期间不可重复提交，且渲染本身不会启动下载。工程签名和发布工具测试通过 `pnpm test:milocode-updates` 执行，也纳入现有 `test:engineering-tools` 入口；UI 使用 `pnpm test:milocode-update-ui`，不新增 App 业务单测。

## 外部配置与秘密

推荐让 Sub2API 管理端持有对象存储凭据，发布机使用短时管理员会话；已有完整管理员 API Key 也可走后台现有标准鉴权：

1. 在「桌面端 → 发布存储」填写独立桶 `milocode-releases` 与公开域名 `https://download.editor.vip`，执行连接测试后保存。连接、region、path-style、凭据继承备份 S3，不复制 Secret；确认现有凭据有该独立桶的读写权限。
2. 发布机通过安全环境注入 `MILOCODE_RELEASE_ADMIN_API_URL=https://milorouter.com/api/v1`，凭据严格二选一：`MILOCODE_RELEASE_ADMIN_TOKEN` 使用完整管理员当前会话的短时 JWT；`MILOCODE_RELEASE_ADMIN_KEY` 使用后台已有完整管理员 API Key，通过 `x-api-key` 发送。两项同时配置立即失败。两者都不是 Agent Key，禁止写入命令参数、JSON、Git、聊天或日志；不要为发布临时创建或轮换管理员 Key。
3. 如果系统启用二次验证，必须使用已为同一会话完成 step-up 的 JWT；后端拒绝管理员 API Key 通过此门控时，CLI 在 403 停止，不尝试另一种凭据或绕过验证。401 要求更新合法管理员凭据。生产脚本若临时取得既有 Key，只在进程环境中使用，结束后立即清除临时材料。
4. CLI 先读取后台发布存储，精确核对 `release_base_url` 和已签署计划 `baseUrl`。配置缺失或域名不符时不申请上传，也不写对象。
5. 后端只签发固定对象、大小、类型、hash metadata、缓存和条件头的 15 分钟 PUT URL。CLI 流式直传 R2；管理员 JWT 或 Key 只发送到配置的 Sub2API origin，绝不发送到 R2 或公开下载域名。请求禁止重定向；签名 URL 不输出、不写入计划。

首期临时上传地址仅允许标准 Cloudflare R2 / AWS S3 HTTPS host，并匹配后台桶和本次对象路径。R2 同时支持 account host 的 `/bucket/key` 及配置桶精确前缀虚拟 host 的 `/key`，兼容继承备份连接的 path-style 设置；eu / fedramp jurisdiction 也按相同规则校验。拒绝未知 host、重定向、未签必要头和响应中的 Host / Authorization / Cookie。后端可以支持其他 S3 服务，但此发布 CLI 尚未开放自定义 MinIO host。

保留直接 S3 作为手工备用模式：不配置上述管理员 API 地址和凭据变量，只在发布机安全注入下表。直接模式与任意管理员变量同时出现时立即报配置冲突，不能静默选择其一。

| 变量                                    | 内容                                            |
| --------------------------------------- | ----------------------------------------------- |
| `MILOCODE_RELEASE_S3_ENDPOINT`          | `https://<account-id>.r2.cloudflarestorage.com` |
| `MILOCODE_RELEASE_BUCKET`               | `milocode-releases`                             |
| `MILOCODE_RELEASE_S3_REGION`            | R2 使用 `auto`                                  |
| `MILOCODE_RELEASE_S3_ACCESS_KEY_ID`     | 对应发布桶的上传 Key ID                         |
| `MILOCODE_RELEASE_S3_SECRET_ACCESS_KEY` | 对应 Secret                                     |

更新下载不需要 CORS 放行网站域名，因为是原生客户端网络请求；必须提供 HTTPS、正确 MIME、普通 GET / HEAD 和 Range。发布脚本上传版本包时设置长期缓存，feed 设置 `no-cache`。应保留旧版本资源，不给整个发布桶添加短期自动删除规则。

## 免费发布密钥

Windows 使用标准 Ed25519 清单签名；Mac 使用 Sparkle 官方 EdDSA 工具，彼此不转换私钥格式。私钥只在发布机和独立加密备份中保存，客户端只包含公钥。

Windows 密钥生成命令采用 `scripts/milocode-release.mjs keys`，默认私钥写入用户的 `Library/Application Support/MiloCode/ReleaseKeys/`（目录 0700、私钥 0600），禁止覆盖现有文件。标准输出只打印公钥配置和文件路径，不打印私钥。创建新发行身份前先确认密钥用途及备份位置；已有正式身份不要重复生成。

Mac 使用固定 Sparkle 版本提供的 `generate_keys`，用独立 Keychain account 保存。发布脚本以 account 名调用 `generate_appcast`，不把私钥作为命令行参数或日志输出。

```sh
node scripts/milocode-release.mjs keys --key-id milocode-win-2026
.cache/milocode-sparkle/2.10.1/bin/generate_keys --account milocode-updates
```

正式 Windows 密钥已在本机 `Library/Application Support/MiloCode/ReleaseKeys/` 生成，正式 Mac 密钥已保存在 Keychain account `milocode-updates`；独立加密备份尚未完成，发布前必须补做。以上命令是创建新身份的操作说明，不要重新执行来替换当前密钥。Windows 命令只会显示公钥 JSON 和私钥路径，需把 `publicKeysJson` 配进构建参数 `MILOCODE_UPDATE_PUBLIC_KEYS_JSON`；Mac 输出的公钥配进 `MILOCODE_SPARKLE_PUBLIC_KEY`。私钥先做独立加密备份，再发布含公钥的引导版。不能将一次测试生成的密钥直接当作已备份的正式身份。

## 本地准备与发布命令

建立只包含本地路径和公共地址的 release 配置 JSON。路径相对配置文件所在目录解析；不用在文件中写 S3 凭据或私钥内容。示例中的版本号和路径须替换为真实构建产物：

```json
{
  "version": "3.17.3",
  "baseUrl": "https://download.editor.vip/milocode/",
  "releaseNotesFile": "./release-notes.md",
  "windows": {
    "installer": "./MiloCode-3.17.3-win-x64.exe",
    "blockmap": "./MiloCode-3.17.3-win-x64.exe.blockmap",
    "keyId": "milocode-win-2026",
    "privateKeyFile": "/absolute/private/path/milocode-win-2026.private.pem"
  },
  "mac": {
    "archive": "./MiloCode-3.17.3-mac-arm64.zip",
    "dmg": "./MiloCode-3.17.3-mac-arm64.dmg",
    "generateAppcast": "/absolute/path/to/.cache/milocode-sparkle/2.10.1/bin/generate_appcast",
    "account": "milocode-updates"
  }
}
```

`windows` / `mac` 可只提供一项；正式双平台引导版应在真实验收后一起准备。Mac `dmg` 和 Windows `blockmap` 可省略，Mac appcast 的更新目标固定由 ZIP 生成。发布说明内嵌 appcast，本地 `.md` 只作生成器输入，不上传到发布桶。

```sh
node scripts/milocode-release.mjs prepare --config /private/local/release.json --out output/milocode-release/3.17.3
node scripts/milocode-release.mjs publish --dir output/milocode-release/3.17.3 --dry-run
node scripts/milocode-release.mjs publish --dir output/milocode-release/3.17.3
```

最后一条需要已配置管理员会话环境变量（推荐）、已有完整管理员 Key 环境变量或直接 S3 环境变量，并有可访问的下载域名。输出目录必须不存在；不在同一目录反复重建不同字节的同版本包。Windows 公钥也会作为公开信息记录在本地上传计划中，但私钥和密钥文件路径不会进入计划或上传对象。

## 发布行为合同

`prepare` 只写新的本地输出目录：核对真实递增版本、复制安装包、计算长度和 SHA512、签署 Windows 清单，并调用固定版本的 Sparkle `generate_appcast` 生成 appcast，再用同目录的 `sign_update` 显式签署 feed，验证 feed 和 ZIP 的签名。归档签名和 feed 签名是两层，不能仅看到 `sparkle:edSignature` 就认为整个 feed 已签名。输出包含文件哈希和对象上传计划，不包含私钥或 S3 凭据。缺文件、版本冲突或签名失败都不能生成可发布 feed。

`publish --dry-run` 不读取上传凭据、不访问网络，只校验本地产物并打印将上传的对象。实际 `publish` 才读取所选传输模式的环境变量；管理员模式先读取并核对后台配置，再预检对象。上传顺序为所有不可变资源 → 校验远端对象及公网真实字节 → 两个平台 feed。每个对象都执行公开 HEAD / Range 及一次流式全量 GET 的长度 / SHA512 比对，stable feed 也验；同大小错误响应也必须停止。完整 GET 只由发布机读取一次，不经 Sub2API 下载代理。已存在的同版本对象只允许字节一致时复用，不得覆盖不同内容；使用 S3 条件请求阻止并发写入覆盖。feed 发布拒绝把已发布版本降级。

下载包流量直接由 R2 / CDN 承担。Sub2API 新增管理员发布配置和授权 API，配置保存在既有 settings，无需新表；安装包正文不经网关，没有 R2 / 域名配置时，本地构建与 dry-run 仍可完成，正式发布必须失败并明确列出缺失配置。

## 发布验收

- 使用测试密钥覆盖正确清单、篡改包、缺失签名、平台不符、同版本不同字节和更低版本 feed。
- 先验证上传计划不含私钥、凭据或本地用户数据。
- 正式切换 feed 前，验证 HTTPS 公网对象长度、哈希、Range 及缓存头。
- Mac / Windows 均需实际从引导版连续升级两次，登录、设置和 Agent 运行正常；不能把本地生成 feed 当作实机升级已通过。
- 已安装坏版本时发布更高修复版本，不声称撤回 feed 可以让已安装用户自动降级。

## 2026-11-13 本地验证记录

`node --test scripts/milocode-release.test.mjs scripts/milocode-release-admin.test.mjs packages/desktop/scripts/milocode-release-trust.test.mjs`：28 / 28 通过，包含用临时密钥、免费 ad-hoc 微型 Mac app 归档调用 Sparkle 2.10.1 官方工具，实际验证 feed 和 ZIP 签名。管理员 adapter 还覆盖实际消费后台配置、域名不符零写入、JWT 不到存储、401 / step-up 403、上传先资源后 feed、重复发布、流式上传期间本地文件变更、同大小但内容错误的公网对象和恶意签名响应。该测试不安装应用、不写正式 Keychain、不上传公网对象；Mac 工具未下载或在非 Mac 主机时，该特定 smoke 会明确跳过。

额外完成 Go / Node 真实 SDK 契约检查：后端 AWS SDK 使用假凭据生成标准 R2 预签响应，CLI 原样接收并验证签名 URL、必需 headers 与 15 分钟有效期，再向本地 mock 流式送出 12,345 字节并核对 SHA256；没有真实网络请求，临时 JSON / payload 已清理。

2026-11-14 补充已有管理员 Key 发布接入：TOKEN / KEY 与直接 S3 配置冲突会在联网前失败；Key 只用于指定管理员 origin 的 `x-api-key`，R2 上传、公网 HEAD / Range / 完整 GET 和本地发布计划均不包含它。401 / 403 不回退到其他鉴权，实际申请 PUT URL 时的 step-up 403 也会停止且零存储写入。`pnpm test:milocode-updates` 共 31 / 31 通过（30 项协议 / 发布用例和包含 13 场景的退出屏障工程脚本）。

`node --test packages/ui/test/browser/manual-review/pending/milocode-manual-update.test.mjs`：16 / 16 通过。范围内 oxlint 为 0 errors / 0 warnings，`git diff --check` 通过。根类型检查、整仓 lint、应用构建和真实安装升级由主集成任务执行，不能用以上工具测试替代。

用户已报告创建独立桶 `milocode-releases` 与下载域名 `download.editor.vip`；本子任务尚未验证公网对象或上传。Sub2API 管理设置接入发布存储并复用现有 S3 连接/凭据，发布工具已按 `sub2api/docs/DESKTOP_RELEASES.md` 的接口合同消费后台配置并申请临时 PUT 链接直传 R2。正式 Windows / Mac 签名密钥已生成；独立加密备份尚未完成。本子任务没有创建桶、修改 DNS、生成正式密钥或上传任何安装包。
