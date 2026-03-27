import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Defer service worker registration until after first paint
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    setTimeout(() => {
      navigator.serviceWorker.register("/sw.js").then((registration) => {
        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              if (confirm("有新版本可用，是否立即更新？")) {
                newWorker.postMessage({ type: "SKIP_WAITING" });
                window.location.reload();
              }
            }
          });
        });
      }).catch((err) => {
        console.warn("Service worker registration failed:", err);
      });
    }, 1000);
  });
}
