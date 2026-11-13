# MiloCode 更新发布信任

此适配模块只负责签名清单、受信任资源地址和安装包完整性。不拥有菜单、更新事务、账号、任务退出或安装器进程。Electron Main / 既有 updater 仍是更新事务和安装准入所有者。

发布工具使用 Node Ed25519 对原始 JSON payload 签名，客户端内嵌 SPKI 公钥；不能从网络接受新公钥或通过无签名回退解除校验。这里的发布签名不等于 Windows Authenticode。

`MiloCodeSignedUpdateProvider` 从固定 HTTPS manifest 获取有界响应，先验签再解析，返回附签名原文的 `UpdateInfo`。只接受 app.milo.code / win32-x64 / stable / 单个完整 NSIS EXE；版本为真正 major.minor.patch，不引入 web installer 或任意文件执行。

`releaseBaseUrl` 是以 `/` 结尾的完整发布根目录（即构建时 `MILOCODE_UPDATE_BASE_URL`），同时容纳 `stable/win32-x64/latest.json` 和 `releases/<version>/win32-x64/...exe`，不是只指 `releases/` 子目录。发布工具为每个版本生成不可覆盖的资源路径，只原子更新 stable 指针。资源 URL 必须在内嵌 releaseBaseUrl 的同 origin / 路径内，不接受用户信息、query、fragment、编码路径穿越。HTTP 环回只供显式未打包测试策略使用，装配方必须拒绝正式包开启。

Main 在当前更新事务内保留 `milocodeSignedEnvelope` 并冻结版本；版本说明的持久化不代表安装授权，冷启动必须重新获取签名清单并重建下载上下文。下载完成、缓存命中、安装前调用 `verifyMiloCodeUpdateArtifact` 重验公钥、payload、版本、真实文件大小和 SHA512。不能只依赖 NSIS 自定义签名 hook（无 publisherName 时上游会跳过）。错误和缺失上下文均拒绝，不能清数据或自动改用任意安装包。

时序：固定策略 → 获取签名原文 → 验签及解析 → 同一 UpdateInfo 冻结下载目标 → 文件整包验证 → Main 任务退出屏障 → 安装前同一冻结目标重验 → 既有 NSIS 安装。迟到检查不得改写正在安装的目标。首期禁止差分下载和 web installer，只下载并校验签名清单中的完整安装包。

工程验证使用临时 Ed25519 密钥和测试文件，覆盖篡改清单、未知 keyId、错产品/平台、URL 越界、错误版本/大小、缓存文件替换和损坏；不访问真实发布密钥或执行安装包。
