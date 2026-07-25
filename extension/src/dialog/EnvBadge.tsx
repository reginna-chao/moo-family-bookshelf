import React from "react";
import { getAppEnv } from "../utils/appEnv";
import type { AppEnv } from "../utils/appEnv";

const ENV_CONFIG: Record<
  Exclude<AppEnv, "prod">,
  { label: string; bg: string; color: string; border: string }
> = {
  local: {
    label: "LOCAL",
    bg: "#fedbdb",
    color: "#d81d1d",
    border: "1px solid #fd9393",
  },
  dev: {
    label: "DEV",
    bg: "#dbeafe",
    color: "#1d4ed8",
    border: "1px solid #93c5fd",
  },
};

export function EnvBadge() {
  const env = getAppEnv();
  if (env === "prod") return null;

  const config = ENV_CONFIG[env];

  return (
    <span
      data-testid="env-badge"
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.5,
        lineHeight: "18px",
        background: config.bg,
        color: config.color,
        border: config.border,
        userSelect: "none",
      }}
    >
      {config.label}
    </span>
  );
}
