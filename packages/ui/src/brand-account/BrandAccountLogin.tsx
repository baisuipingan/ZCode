import { useEffect, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBrandAccount } from "./context.js";
import { brandErrorMessageId, brandWebsiteUrl } from "./presentation.js";

export function BrandAccountLogin({
  onBrowse,
  variant = "standalone",
}: {
  onBrowse?: () => void;
  variant?: "standalone" | "embedded";
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { service, snapshot, initializationFailed, initialize } = useBrandAccount();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settings = snapshot?.settings;
  const waiting = !snapshot || snapshot.status === "initializing";
  const authorizing = snapshot?.browserLogin.status === "waiting";
  const loadFailed = initializationFailed || Boolean(!settings && snapshot?.error);
  const text = (id: string) => intl.formatMessage({ id: `brandAccount.${id}` });
  const shownError = error ?? (snapshot?.error ? brandErrorMessageId(snapshot.error) : null);

  useEffect(() => {
    setError(null);
  }, [snapshot?.accountEpoch]);
  const start = async () => {
    if (!service || pending || waiting || authorizing) return;
    setPending(true);
    setError(null);
    try {
      const login = await service.startBrowserLogin();
      await platform.openExternal(login.authorizationUrl);
    } catch (cause) {
      await service.cancelBrowserLogin().catch(() => {});
      setError(brandErrorMessageId(cause));
    } finally {
      setPending(false);
    }
  };
  const cancel = async () => {
    if (pending) return false;
    if (!service) return true;
    setPending(true);
    try {
      await service.cancelBrowserLogin();
      return true;
    } catch (cause) {
      setError(brandErrorMessageId(cause));
      return false;
    } finally {
      setPending(false);
    }
  };
  const openWebsite = (path: string) => {
    const url = brandWebsiteUrl(settings?.siteUrl, path);
    if (url) void platform.openExternal(url);
  };

  const embedded = variant === "embedded";
  const Heading = embedded ? "h3" : "h1";
  const panel = (
    <section
      className={
        embedded
          ? "w-full space-y-6 rounded-xl border border-border bg-card p-4 sm:p-6"
          : "my-auto w-full max-w-sm space-y-6 rounded-2xl border border-popover-border bg-popover p-6 shadow-md [app-region:no-drag] sm:p-8"
      }
    >
      <header className="space-y-2">
        <p className="text-ui-caption font-medium text-brand">
          {settings?.siteName || "MiloRouter"}
        </p>
        <Heading className="text-ui-xl font-semibold">{text("login.title")}</Heading>
        <p className="text-ui-base text-foreground-subtle">{text("login.browserDescription")}</p>
      </header>
      {shownError ? (
        // 初始化失败会切换内容分支，具体安全错误必须保持可见，不能被通用加载提示遮掉。
        <p role="alert" className="text-ui-caption text-destructive">
          {intl.formatMessage({ id: shownError })}
        </p>
      ) : null}
      {waiting || loadFailed ? (
        <div className="space-y-3 text-ui-base" role="status">
          {loadFailed ? (
            <>
              {!shownError ? <p>{text("login.loadFailed")}</p> : null}
              <Button onClick={() => void initialize()}>
                <RefreshCw className="size-4" />
                {text("retry")}
              </Button>
            </>
          ) : (
            <p className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              {text("loading")}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-ui-caption text-foreground-subtle">
            {text(authorizing ? "login.browserWaiting" : "login.browserSecurity")}
          </p>
          {snapshot?.status === "expired" ? (
            <p className="text-ui-caption text-warning" role="status">
              {text("error.expired")}
            </p>
          ) : null}
          <Button
            type="button"
            data-testid="brand-account-submit"
            className="w-full"
            disabled={pending || authorizing || !service}
            onClick={() => void start()}
          >
            {pending || authorizing ? (
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <ExternalLink className="size-4" />
            )}
            {text(authorizing ? "login.browserPending" : "login.browserSubmit")}
          </Button>
          {authorizing ? (
            <Button
              type="button"
              variant="outline"
              className="w-full"
              data-testid="brand-account-cancel-browser"
              disabled={pending}
              onClick={() => void cancel()}
            >
              {text("login.browserCancel")}
            </Button>
          ) : null}
          <div className="flex justify-between gap-2 text-ui-caption">
            {settings?.registrationEnabled ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => openWebsite("/register")}
              >
                {text("login.register")}
              </Button>
            ) : null}
            {settings?.passwordResetEnabled ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => openWebsite("/forgot-password")}
              >
                {text("login.forgotPassword")}
              </Button>
            ) : null}
          </div>
        </div>
      )}
      {onBrowse ? (
        <Button
          variant="ghost"
          className="w-full"
          disabled={pending}
          onClick={() => {
            void cancel().then((accepted) => {
              if (accepted) onBrowse();
            });
          }}
        >
          {text("login.browse")}
        </Button>
      ) : null}
    </section>
  );
  // 设置页已有滚动容器和桌面窗控；只共享登录内容，不能嵌入第二层全屏外壳。
  if (embedded)
    return (
      <div className="min-w-0" data-testid="brand-account-login" data-layout="embedded">
        {panel}
      </div>
    );
  return (
    <main
      className="relative flex h-full min-h-dvh items-center justify-center overflow-y-auto bg-background p-6 text-foreground"
      data-testid="brand-account-login"
      data-layout="standalone"
    >
      <div className="pointer-events-none absolute left-0 top-0 right-0 h-12 [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />
      {panel}
    </main>
  );
}
