import { BorrowStatus, type BorrowRequest } from "@/api/client";
import { LazyCover } from "@/components/LazyCover";

interface StatusStyle {
  label: string;
  className: string;
}

/**
 * Runtime-reachable fallback with a compile-time exhaustiveness tripwire:
 * `status` narrows to `never` here only while every BorrowStatus member has a
 * case above, so adding a 6th member fails the build instead of silently
 * shipping 「狀態未知」.
 */
function unknownStatusStyle(_status: never): StatusStyle {
  return { label: "狀態未知", className: "bg-gray-200 text-gray-600" };
}

function getStatusStyle(status: BorrowStatus): StatusStyle {
  switch (status) {
    case BorrowStatus.PENDING:
      return { label: "待處理", className: "bg-blue-100 text-blue-700" };
    case BorrowStatus.LENT:
      return { label: "出借中", className: "bg-green-100 text-green-700" };
    case BorrowStatus.RETURNED:
      return { label: "已歸還", className: "bg-gray-200 text-gray-600" };
    case BorrowStatus.REJECTED:
      return { label: "已拒絕", className: "bg-red-100 text-red-700" };
    case BorrowStatus.CANCELLED:
      return { label: "已取消", className: "bg-gray-200 text-gray-500" };
    // `status` arrives unvalidated from a user-configurable backend, so an
    // out-of-enum value must degrade to a neutral badge, not crash the render.
    default:
      return unknownStatusStyle(status);
  }
}

export interface BorrowAction {
  label: string;
  onClick: () => void;
  variant: "primary" | "danger" | "secondary";
  disabled?: boolean;
}

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

function actionClassName(variant: BorrowAction["variant"]): string {
  const base =
    "px-3 py-1.5 rounded text-xs font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  if (variant === "primary") {
    return `${base} bg-blue-600 text-white border-blue-600 hover:bg-blue-700`;
  }
  if (variant === "danger") {
    return `${base} bg-transparent text-red-600 border-red-600 hover:bg-red-50`;
  }
  return `${base} bg-transparent text-slate-600 border-slate-300 hover:bg-slate-50`;
}

export interface BorrowCardProps {
  request: BorrowRequest;
  otherPartyName: string;
  actions: BorrowAction[];
}

export function BorrowCard({
  request,
  otherPartyName,
  actions,
}: BorrowCardProps) {
  const status = getStatusStyle(request.status);
  return (
    <div className="flex gap-3 p-3 bg-white border border-gray-200 rounded-lg">
      {/* Borrow records have no TTL, so legacy covers outside the CSP img-src
          whitelist still exist; LazyCover degrades on both empty src and the
          img error event so a blocked cover cannot break the card layout. */}
      <LazyCover
        src={request.bookCoverUrl}
        alt={request.bookTitle}
        className="w-10 h-[60px] object-cover rounded bg-gray-100 flex-shrink-0"
        fallback={
          <div className="w-10 h-[60px] rounded bg-gray-100 flex-shrink-0" />
        }
      />
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="text-sm font-semibold text-gray-900 leading-tight truncate">
          {request.bookTitle}
        </div>
        {request.bookAuthor && (
          <div className="text-xs text-gray-400 truncate">
            {request.bookAuthor}
          </div>
        )}
        <div className="text-xs text-gray-600 truncate">
          對象：<span className="font-semibold">{otherPartyName}</span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span
            className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${status.className}`}
          >
            {status.label}
          </span>
          <span className="text-[11px] text-gray-400">
            {formatRelativeTime(request.createdAt)}
          </span>
        </div>
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-2">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                disabled={action.disabled}
                className={actionClassName(action.variant)}
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
