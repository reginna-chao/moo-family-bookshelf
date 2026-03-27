import React from "react";
import { reportLinks } from "../config/links";

export interface DialogFooterProps {
  /** When true, only shows disclaimer and version (no report links). */
  minimal?: boolean;
}

const DISCLAIMER = "本功能由第三方開發，非 Readmoo 官方提供";
const VERSION = `v${typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.1.0"}`;

const footerStyle: React.CSSProperties = {
  borderTop: "1px solid #e2e8f0",
  padding: "8px 12px",
  textAlign: "center",
  fontSize: 11,
  color: "#94a3b8",
  lineHeight: 1.6,
};

const linkStyle: React.CSSProperties = {
  color: "#94a3b8",
  textDecoration: "none",
};

export function DialogFooter({ minimal = false }: DialogFooterProps) {
  return (
    <footer data-testid="dialog-footer" style={footerStyle}>
      <div>{DISCLAIMER}</div>
      <div style={{ marginTop: 2 }}>
        {VERSION}
        {!minimal && (
          <>
            {" — "}
            {reportLinks.map((link, index) => (
              <React.Fragment key={link.name}>
                {index > 0 && " | "}
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={linkStyle}
                  title={link.name}
                >
                  {link.name}
                </a>
              </React.Fragment>
            ))}
          </>
        )}
      </div>
    </footer>
  );
}
