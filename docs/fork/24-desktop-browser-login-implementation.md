# 浏览器登录实施与验证

2026-11-13；实施合同见 [23](23-desktop-browser-login-spec.md)。本轮落地桌面端系统浏览器授权，配合 Sub2API 的 `/desktop/authorize` 页面和 `/api/v1/desktop/auth/authorize`、`/api/v1/desktop/auth/token` 接口。没有在 ZCode 仓库提交、构建安装包或部署生产，也没有变更已有推理 Key、模型执行和积分扣费的合同。

## 实际改动

- `packages/services/src/brand-account/contract.ts` 增加开始/取消浏览器登录命令、`browserLogin` 脱敏状态和取消/过期错误码。旧密码/2FA服务命令保留兼容，主界面不再使用。
- `browserLogin.ts` 只在本机 Host 内存持有 state、S256 verifier、临时监听和期限。两阶段 RPC 先返回授权 URL，等待通过快照发布，不占用一个五分钟长 RPC。回调限制到 `127.0.0.1`、精确 Host、原始 `/callback` 路径和 GET，拒绝 Origin、未知/重复参数及错误 state；合法回调只消费一次。响应完成或断连都经同一个守卫终结操作。
- `service.ts` 沿用现有加密会话、跨进程锁、epoch 和 action generation。开始授权先写新 epoch 墓碑后释放锁；回调完成再拿锁换证保存。取消、退出、另一窗口换号、dispose 均拒绝旧结果。已签发但无法提交的 refresh 尽力服务端撤销，未知换证结果不自动重放。
- `BrandAccountLogin.tsx` 用现有 Button、窗口控制与平台 `openExternal()` 打开系统浏览器，提供明确等待/取消。网页处理账号密码、captcha、2FA和授权；客户端不接触密码。打开浏览器失败取消本机尝试。中英文文案同步，充值网站入口改用订单提示。
- `paymentActions.ts`、`initialSnapshot.ts` 和 `projections.ts` 的小范围提取用于保持单源文件不超过800行；订单和账户状态仍由原服务拥有，没有新增账户、余额、模型或队列 owner。

## 已完成验证

以下全部连接本地合成网站/服务；没有生产账号、付费模型或真实支付请求。

| 验证                                                                | 结果   | 主要覆盖                                                                                                                                                                           |
| ------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brand-browser-login.test.ts`                                       | 7通过  | 网站启用captcha仍可授权、S256、token落盘加密、重复开始、单次换证、错误state/重复参数/方法/Host/Origin/原始路径、拒绝、取消、退出、完成后取消不误退出、兄弟Host、在途换证取消与撤销 |
| `brand-account-runtime.test.ts`                                     | 9通过  | 原有账户余额、双Host refresh旋转、换号、订单结算、支付币种、2FA兼容、OS加密失败、网络未知结果、429恢复                                                                             |
| `brand-managed-runtime.test.ts` + `brand-account-admission.test.ts` | 33通过 | 原有托管推理与CLI入场、跨账户/epoch、刷新、模型目录和消费精度回归                                                                                                                  |
| `brand-browser-login.test.mjs`                                      | 9通过  | 实际React/组件/样式、390/1200宽、中英、明暗主题、无密码输入、等待/取消、打开浏览器失败收尾、无横向溢出或页面异常                                                                   |
| `pnpm typecheck`                                                    | 通过   | 全项目TypeScript，含更新后的原生E2E辅助代码                                                                                                                                        |
| `pnpm architecture:check --changed`                                 | 通过   | base `merge-base origin/main`；违规0，baseline0，new0                                                                                                                              |
| `pnpm lint`                                                         | 0错误  | 存量警告仍存在，相关变更文件另做定向检查                                                                                                                                           |

运行时回归合计49通过；浏览器UI另外9通过。浏览器截图位于 `packages/desktop/.e2e-artifacts/brand-browser-login/`，已查看窄屏中文浅色和桌面英文深色。

执行命令：

```sh
pnpm exec tsx --test packages/desktop/test/e2e/brand-account/manual-review/pending/brand-account-runtime.test.ts packages/desktop/test/e2e/brand-account/manual-review/pending/brand-browser-login.test.ts packages/desktop/test/e2e/brand-account/manual-review/pending/brand-managed-runtime.test.ts packages/desktop/test/e2e/brand-account/manual-review/pending/brand-account-admission.test.ts
node --test packages/ui/test/browser/manual-review/pending/brand-browser-login.test.mjs
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

本机工具使用 Node `/Users/patrick/.nvm/versions/node/v24.19.0/bin/node`；没有重新安装依赖或做完整构建。

## 验证边界与上线顺序

原生钱包、托管推理、模型刷新UI脚本已改为合成授权页，复用真实 Host loopback/PKCE/换证，不再填写旧密码输入框；本轮只完成其类型检查，没有重新构建 Electron 或执行这三套原生脚本。

先部署支持授权页和换证接口的 Sub2API，再发布桌面版本。旧客户端服务方法仍兼容。正式 Windows/macOS 包的系统浏览器跳回、OS安全存储、真实网站登录/captcha/2FA 和跨仓库生产授权须另外验收；本地fixture通过不代表这些已完成。

这次授权复用网站现有 access/refresh 会话，仍不是设备专用推理 token。客户端退出会撤销自己持有的 refresh 并清除本机状态，不宣称能撤销用户普通共享 Agent Key，也不增加独立积分账本。
