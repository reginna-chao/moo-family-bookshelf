import { getReportLinks } from "moo-family-bookshelf-shared/config/links";

const reportLinks = getReportLinks({ appVersion: __APP_VERSION__ });

// Map each report service to its brand-color hover modifier (see styles.css).
function reportLinkClass(name: string): string {
  const modifier =
    { GoogleForm: "--google", GitHub: "--github", Plurk: "--plurk" }[name] ??
    "";
  return modifier
    ? `moo-settings__report-link moo-settings__report-link${modifier}`
    : "moo-settings__report-link";
}

/** 問題回報 footer of FamilySettings: one brand-icon link per report service. */
export function FamilySettingsReportLinks() {
  return (
    <div className="moo-settings__report">
      <div className="moo-settings__report-label">問題回報</div>
      <div className="moo-settings__report-links">
        {reportLinks.map((link) => (
          <a
            key={link.name}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            title={link.name}
            className={reportLinkClass(link.name)}
          >
            <svg
              aria-hidden="true"
              role="img"
              viewBox="0 0 24 24"
              width={24}
              height={24}
              fill="currentColor"
            >
              <path d={link.svgPath} />
            </svg>
          </a>
        ))}
      </div>
    </div>
  );
}
