import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import {
  useDynamicWorkflowAvailabilityLoader,
  useDynamicWorkflowUserModeSync,
} from "@/hooks/useDynamicWorkflowAvailability.js";

/** 原官方灰度配置仅由官方 edition 挂载，品牌模式不启动取数。 */
export function OfficialDynamicWorkflowSync() {
  const services = useServices();
  const { settings } = useSettings();
  useDynamicWorkflowAvailabilityLoader(services.codingPlanSubscriptionService);
  useDynamicWorkflowUserModeSync({
    settingsLoaded: Boolean(settings),
    userMode: settings?.dynamicWorkflowMode,
    zcodeAgentService: services.zcodeAgentService,
    codingPlanSubscriptionService: services.codingPlanSubscriptionService,
  });
  return null;
}
