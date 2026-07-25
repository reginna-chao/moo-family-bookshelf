export interface FamilyShelfErrorProps {
  message: string;
  onRetry: () => void;
}

/** Error state for the family shelf, with a retry button. */
export function FamilyShelfError({ message, onRetry }: FamilyShelfErrorProps) {
  return (
    <div className="moo-shelf-status">
      <p className="moo-shelf-status__error-text">{message}</p>
      <button
        onClick={onRetry}
        className="moo-button moo-button--outline moo-shelf-status__retry"
      >
        重試
      </button>
    </div>
  );
}

/** Empty state shown when no family member has shared any book. */
export function FamilyShelfEmpty() {
  return (
    <div className="moo-shelf-status moo-shelf-status--center">
      <p className="moo-shelf-status__empty-title">尚無家人分享書籍</p>
      <p className="moo-shelf-status__empty-hint">
        家庭成員需在「個人書櫃」中開放書籍後才會出現在這裡
      </p>
    </div>
  );
}
