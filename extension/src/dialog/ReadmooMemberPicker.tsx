import { useEffect } from "react";
import { X } from "lucide-react";
import type { ReadmooMember } from "../content/readmoo-lend";

export interface ReadmooMemberPickerProps {
  /** Display name of the MooFamily borrower whose readmooName we are picking. */
  borrowerName: string;
  /** Member options scraped from the Readmoo 「借出書籍」 dialog. */
  options: ReadmooMember[];
  /** True while the PATCH that persists the chosen readmooName is in flight. */
  saving: boolean;
  /** Last PATCH error (null when no error to surface). */
  errorMessage: string | null;
  onPick: (member: ReadmooMember) => void;
  onCancel: () => void;
}

/**
 * Modal asking the owner to associate the MooFamily borrower with one of the
 * Readmoo lending dialog's options. Stays open across the PATCH so retry is
 * possible if the network call fails.
 *
 * Renders inline (not via portal) so it is hosted inside the same Shadow DOM
 * as the rest of the dialog UI.
 */
export function ReadmooMemberPicker({
  borrowerName,
  options,
  saving,
  errorMessage,
  onPick,
  onCancel,
}: ReadmooMemberPickerProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) {
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [onCancel, saving]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="選擇讀墨家庭成員"
      className="moo-modal-overlay"
    >
      <div className="moo-modal">
        <div className="moo-modal__header">
          <h3 className="moo-modal__title">
            請選擇「{borrowerName}」對應的讀墨家庭成員
          </h3>
          <button
            type="button"
            aria-label="關閉"
            onClick={onCancel}
            disabled={saving}
            className="moo-button moo-button--ghost-icon moo-modal__close"
          >
            <X size={16} />
          </button>
        </div>
        <p className="moo-member-picker__help">
          選擇後將自動記錄此對應關係，下次借出時不再詢問。
        </p>
        {errorMessage && (
          <div role="alert" className="moo-modal__error">
            {errorMessage}
          </div>
        )}
        {options.length === 0 ? (
          <div className="moo-member-picker__empty">
            讀墨清單中沒有可選的家庭成員。
          </div>
        ) : (
          <ul className="moo-member-picker__list">
            {options.map((member) => (
              <li key={member.name}>
                <button
                  type="button"
                  onClick={() => onPick(member)}
                  disabled={saving}
                  className="moo-member-picker__item"
                >
                  {member.avatar && (
                    <img
                      src={member.avatar}
                      alt=""
                      width={32}
                      height={32}
                      className="moo-member-picker__avatar"
                    />
                  )}
                  <span className="moo-member-picker__name">{member.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="moo-member-picker__footer">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="moo-button moo-button--ghost moo-button--sm moo-modal__cancel moo-member-picker__cancel"
          >
            {saving ? "處理中..." : "取消"}
          </button>
        </div>
      </div>
    </div>
  );
}
