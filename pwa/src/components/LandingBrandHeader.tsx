import { getAppEnv } from "@/utils/appEnv";

const APP_ENV = getAppEnv();

/**
 * The login screen's icon, title (with the LOCAL / DEV badge off prod) and
 * tagline. Renders a fragment: the page keeps the wrapping `<div>`.
 */
export function LandingBrandHeader() {
  return (
    <>
      <img
        src={APP_ENV !== "prod" ? "/dev/icon.svg" : "/icon.svg"}
        alt="墨家書櫃"
        className="w-16 h-16 rounded-2xl mb-4"
      />
      <h1 className="text-3xl font-bold text-gray-900 mb-2 flex items-center gap-2">
        墨家書櫃
        {APP_ENV !== "prod" && (
          <span
            className={`text-xs font-bold px-2 py-0.5 rounded-full ${
              APP_ENV === "local"
                ? "bg-red-100 text-red-700 border border-red-300"
                : "bg-blue-100 text-blue-700 border border-blue-300"
            }`}
          >
            {APP_ENV === "local" ? "LOCAL" : "DEV"}
          </span>
        )}
      </h1>
      <p className="text-gray-500 mb-8 text-center">
        家庭共享書櫃 — 與家人分享你的讀墨藏書
      </p>
    </>
  );
}
