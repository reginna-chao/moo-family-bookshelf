import React, { useState, type ReactNode } from "react";

export interface LazyCoverProps {
  src: string;
  alt: string;
  className?: string;
  fallback: ReactNode;
}

type LoadStatus = "loading" | "loaded" | "error";

export const LazyCover = React.memo(function LazyCover({
  src,
  alt,
  className,
  fallback,
}: LazyCoverProps) {
  const [status, setStatus] = useState<LoadStatus>("loading");

  if (!src) return <>{fallback}</>;

  if (status === "error") return <>{fallback}</>;

  return (
    <div className={`relative ${className ?? ""}`}>
      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-5 h-5 border-2 border-gray-200 border-t-blue-600 rounded-full animate-spin" />
        </div>
      )}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("error")}
        className={`${className ?? ""} transition-opacity duration-200 ${
          status === "loaded" ? "opacity-100" : "opacity-0"
        }`}
      />
    </div>
  );
});
