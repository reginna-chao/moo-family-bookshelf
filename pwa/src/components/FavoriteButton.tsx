import React from "react";

export interface FavoriteButtonProps {
  /** Whether the viewer has favorited this copy-scoped card. */
  isFavorite: boolean;
  /** Toggle favorite/unfavorite for this card (v1.5.0). */
  onFavoriteToggle: () => void;
}

/**
 * Icon-only heart toggle (PWA). Filled red when favorited, hollow grey
 * otherwise. Lives in the trailing action area beside the overflow menu.
 *
 * The row wraps content in an `<a>`, so clicks are stopped from propagating
 * to (and navigating) the link.
 */
export function FavoriteButton({ isFavorite, onFavoriteToggle }: FavoriteButtonProps) {
  const label = isFavorite ? "取消最愛" : "加入最愛";
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onFavoriteToggle();
  };

  const colorClass = isFavorite ? "text-red-500" : "text-gray-400 hover:text-red-400";

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isFavorite}
      title={label}
      onClick={handleClick}
      className={`inline-flex items-center justify-center w-8 h-8 rounded-md ${colorClass} transition-colors`}
    >
      <svg
        width={18}
        height={18}
        viewBox="0 0 24 24"
        fill={isFavorite ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
    </button>
  );
}
