/**
 * brand-account 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { IBrandAccountService } from "./contract.js";

export async function exampleBrandAccount(service: IBrandAccountService) {
  await service.initialize();
  return service.refreshBalance();
}
