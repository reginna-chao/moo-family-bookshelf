/** Entry of options.html (opened from the toolbar icon or `runtime.openOptionsPage`); never framed
 *  by a Readmoo page, so it is not a web-accessible resource. */
import React from "react";
import { createRoot } from "react-dom/client";
// Raw string, like the Dialog's own mount: the tokens are declared on `:root` too.
import cssText from "../dialog/styles.css?raw";
import { OptionsPage } from "./OptionsPage";

// styles.css sets font / colour on `:host` only, which a plain document lacks: restate them on body.
// `.moo-options` enlarges the switch label and hint text on this page only; the Dialog keeps its sizes.
const BASE_CSS = `body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: var(--moo-text); line-height: normal; }
.moo-options .moo-switch { font-size: 16px; }
.moo-options .moo-settings__hint, .moo-options .moo-settings__error-text { font-size: 14px; }
.moo-options__status { display: inline-flex; align-items: center; gap: 4px; margin: 6px 0; padding: 2px 10px; border-radius: 999px; font-size: 13px; background: #f3f4f6; color: #4b5563; }
.moo-options__status--granted { background: #ecfdf5; color: #047857; }`;

function injectStyles(): void {
  for (const text of [cssText, BASE_CSS]) {
    const style = document.createElement("style");
    style.textContent = text;
    document.head.appendChild(style);
  }
}

const container = document.getElementById("root");
if (container) {
  injectStyles();
  createRoot(container).render(
    <React.StrictMode>
      <OptionsPage />
    </React.StrictMode>,
  );
}
