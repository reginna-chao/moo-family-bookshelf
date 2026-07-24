import React from "react";

export interface FavoriteButtonProps {
  /** Whether the viewer has favorited this copy-scoped card. */
  isFavorite: boolean;
  /** Toggle favorite/unfavorite for this card (v1.5.0). */
  onFavoriteToggle: () => void;
}

/**
 * Icon-only heart toggle (Extension). Filled red when favorited, hollow grey
 * otherwise. Lives in the trailing action area beside the overflow menu.
 *
 * The cards/rows wrap content in an `<a>`, so clicks are stopped from
 * propagating to (and navigating) the link.
 *
 * Hover behaviour is CSS-driven (.moo-favorite-btn:hover): not-favorited shifts
 * grey → red-400 on hover, favorited stays solid red.
 */
export function FavoriteButton({
  isFavorite,
  onFavoriteToggle,
}: FavoriteButtonProps) {
  const label = isFavorite ? "取消最愛" : "加入最愛";
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onFavoriteToggle();
  };

  const className = isFavorite
    ? "moo-button moo-button--ghost-icon moo-favorite-btn moo-favorite-btn--active"
    : "moo-button moo-button--ghost-icon moo-favorite-btn";

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isFavorite}
      title={label}
      onClick={handleClick}
      className={className}
    >
      <svg
        width={16}
        height={16}
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
