// MiloCode 的平台更新桥：Sparkle 拥有下载/安装事务，Electron Main 拥有任务退出准入。
// 这里只使用公开 Sparkle API，不替换应用、不执行安装脚本，也不读取发布私钥。
#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>
#include <node_api.h>

static void Throw(napi_env env, const char *message) {
  napi_throw_error(env, nullptr, message);
}

static napi_value Undefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

@interface MiloSparkleBridge : NSObject <SPUUpdaterDelegate, SPUStandardUserDriverDelegate> {
 @public
  napi_env _env;
  napi_ref _callback;
  napi_async_context _asyncContext;
}
@property(nonatomic, strong) SPUStandardUpdaterController *controller;
@property(nonatomic, copy) NSString *feedURL;
@property(nonatomic, copy) NSString *releasePathPrefix;
@property(nonatomic, copy) NSString *version;
@property(nonatomic, copy) NSString *requestId;
@property(nonatomic, copy) void (^installHandler)(void);
@property(nonatomic) BOOL approved;
@property(nonatomic) BOOL disposed;
- (void)emit:(NSString *)kind message:(NSString *)message;
- (void)dispose;
@end

static MiloSparkleBridge *bridge;

@implementation MiloSparkleBridge
- (void)emit:(NSString *)kind message:(NSString *)message {
  if (self.disposed || !_callback) return;
  // Sparkle 的公开 UI / delegate API 都在 Cocoa 主线程执行；禁止跨线程调用 Node。
  if (![NSThread isMainThread]) return;
  napi_handle_scope scope;
  if (napi_open_handle_scope(_env, &scope) != napi_ok) return;
  napi_value event, callback, global, value, result;
  napi_create_object(_env, &event);
  NSDictionary *fields = @{
    @"kind": kind,
    @"version": self.version ?: @"",
    @"requestId": self.requestId ?: @"",
    @"message": message ?: @""
  };
  for (NSString *key in fields) {
    NSString *text = fields[key];
    if (text.length == 0 && ![key isEqualToString:@"kind"]) continue;
    napi_create_string_utf8(_env, text.UTF8String, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(_env, event, key.UTF8String, value);
  }
  napi_get_reference_value(_env, _callback, &callback);
  napi_get_global(_env, &global);
  // make_callback 给来自 Cocoa runloop 的回调提供正确的 Node async 上下文。
  napi_status status = napi_make_callback(_env, _asyncContext, global, callback, 1, &event, &result);
  if (status == napi_pending_exception) {
    napi_value error;
    napi_get_and_clear_last_exception(_env, &error);
    napi_fatal_exception(_env, error);
  }
  napi_close_handle_scope(_env, scope);
}

- (void)dispose {
  if (self.disposed) return;
  self.disposed = YES;
  self.controller.updater.automaticallyChecksForUpdates = NO;
  self.installHandler = nil;
  self.requestId = nil;
  self.controller = nil;
  if (_callback) {
    napi_delete_reference(_env, _callback);
    _callback = nullptr;
  }
  if (_asyncContext) {
    napi_async_destroy(_env, _asyncContext);
    _asyncContext = nullptr;
  }
}

- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater {
  // 正式更新源来自包内 Info.plist，而不是可修改的用户默认项或启动参数。
  return self.feedURL;
}
- (NSSet<NSString *> *)allowedChannelsForUpdater:(SPUUpdater *)updater { return [NSSet set]; }
- (NSArray *)feedParametersForUpdater:(SPUUpdater *)updater sendingSystemProfile:(BOOL)sending {
  return @[];
}
- (NSArray<NSString *> *)allowedSystemProfileKeysForUpdater:(SPUUpdater *)updater { return @[]; }
- (BOOL)updaterShouldPromptForPermissionToCheckForUpdates:(SPUUpdater *)updater { return NO; }

- (BOOL)updater:(SPUUpdater *)updater mayPerformUpdateCheck:(SPUUpdateCheck)check error:(NSError **)error {
  [self emit:@"checking" message:nil];
  return !self.disposed;
}
- (BOOL)updater:(SPUUpdater *)updater shouldProceedWithUpdate:(SUAppcastItem *)item
    updateCheck:(SPUUpdateCheck)check error:(NSError **)error {
  NSURL *feed = [NSURL URLWithString:self.feedURL];
  NSURL *file = item.fileURL;
  BOOL sameOrigin = [file.scheme isEqualToString:feed.scheme] &&
      [file.host isEqualToString:feed.host] &&
      ((file.port == nil && feed.port == nil) || [file.port isEqual:feed.port]);
  BOOL allowed = sameOrigin && [item.installationType isEqualToString:@"application"] &&
      file.user.length == 0 && file.password.length == 0 && file.query.length == 0 && file.fragment.length == 0 &&
      [file.URLByStandardizingPath.path hasPrefix:self.releasePathPrefix] &&
      !item.isInformationOnlyUpdate && !item.isDeltaUpdate && item.deltaUpdates.count == 0 &&
      [file.pathExtension.lowercaseString isEqualToString:@"zip"];
  if (!allowed && error) {
    *error = [NSError errorWithDomain:@"MiloCode.Update" code:1 userInfo:@{
      NSLocalizedDescriptionKey: @"更新文件必须来自固定软件发布目录，且必须为完整应用 ZIP 更新包。"
    }];
  }
  return allowed;
}
- (void)updater:(SPUUpdater *)updater didFindValidUpdate:(SUAppcastItem *)item {
  self.version = item.versionString;
  [self emit:@"update-available" message:nil];
}
- (void)updaterDidNotFindUpdate:(SPUUpdater *)updater error:(NSError *)error {
  self.version = nil;
  [self emit:@"not-available" message:nil];
}
- (void)updater:(SPUUpdater *)updater willDownloadUpdate:(SUAppcastItem *)item
    withRequest:(NSMutableURLRequest *)request {
  self.version = item.versionString;
  [self emit:@"downloading" message:nil];
}
- (void)updater:(SPUUpdater *)updater didDownloadUpdate:(SUAppcastItem *)item {
  self.version = item.versionString;
  [self emit:@"downloaded" message:nil];
}
- (void)userDidCancelDownload:(SPUUpdater *)updater {
  [self emit:@"update-available" message:nil];
}
- (BOOL)updater:(SPUUpdater *)updater shouldPostponeRelaunchForUpdate:(SUAppcastItem *)item
    untilInvokingBlock:(void (^)(void))handler {
  self.version = item.versionString;
  self.approved = NO;
  self.requestId = NSUUID.UUID.UUIDString;
  self.installHandler = handler;
  [self emit:@"install-request" message:nil];
  return YES;
}
- (BOOL)updaterShouldRelaunchApplication:(SPUUpdater *)updater {
  // Sparkle 在延期后不会再次调用 postpone。没有 Main 准入时不能让第二次原生重试越过它。
  return !self.disposed && (self.installHandler == nil || self.approved);
}
- (void)updaterWillRelaunchApplication:(SPUUpdater *)updater {
  [self emit:@"installing" message:nil];
}
- (void)updater:(SPUUpdater *)updater didAbortWithError:(NSError *)error {
  self.installHandler = nil;
  self.requestId = nil;
  self.approved = NO;
  if (error.code == SUNoUpdateError) return;
  [self emit:@"error" message:error.localizedDescription];
}
- (void)updater:(SPUUpdater *)updater didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check
    error:(NSError *)error {
  if (error == nil && self.installHandler == nil) [self emit:@"idle" message:nil];
}
@end

static bool MainThread(napi_env env) {
  if ([NSThread isMainThread]) return true;
  Throw(env, "MiloCode Sparkle must be used on the Electron main thread");
  return false;
}

static napi_value Start(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  if (bridge != nil) { Throw(env, "MiloCode Sparkle is already started"); return nullptr; }
  napi_value callback;
  size_t count = 1;
  napi_get_cb_info(env, info, &count, &callback, nullptr, nullptr);
  napi_valuetype type;
  if (count != 1 || napi_typeof(env, callback, &type) != napi_ok || type != napi_function) {
    Throw(env, "start requires an event callback"); return nullptr;
  }
  NSDictionary *plist = NSBundle.mainBundle.infoDictionary;
  NSString *feedURL = plist[@"SUFeedURL"];
  NSString *publicKey = plist[@"SUPublicEDKey"];
  NSURL *feed = [feedURL isKindOfClass:NSString.class] ? [NSURL URLWithString:feedURL] : nil;
  NSString *releaseBaseString = plist[@"MiloCodeReleaseBaseURL"];
  NSURL *releaseBase = [releaseBaseString isKindOfClass:NSString.class] ? [NSURL URLWithString:releaseBaseString] : nil;
  BOOL testLoopback = NO;
#ifdef MILOCODE_SPARKLE_ENGINEERING_TEST
  testLoopback = [plist[@"MiloCodeUpdateTestFixture"] boolValue] &&
      [feed.scheme isEqualToString:@"http"] && [@[@"127.0.0.1", @"localhost"] containsObject:feed.host];
#endif
  NSData *keyData = [publicKey isKindOfClass:NSString.class]
      ? [[NSData alloc] initWithBase64EncodedString:publicKey options:0] : nil;
  BOOL sameOrigin = [releaseBase.scheme isEqualToString:feed.scheme] &&
      [releaseBase.host isEqualToString:feed.host] &&
      ((releaseBase.port == nil && feed.port == nil) || [releaseBase.port isEqual:feed.port]);
  NSNumber *signedFeedExpiration = plist[@"SUSignedFeedFailureExpirationInterval"];
  if ((!testLoopback && ![feed.scheme isEqualToString:@"https"]) || feed.host.length == 0 ||
      feed.user.length > 0 || feed.password.length > 0 || feed.query.length > 0 || feed.fragment.length > 0 ||
      !sameOrigin || releaseBase.user.length > 0 || releaseBase.password.length > 0 ||
      releaseBase.query.length > 0 || releaseBase.fragment.length > 0 || keyData.length != 32 ||
      ![signedFeedExpiration isKindOfClass:NSNumber.class] || signedFeedExpiration.doubleValue != 0 ||
      ![plist[@"SURequireSignedFeed"] boolValue] || ![plist[@"SUVerifyUpdateBeforeExtraction"] boolValue] ||
      [plist[@"SUAllowsAutomaticUpdates"] boolValue] || [plist[@"SUAutomaticallyUpdate"] boolValue]) {
    Throw(env, "MiloCode Sparkle requires a trusted HTTPS feed, public key, signed feed, and manual installation");
    return nullptr;
  }
  bridge = [MiloSparkleBridge new];
  bridge->_env = env;
  bridge.feedURL = feedURL;
  NSString *basePath = releaseBase.URLByStandardizingPath.path;
  if (![basePath hasSuffix:@"/"]) basePath = [basePath stringByAppendingString:@"/"];
  bridge.releasePathPrefix = [basePath stringByAppendingString:@"releases/"];
  napi_create_reference(env, callback, 1, &bridge->_callback);
  napi_value resource, name;
  napi_create_object(env, &resource);
  napi_create_string_utf8(env, "MiloCode.Sparkle", NAPI_AUTO_LENGTH, &name);
  napi_async_init(env, resource, name, &bridge->_asyncContext);
  bridge.controller = [[SPUStandardUpdaterController alloc]
      initWithStartingUpdater:NO updaterDelegate:bridge userDriverDelegate:bridge];
  SPUUpdater *updater = bridge.controller.updater;
  updater.automaticallyDownloadsUpdates = NO;
  updater.sendsSystemProfile = NO;
  [updater clearFeedURLFromUserDefaults];
  NSError *error;
  if (![updater startUpdater:&error]) {
    NSString *message = error.localizedDescription ?: @"Sparkle failed to initialize";
    [bridge dispose]; bridge = nil;
    Throw(env, message.UTF8String); return nullptr;
  }
  return Undefined(env);
}

static napi_value Check(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  if (bridge == nil || bridge.disposed) { Throw(env, "MiloCode Sparkle is not started"); return nullptr; }
  // 取消任务中断确认后保留延期事务，再次点菜单可重新请求 Main 准入，而不是启动第二个更新。
  if (bridge.installHandler != nil) [bridge emit:@"install-request" message:nil];
  else [bridge.controller checkForUpdates:nil];
  return Undefined(env);
}

static napi_value ResolveInstall(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  napi_value args[2]; size_t count = 2; bool allow = false;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  char id[128]; size_t length;
  if (count != 2 || napi_get_value_string_utf8(env, args[0], id, sizeof(id), &length) != napi_ok ||
      napi_get_value_bool(env, args[1], &allow) != napi_ok) {
    Throw(env, "resolveInstall requires requestId and approval"); return nullptr;
  }
  NSString *request = [[NSString alloc] initWithBytes:id length:length encoding:NSUTF8StringEncoding];
  if (bridge == nil || bridge.installHandler == nil || ![bridge.requestId isEqualToString:request]) {
    Throw(env, "MiloCode Sparkle installation request is stale"); return nullptr;
  }
  if (!allow) { [bridge emit:@"downloaded" message:nil]; return Undefined(env); }
  void (^handler)(void) = bridge.installHandler;
  bridge.approved = YES;
  bridge.installHandler = nil;
  bridge.requestId = nil;
  // 离开 JS 回调栈后恢复 Cocoa 安装事务；此 block 只消费一次。
  dispatch_async(dispatch_get_main_queue(), handler);
  return Undefined(env);
}

static napi_value Dispose(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  [bridge dispose]; bridge = nil;
  return Undefined(env);
}

#ifdef MILOCODE_SPARKLE_ENGINEERING_TEST
// 仅隔离工程构建包含此驱动：经 AppKit 的真实默认按钮执行用户动作，无系统辅助功能授权。
static napi_value TestClickDefaultButton(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  bool clicked = false;
  for (NSWindow *window in NSApp.orderedWindows) {
    NSButton *button = (NSButton *)window.defaultButtonCell.controlView;
    if (window.isVisible && [button isKindOfClass:NSButton.class] && button.isEnabled) {
      [button performClick:nil]; clicked = true; break;
    }
  }
  napi_value result;
  napi_get_boolean(env, clicked, &result);
  return result;
}
#endif

static void Cleanup(void *) { [bridge dispose]; bridge = nil; }
static napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"checkForUpdates", nullptr, Check, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"resolveInstall", nullptr, ResolveInstall, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"dispose", nullptr, Dispose, nullptr, nullptr, nullptr, napi_default, nullptr},
#ifdef MILOCODE_SPARKLE_ENGINEERING_TEST
    {"testClickDefaultButton", nullptr, TestClickDefaultButton, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
  };
  napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
