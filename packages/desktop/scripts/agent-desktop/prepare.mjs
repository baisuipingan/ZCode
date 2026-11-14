#!/usr/bin/env node
import { getTargetPlatform } from "../target-platform.mjs";
import { prepareAgentDesktopResources } from "./assets.mjs";

const target = getTargetPlatform();
const result = await prepareAgentDesktopResources({ platform: target.os, arch: target.arch });
console.log(
  result
    ? `[agent-desktop] verified v${result.version} ${result.key}: ${result.binaryPath}`
    : `[agent-desktop] unavailable for ${target.key}; not included in this build`,
);
