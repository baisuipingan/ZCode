// 复用真实启动组件，只将 React 接管时机交给浏览器验收；不连接账户或生产服务。
import { useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { RootStartupLoading } from "@/root/RootStartupLoading.js";
import "@/styles.css";

function StartupFixture() {
  useLayoutEffect(() => {
    window.dispatchEvent(new Event("zcode-react-startup-ready"));
  }, []);
  return <RootStartupLoading label="MiloCode startup fixture" />;
}

Object.assign(window, {
  renderStartupFixture() {
    createRoot(document.getElementById("root")!).render(<StartupFixture />);
  },
});
