import { useCallback, useEffect, useRef } from "react";
import { PinInput } from "../../dialog/PinInput";
import { PatternLock } from "../../dialog/PatternLock";
import type { ViewComponentProps } from "../protocol";

/** Submit callback shared by both views: the entered secret goes to the host as `submit`. */
function useSubmit(emit: ViewComponentProps<"pin">["emit"]) {
  return useCallback(
    (secret: string) => emit({ type: "submit", secret }),
    [emit],
  );
}

/** Runs `focus` once on mount when the first props asked for it; later props never refocus.
 *  FrameApp mounts a view only after the first props, so mount time is "first props". */
export function useFocusOnFirstProps(
  autoFocus: boolean | undefined,
  focus: () => void,
): void {
  const firstRef = useRef({ autoFocus: autoFocus === true, focus });
  useEffect(() => {
    if (firstRef.current.autoFocus) firstRef.current.focus();
  }, []);
}

/** `pin` view: the Dialog's PinInput, unchanged; its field takes focus on first props if asked. */
export function PinView({ props, emit }: ViewComponentProps<"pin">) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleComplete = useSubmit(emit);

  useFocusOnFirstProps(props.autoFocus, () =>
    containerRef.current?.querySelector("input")?.focus(),
  );

  return (
    <div ref={containerRef}>
      <PinInput
        mode={props.mode}
        error={props.error}
        disabled={props.disabled}
        onComplete={handleComplete}
      />
    </div>
  );
}

/** `pattern` view: the Dialog's PatternLock, unchanged; the wrapper takes focus on first props if asked. */
export function PatternView({ props, emit }: ViewComponentProps<"pattern">) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleComplete = useSubmit(emit);

  useFocusOnFirstProps(props.autoFocus, () => containerRef.current?.focus());

  return (
    <div ref={containerRef} tabIndex={-1} className="moo-secure-frame__focus">
      <PatternLock
        mode={props.mode}
        error={props.error}
        disabled={props.disabled}
        onComplete={handleComplete}
      />
    </div>
  );
}
