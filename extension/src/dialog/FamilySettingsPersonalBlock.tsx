import { BoolFlag } from "../api/client";
import {
  ACCOUNT_SETTINGS_FOLLOWS_ACCOUNT,
  ACCOUNT_SETTINGS_LOCAL_ONLY,
  SYNC_ARCHIVED_SHARED_NOTE,
} from "moo-family-bookshelf-shared/api/accountSettingsMessages";
import type { UseDisplayNameResult } from "./useDisplayName";
import type { UseFloatingIconSizeReturn } from "./useFloatingIconSize";
import type { UseAutoSyncIntervalReturn } from "./useAutoSyncInterval";
import type { UseFamilySettingsSyncArchivedResult } from "./useFamilySettingsSyncArchived";
import { FloatingIconSizeSelector } from "./FloatingIconSizeSelector";
import { AutoSyncIntervalSelector } from "./AutoSyncIntervalSelector";
import { DisplayNameEditor } from "./DisplayNameEditor";
import type { UseFamilySettingsNewBookDefaultResult } from "./useFamilySettingsNewBookDefault";
import { AUTO_SHARE_MAX_NEW } from "../sync/autoShare";
import type { UseStorePageChipResult } from "./useStorePageChip";
import { useAccountSettingsUnsupported } from "./AccountSettingsContext";

const STORE_PAGE_CHIP_LABEL = "在購買頁顯示家人開放的書";
const STORE_PAGE_CHIP_HINT = `開啟後，瀏覽讀墨書籍頁面時，書名下方會顯示哪位家人已開放這本書；每個瀏覽器第一次開啟都要在設定頁授權。${ACCOUNT_SETTINGS_FOLLOWS_ACCOUNT}`;

const SYNC_ARCHIVED_HINT = `啟用後，同步時會一併讀取已封存的書籍。${SYNC_ARCHIVED_SHARED_NOTE}`;

const AUTO_SYNC_HINT = `開啟個人書櫃時，距離上次同步超過這段時間就會自動同步；手動同步不受此限制。${ACCOUNT_SETTINGS_FOLLOWS_ACCOUNT}`;

const ICON_SIZE_HINT = `在讀墨頁面顯示的家庭書櫃按鈕大小。${ACCOUNT_SETTINGS_FOLLOWS_ACCOUNT}`;

const NEW_BOOK_DEFAULT_HINT = `打開後，同步時個人書櫃裡還沒有的書（例如新買的書、從封存移回書櫃的書）會自動開放給家人，也會出現在你的公開書櫃。第一次同步，或一次新增超過 ${AUTO_SHARE_MAX_NEW} 本書時，不會自動開放，封存的書也不會`;

function switchTrackClass(on: boolean): string {
  return on ? "moo-switch__track moo-switch__track--on" : "moo-switch__track";
}

function switchKnobClass(on: boolean): string {
  return on ? "moo-switch__knob moo-switch__knob--on" : "moo-switch__knob";
}

interface SettingMessageProps {
  message: string;
}

/** A failed save of one setting, under its description; nothing when there is nothing to report. */
function SettingMessage({ message }: SettingMessageProps) {
  if (!message) return null;
  return <div className="moo-settings__error-text">{message}</div>;
}

export interface FamilySettingsPersonalBlockProps {
  /** Spread whole into `DisplayNameEditor`, which consumes every member. */
  displayNameState: UseDisplayNameResult;
  userId: string;
  /** The 同步封存書籍 switch's state (`useFamilySettingsSyncArchived`). */
  syncArchived: UseFamilySettingsSyncArchivedResult;
  /** The 新書預設開放 switch's state (`useFamilySettingsNewBookDefault`). */
  newBookDefault: UseFamilySettingsNewBookDefaultResult;
  /** The store-page chip switch's state (`useStorePageChip`). */
  storePageChip: UseStorePageChipResult;
  /** The 自動同步頻率 selector's state (`useAutoSyncInterval`). */
  autoSync: UseAutoSyncIntervalReturn;
  /** The 家庭書櫃按鈕大小 selector's state (`useFloatingIconSize`). */
  iconSize: UseFloatingIconSizeReturn;
}

/**
 * Body of the 個人設定 section. Stateless: every value lives in the
 * always-mounted `FamilySettings`, so collapsing the section loses nothing.
 */
export function FamilySettingsPersonalBlock({
  displayNameState,
  userId,
  syncArchived,
  newBookDefault,
  storePageChip,
  autoSync,
  iconSize,
}: FamilySettingsPersonalBlockProps) {
  const localOnly = useAccountSettingsUnsupported();
  const syncArchivedOn = syncArchived.syncArchived === BoolFlag.TRUE;
  const newBookOn = newBookDefault.newBookDefaultShared === BoolFlag.TRUE;
  const storeChipOn = storePageChip.enabled === BoolFlag.TRUE;
  const newBookMessageIsHint =
    newBookDefault.status === "unsupported" ||
    newBookDefault.status === "noRecord";
  const newBookMessageClass = newBookMessageIsHint
    ? "moo-settings__hint"
    : "moo-settings__error-text";
  return (
    <>
      <DisplayNameEditor {...displayNameState} userId={userId} />
      {localOnly && (
        <div className="moo-settings__hint">{ACCOUNT_SETTINGS_LOCAL_ONLY}</div>
      )}
      <div className="moo-settings__block">
        <button
          role="switch"
          aria-checked={syncArchivedOn}
          aria-label="同步封存書籍"
          onClick={syncArchived.handleToggleSyncArchived}
          className="moo-switch"
        >
          <span className={switchTrackClass(syncArchivedOn)}>
            <span className={switchKnobClass(syncArchivedOn)} />
          </span>
          同步封存書籍
        </button>
        <div className="moo-settings__hint">{SYNC_ARCHIVED_HINT}</div>
        <SettingMessage message={syncArchived.message} />
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
        <button
          role="switch"
          aria-checked={storeChipOn}
          aria-label={STORE_PAGE_CHIP_LABEL}
          onClick={storePageChip.toggle}
          className="moo-switch"
        >
          <span className={switchTrackClass(storeChipOn)}>
            <span className={switchKnobClass(storeChipOn)} />
          </span>
          {STORE_PAGE_CHIP_LABEL}
        </button>
        <div className="moo-settings__hint">{STORE_PAGE_CHIP_HINT}</div>
        {storePageChip.hint && (
          <div className="moo-settings__hint">{storePageChip.hint}</div>
        )}
        <SettingMessage message={storePageChip.message} />
        {storePageChip.needsGrant && (
          <button
            type="button"
            onClick={storePageChip.openOptions}
            className="moo-button moo-button--outline moo-button--sm"
          >
            前往設定頁授權
          </button>
        )}
      </div>
      <div className="moo-settings__block">
        <div className="moo-settings__label">自動同步頻率</div>
        <AutoSyncIntervalSelector
          value={autoSync.interval}
          onChange={autoSync.setInterval}
        />
        <div className="moo-settings__hint">{AUTO_SYNC_HINT}</div>
        <SettingMessage message={autoSync.message} />
      </div>
      <div className="moo-settings__block">
        <div className="moo-settings__label">家庭書櫃按鈕大小</div>
        <FloatingIconSizeSelector
          size={iconSize.size}
          onChange={iconSize.setSize}
        />
        <div className="moo-settings__hint">{ICON_SIZE_HINT}</div>
        <SettingMessage message={iconSize.message} />
      </div>
    </>
  );
}
