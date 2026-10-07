import React, { useState, type CSSProperties, type ReactNode } from "react";

export interface LazyCoverProps {
  src: string;
  alt: string;
  width: number;
  height: number;
  /** Extra style merged onto the wrapper + img (dynamic/per-caller overrides). */
  style?: CSSProperties;
  /** Extra class merged onto the wrapper + img (static per-caller styling). */
  className?: string;
  fallback: ReactNode;
}

type LoadStatus = "loading" | "loaded" | "error";

export const LazyCover = React.memo(function LazyCover({
  src,
  alt,
  width,
  height,
  style,
  className,
  fallback,
}: LazyCoverProps) {
  const [status, setStatus] = useState<LoadStatus>("loading");

  if (!src) return <>{fallback}</>;

  if (status === "error") return <>{fallback}</>;

  const wrapperClass = className
    ? `moo-lazy-cover ${className}`
    : "moo-lazy-cover";
  const imgClass = [
    "moo-lazy-cover__img",
    status === "loaded" ? "moo-lazy-cover__img--loaded" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  // A className owns sizing (inline width/height would beat it and lock the size); without one,
  // inline width/height is the CLS placeholder before the image loads.
  const sizeStyle: CSSProperties = className ? {} : { width, height };

  return (
    <div className={wrapperClass} style={{ ...sizeStyle, ...style }}>
      {status === "loading" && <div className="moo-lazy-cover__spinner" />}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("error")}
        className={imgClass}
        style={{ ...sizeStyle, ...style }}
      />
    </div>
  );
});
