import { BorrowRequest, BorrowStatus } from "../api/client";

export type BorrowActionVariant = "primary" | "danger" | "secondary";

export interface BorrowAction {
  label: string;
  onClick: () => void;
  variant?: BorrowActionVariant;
  disabled?: boolean;
}

export interface BorrowRequestCardProps {
  request: BorrowRequest;
  /** borrowerName for incoming, owner displayName for outgoing. */
  otherPartyName: string;
  actions: BorrowAction[];
}

interface StatusMeta {
  label: string;
  modifier: string;
}

/**
 * Per-status label + badge modifier class (colors live in styles.css).
 * A Map, not an object literal: `request.status` arrives unvalidated from a
 * user-configurable backend, and a Map lookup never walks the prototype chain,
 * so a hostile `"__proto__"` / `"toString"` resolves to nothing instead of an
 * Object.prototype member.
 */
const STATUS_META: ReadonlyMap<BorrowStatus, StatusMeta> = new Map([
  [
    BorrowStatus.PENDING,
    { label: "待處理", modifier: "moo-request-card__status--pending" },
  ],
  [
    BorrowStatus.LENT,
    { label: "出借中", modifier: "moo-request-card__status--lent" },
  ],
  [
    BorrowStatus.RETURNED,
    { label: "已歸還", modifier: "moo-request-card__status--returned" },
  ],
  [
    BorrowStatus.REJECTED,
    { label: "已拒絕", modifier: "moo-request-card__status--rejected" },
  ],
  [
    BorrowStatus.CANCELLED,
    { label: "已取消", modifier: "moo-request-card__status--cancelled" },
  ],
]);

/** Shown for any status outside the enum; reuses the neutral gray badge. */
const UNKNOWN_STATUS: StatusMeta = {
  label: "狀態未知",
  modifier: "moo-request-card__status--returned",
};

const ACTION_VARIANT_CLASS: Record<BorrowActionVariant, string> = {
  primary:
    "moo-button moo-button--sm moo-request-card__action moo-request-card__action--primary",
  danger:
    "moo-button moo-button--outline-danger moo-button--sm moo-request-card__action moo-request-card__action--danger",
  secondary:
    "moo-button moo-button--ghost moo-button--sm moo-request-card__action",
};

/** Human-friendly relative time in 繁體中文 (falls back to ISO date on parse error). */
function formatRelativeTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diffSec = Math.round((Date.now() - ts) / 1000);
  if (diffSec < 60) return "剛剛";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分鐘前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小時前`;
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)} 天前`;
  return new Date(ts).toISOString().slice(0, 10);
}

export function BorrowRequestCard({
  request,
  otherPartyName,
  actions,
}: BorrowRequestCardProps) {
  const status = STATUS_META.get(request.status) ?? UNKNOWN_STATUS;

  return (
    <div className="moo-request-card">
      <img
        src={request.bookCoverUrl}
        alt={request.bookTitle}
        className="moo-request-card__cover"
      />
      <div className="moo-request-card__body">
        <div className="moo-request-card__title">{request.bookTitle}</div>
        {request.bookAuthor && (
          <div className="moo-request-card__author">{request.bookAuthor}</div>
        )}
        <div className="moo-request-card__party">
          對象：
          <span className="moo-request-card__party-name">{otherPartyName}</span>
        </div>
        <div className="moo-request-card__meta">
          <span className={`moo-request-card__status ${status.modifier}`}>
            {status.label}
          </span>
          <span className="moo-request-card__time">
            {formatRelativeTime(request.createdAt)}
          </span>
        </div>
        {actions.length > 0 && (
          <div className="moo-request-card__actions">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                disabled={action.disabled}
                className={ACTION_VARIANT_CLASS[action.variant ?? "secondary"]}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
