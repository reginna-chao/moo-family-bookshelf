import React, { useState } from "react";

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
 */
export function FavoriteButton({ isFavorite, onFavoriteToggle }: FavoriteButtonProps) {
  const [hovered, setHovered] = useState(false);
  const label = isFavorite ? "取消最愛" : "加入最愛";
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onFavoriteToggle();
  };

  // Inline-style hover (the Extension dialog can't use Tailwind `:hover`):
  // favorited stays solid red; not-favorited shifts grey → red-400 on hover.
  const getColor = () => {
    if (isFavorite) return "#ef4444";
    return hovered ? "#f87171" : "#94a3b8";
  };

  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isFavorite}
      title={label}
      onClick={handleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 28,
        height: 28,
        padding: 0,
        border: "none",
        borderRadius: 6,
        background: "transparent",
        color: getColor(),
        cursor: "pointer",
      }}
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
