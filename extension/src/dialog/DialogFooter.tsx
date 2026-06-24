import React from "react";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useIsMobile } from "../hooks/useIsMobile";
import { EnvBadge } from "./EnvBadge";

const DISCLAIMER = "本功能由第三方開發，非 Readmoo 官方提供";
// Neutral mobile positioning. Avoids any sync-capability claim because Firefox
// Android scraper compatibility with Readmoo's mobile DOM is unverified.
const MOBILE_NOTE = "行動版：墨家書櫃家庭書櫃的瀏覽介面";

const mobileNoteStyle: React.CSSProperties = {
  borderBottom: "1px solid #e2e8f0",
  padding: "6px 12px",
  textAlign: "center",
  fontSize: 11,
  color: "#94a3b8",
  lineHeight: 1.5,
  flexShrink: 0,
};
const VERSION = `v${typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.1.0"}`;

const footerBase: React.CSSProperties = {
  borderTop: "1px solid #e2e8f0",
  padding: "8px 12px",
  textAlign: "center",
  fontSize: 12,
  color: "#94a3b8",
  lineHeight: 1.6,
  flexShrink: 0,
};

const footerWide: React.CSSProperties = {
  ...footerBase,
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "space-between",
};

export function DialogFooter() {
  const isWide = useMediaQuery("(min-width: 576px)");
  const isMobile = useIsMobile();

  return (
    <>
      {isMobile && (
        <p data-testid="dialog-mobile-note" style={mobileNoteStyle}>
          {MOBILE_NOTE}
        </p>
      )}
      <footer data-testid="dialog-footer" style={isWide ? footerWide : footerBase}>
        <div>{DISCLAIMER}</div>
        <div style={isWide ? undefined : { marginTop: 2 }}>
          墨家書櫃 {VERSION}
          <span style={{ marginLeft: 4 }}><EnvBadge /></span>
        </div>
      </footer>
    </>
  );
}
