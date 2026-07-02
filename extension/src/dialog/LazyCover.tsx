import React, { useState, type CSSProperties, type ReactNode } from "react";

export interface LazyCoverProps {
  src: string;
  alt: string;
  width: number;
  height: number;
  style?: CSSProperties;
  fallback: ReactNode;
}

type LoadStatus = "loading" | "loaded" | "error";

const spinnerStyle: CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  width: 20,
  height: 20,
  marginTop: -10,
  marginLeft: -10,
  border: "2px solid #e2e8f0",
  borderTopColor: "#2563eb",
  borderRadius: "50%",
  animation: "moo-lazy-spin 0.8s linear infinite",
};

export const LazyCover = React.memo(function LazyCover({
  src,
  alt,
  width,
  height,
  style,
  fallback,
}: LazyCoverProps) {
  const [status, setStatus] = useState<LoadStatus>("loading");

  if (!src) return <>{fallback}</>;

  if (status === "error") return <>{fallback}</>;

  return (
    <div style={{ position: "relative", width, height, ...style }}>
      {/* Keyframes rendered in-tree so they resolve inside the shadow root
          (CSS @keyframes are tree-scoped; head-injected ones don't apply). */}
      {status === "loading" && (
        <>
          <style>{`@keyframes moo-lazy-spin{to{transform:rotate(360deg)}}`}</style>
          <div style={spinnerStyle} />
        </>
      )}
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setStatus("loaded")}
        onError={() => setStatus("error")}
        style={{
          width,
          height,
          objectFit: "cover",
          opacity: status === "loaded" ? 1 : 0,
          transition: "opacity 0.2s ease-in",
          ...style,
        }}
      />
    </div>
  );
});
