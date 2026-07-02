import React from "react";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { EnvBadge } from "./EnvBadge";

const DISCLAIMER = "本功能由第三方開發，非 Readmoo 官方提供";

const VERSION = `v${typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.1.0"}`;

export function DialogFooter() {
  const isWide = useMediaQuery("(min-width: 576px)");

  const footerClass = isWide ? "moo-footer moo-footer--wide" : "moo-footer";

  return (
    <footer data-testid="dialog-footer" className={footerClass}>
      <div>{DISCLAIMER}</div>
      <div className={isWide ? undefined : "moo-footer__version"}>
        墨家書櫃 {VERSION}
        <span className="moo-footer__env">
          <EnvBadge />
        </span>
      </div>
    </footer>
  );
}
