interface ErrorAlertProps {
  /** Visible error copy. Renders nothing when empty. */
  message: string;
  /**
   * Stable sentence to announce to assistive tech. Defaults to `message`.
   *
   * Pass a countdown-free variant whenever `message` re-renders on a timer: a
   * live region whose text changes every second interrupts a screen-reader user
   * on every tick (up to 15 minutes for a verification lockout). When this
   * differs from `message`, only this sentence reaches the live region and the
   * ticking copy is hidden from assistive tech.
   */
  announcement?: string;
  /** Extra layout classes (spacing only); colour and size are fixed. */
  className?: string;
}

const BASE_CLASS = "text-red-500 text-sm text-center";

/**
 * Error line with a screen-reader-safe live region. Single rendering seam for
 * error copy that may or may not tick, so no call site has to hand-roll the
 * `role="alert"` / `aria-hidden` split.
 */
export function ErrorAlert({
  message,
  announcement,
  className = "",
}: ErrorAlertProps) {
  if (!message) return null;

  const classes = className ? `${BASE_CLASS} ${className}` : BASE_CLASS;
  const spoken = announcement || message;

  // Static copy: one node is both the visible text and the live region.
  if (spoken === message) {
    return (
      <p role="alert" className={classes}>
        {message}
      </p>
    );
  }

  return (
    <p className={classes}>
      <span role="alert" className="sr-only">
        {spoken}
      </span>
      <span aria-hidden="true">{message}</span>
    </p>
  );
}
