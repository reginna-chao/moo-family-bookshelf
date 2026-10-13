import { BoolFlag } from "../api/client";
import type { UseDisplayNameResult } from "./useDisplayName";
import type { FloatingIconSize } from "./useFloatingIconSize";
import type { AutoSyncInterval } from "./useAutoSyncInterval";
import { FloatingIconSizeSelector } from "./FloatingIconSizeSelector";
import { AutoSyncIntervalSelector } from "./AutoSyncIntervalSelector";
import { DisplayNameEditor } from "./DisplayNameEditor";
import type { UseFamilySettingsNewBookDefaultResult } from "./useFamilySettingsNewBookDefault";
import { AUTO_SHARE_MAX_NEW } from "../sync/autoShare";

const NEW_BOOK_DEFAULT_HINT = `打開後，同步時個人書櫃裡還沒有的書（例如新買的書、從封存移回書櫃的書）會自動開放給家人，也會出現在你的公開書櫃。第一次同步，或一次新增超過 ${AUTO_SHARE_MAX_NEW} 本書時，不會自動開放，封存的書也不會`;

function switchTrackClass(on: boolean): string {
  return on ? "moo-switch__track moo-switch__track--on" : "moo-switch__track";
}

function switchKnobClass(on: boolean): string {
  return on ? "moo-switch__knob moo-switch__knob--on" : "moo-switch__knob";
}

export interface FamilySettingsPersonalBlockProps {
  /** Spread whole into `DisplayNameEditor`, which consumes every member. */
  displayNameState: UseDisplayNameResult;
  userId: string;
  syncArchived: number;
  onToggleSyncArchived: () => void;
  /** The 新書預設開放 switch's state (`useFamilySettingsNewBookDefault`). */
  newBookDefault: UseFamilySettingsNewBookDefaultResult;
  autoSyncInterval: AutoSyncInterval;
  onAutoSyncIntervalChange: (interval: AutoSyncInterval) => void;
  iconSize: FloatingIconSize;
  onIconSizeChange: (size: FloatingIconSize) => void;
}

/**
 * Body of the 個人設定 section. Stateless: every value lives in the
 * always-mounted `FamilySettings`, so collapsing the section loses nothing.
 */
export function FamilySettingsPersonalBlock({
  displayNameState,
  userId,
  syncArchived,
  onToggleSyncArchived,
  newBookDefault,
  autoSyncInterval,
  onAutoSyncIntervalChange,
  iconSize,
  onIconSizeChange,
}: FamilySettingsPersonalBlockProps) {
  const newBookOn = newBookDefault.newBookDefaultShared === BoolFlag.TRUE;
  const newBookMessageIsHint =
    newBookDefault.status === "unsupported" ||
    newBookDefault.status === "noRecord";
  const newBookMessageClass = newBookMessageIsHint
    ? "moo-settings__hint"
    : "moo-settings__error-text";
  return (
    <>
      <DisplayNameEditor {...displayNameState} userId={userId} />
      <div className="moo-settings__block">
        <button
          role="switch"
          aria-checked={syncArchived === BoolFlag.TRUE}
          aria-label="同步封存書籍"
          onClick={onToggleSyncArchived}
          className="moo-switch"
        >
          <span className={switchTrackClass(syncArchived === BoolFlag.TRUE)}>
            <span className={switchKnobClass(syncArchived === BoolFlag.TRUE)} />
          </span>
          同步封存書籍
        </button>
        <div className="moo-settings__hint">
          啟用後，同步時會一併讀取已封存的書籍
        </div>
      </div>
      <div className="moo-settings__block">
        <button
          role="switch"
          aria-checked={newBookOn}
          aria-label="新書預設開放"
          onClick={newBookDefault.handleToggleNewBookDefault}
          disabled={newBookDefault.status !== "ready"}
          className="moo-switch"
        >
          <span className={switchTrackClass(newBookOn)}>
            <span className={switchKnobClass(newBookOn)} />
          </span>
          新書預設開放
        </button>
        <div className="moo-settings__hint">{NEW_BOOK_DEFAULT_HINT}</div>
        {newBookDefault.message && (
          <div className={newBookMessageClass}>{newBookDefault.message}</div>
        )}
      </div>
      <div className="moo-settings__block">
        <div className="moo-settings__label">自動同步頻率</div>
        <AutoSyncIntervalSelector
          value={autoSyncInterval}
          onChange={onAutoSyncIntervalChange}
        />
        <div className="moo-settings__hint">
          家庭書櫃自動讀取書單的頻率；手動同步不受此限制
        </div>
      </div>
      <div className="moo-settings__block">
        <div className="moo-settings__label">家庭書櫃按鈕大小</div>
        <FloatingIconSizeSelector size={iconSize} onChange={onIconSizeChange} />
        <div className="moo-settings__hint">
          在讀墨頁面顯示的家庭書櫃按鈕大小
        </div>
      </div>
    </>
  );
}
