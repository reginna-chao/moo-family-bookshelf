import { getReportLinks } from "moo-family-bookshelf-shared/config/links";

const reportLinks = getReportLinks({ appVersion: __APP_VERSION__ });

/** Settings-page footer: version, third-party disclaimer and report links. */
export function SettingsAboutSection() {
  return (
    <section className="pt-6 mt-6 border-t border-gray-200 text-center">
      <p className="text-xs text-gray-400">墨家書櫃 v{__APP_VERSION__}</p>
      <p className="text-xs text-gray-300 mt-1">
        本程式為第三方開發，非 Readmoo 讀墨官方提供。
      </p>
      <div className="flex justify-center gap-3 mt-2">
        {reportLinks.map((link) => (
          <a
            key={link.name}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-300 hover:text-gray-500 transition-colors"
            title={link.name}
          >
            <svg
              aria-hidden="true"
              role="img"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="currentColor"
            >
              <path d={link.svgPath} />
            </svg>
          </a>
        ))}
      </div>
    </section>
  );
}
