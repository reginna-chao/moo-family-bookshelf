import { useEffect, useRef, useState } from "react";
import type { ViewComponentProps } from "../protocol";
import { useFocusOnFirstProps } from "./SecretEntryView";

const BASE_CLASS = "moo-form-input moo-form-input--block";
// Bounds the not-yet-echoed history when a host never echoes the value back.
const MAX_PENDING = 50;

/** The field owns its text; a host `value` (prefill, clear) is adopted unless it is the last
 *  reported value or an older report not yet caught up past, so a late echo never eats typing. */
function useAdoptedText(value: string) {
  const [text, setText] = useState(value);
  const lastKnownRef = useRef(value);
  const pendingRef = useRef<string[]>([]);
  const [adoptCount, setAdoptCount] = useState(0);

  useEffect(() => {
    const pending = pendingRef.current;
    if (pending.length > 0 && value === pending[pending.length - 1]) {
      pendingRef.current = [];
      return;
    }
    if (value === lastKnownRef.current || pending.includes(value)) return;
    lastKnownRef.current = value;
    pendingRef.current = [];
    setText(value);
    setAdoptCount((count) => count + 1);
  }, [value]);

  const report = (next: string) => {
    lastKnownRef.current = next;
    pendingRef.current = [...pendingRef.current, next].slice(-MAX_PENDING);
    setText(next);
  };

  return { text, report, adoptCount };
}

/** `sync-code-input` view: the join-family sync-code field, reporting change / paste / blur. */
export function SyncCodeInputView({
  props,
  emit,
}: ViewComponentProps<"sync-code-input">) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { text, report, adoptCount } = useAdoptedText(props.value);

  useFocusOnFirstProps(props.autoFocus, () => inputRef.current?.focus());

  // After the host replaces the text, put the cursor at the end of the new value.
  useEffect(() => {
    const input = inputRef.current;
    if (adoptCount === 0 || !input) return;
    input.setSelectionRange(input.value.length, input.value.length);
  }, [adoptCount]);

  const className = props.className
    ? `${BASE_CLASS} ${props.className}`
    : BASE_CLASS;

  // The padding wrapper keeps the focus ring inside the frame (.moo-secure-frame__field).
  return (
    <div className="moo-secure-frame__field">
      <input
        ref={inputRef}
        type={props.masked ? "password" : "text"}
        autoComplete="off"
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
        value={text}
        onChange={(event) => {
          report(event.target.value);
          emit({ type: "change", value: event.target.value });
        }}
        onPaste={() => emit({ type: "paste" })}
        onBlur={() => emit({ type: "blur" })}
        disabled={props.disabled}
        className={className}
      />
    </div>
  );
}
