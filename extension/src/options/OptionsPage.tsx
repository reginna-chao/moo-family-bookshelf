import { BoolFlag } from "moo-family-bookshelf-shared/api/types";
import { useStorePageChipSetting } from "./useStorePageChipSetting";

const STORE_CHIP_LABEL = "在讀墨購買頁顯示家人已開放的書";
const STORE_CHIP_DESCRIPTION =
  "開啟後，瀏覽讀墨書籍頁面時，書名下方會顯示哪位家人已開放這本書。需要授權擴充功能讀取 readmoo.com 的書籍頁面";
const STORE_CHIP_FRESHNESS = "顯示的名字在每次打開家庭書櫃時更新";

const PAGE_STYLE = { maxWidth: 560, margin: "0 auto", padding: "32px 24px" };

function switchTrackClass(on: boolean): string {
  return on ? "moo-switch__track moo-switch__track--on" : "moo-switch__track";
}

function switchKnobClass(on: boolean): string {
  return on ? "moo-switch__knob moo-switch__knob--on" : "moo-switch__knob";
}

interface PermissionStatusProps {
  granted: boolean;
}

/** The permission state as a chip; the text is the accessible content, the check icon is decorative. */
function PermissionStatus({ granted }: PermissionStatusProps) {
  if (!granted) return <span className="moo-options__status">尚未授權</span>;
  return (
    <span className="moo-options__status moo-options__status--granted">
      <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">
        <path
          d="M3 8.5l3 3 7-7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      已授權
    </span>
  );
}

/** The extension's options page: today only the store-page chip switch (#313). */
export function OptionsPage() {
  const {
    enabled,
    granted,
    needsGrant,
    message,
    hasFamily,
    toggle,
    authorize,
  } = useStorePageChipSetting();
  const on = enabled === BoolFlag.TRUE;
  return (
    <main className="moo-options" style={PAGE_STYLE}>
      <h1 style={{ fontSize: 20, margin: "0 0 24px" }}>墨家書櫃 設定</h1>
      <section className="moo-settings__block">
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={STORE_CHIP_LABEL}
          onClick={toggle}
          className="moo-switch"
        >
          <span className={switchTrackClass(on)}>
            <span className={switchKnobClass(on)} />
          </span>
          {STORE_CHIP_LABEL}
        </button>
        <div className="moo-settings__hint">{STORE_CHIP_DESCRIPTION}</div>
        <PermissionStatus granted={granted === BoolFlag.TRUE} />
        <div className="moo-settings__hint">{STORE_CHIP_FRESHNESS}</div>
        {!hasFamily && <div className="moo-settings__hint">需要先加入家庭</div>}
        {message && <div className="moo-settings__error-text">{message}</div>}
        {needsGrant && (
          <button
            type="button"
            onClick={authorize}
            className="moo-button moo-button--outline moo-button--sm"
          >
            授權
          </button>
        )}
      </section>
    </main>
  );
}
