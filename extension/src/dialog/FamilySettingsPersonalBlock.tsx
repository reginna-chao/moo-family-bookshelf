import { BoolFlag } from "../api/client";
import type { UseDisplayNameResult } from "./useDisplayName";
import type { FloatingIconSize } from "./useFloatingIconSize";
import type { AutoSyncInterval } from "./useAutoSyncInterval";
import { FloatingIconSizeSelector } from "./FloatingIconSizeSelector";
import { AutoSyncIntervalSelector } from "./AutoSyncIntervalSelector";
import { DisplayNameEditor } from "./DisplayNameEditor";

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
  autoSyncInterval,
  onAutoSyncIntervalChange,
  iconSize,
  onIconSizeChange,
}: FamilySettingsPersonalBlockProps) {
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
