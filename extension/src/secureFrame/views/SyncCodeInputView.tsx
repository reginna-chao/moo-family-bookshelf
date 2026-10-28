import { useEffect, useRef, useState } from "react";
import type { ViewComponentProps } from "../protocol";
import { useFocusOnFirstProps } from "./SecretEntryView";

const BASE_CLASS = "moo-form-input moo-form-input--block";

/** The field owns its text; each report gets a rising seq. A host `value` is adopted only once
 *  `appliedSeq` has caught up with the last seq sent, so a late echo never eats typing (#422). */
function useAdoptedText(value: string, appliedSeq: number) {
  const [text, setText] = useState(value);
  const textRef = useRef(value);
  const sentSeqRef = useRef(0);
  const [adoptCount, setAdoptCount] = useState(0);

  useEffect(() => {
    if (appliedSeq < sentSeqRef.current) return;
    if (value === textRef.current) return;
    textRef.current = value;
    setText(value);
    setAdoptCount((count) => count + 1);
  }, [value, appliedSeq]);

  /** Records a typed value and returns the seq to send with its `change`. */
  const report = (next: string): number => {
    sentSeqRef.current += 1;
    textRef.current = next;
    setText(next);
    return sentSeqRef.current;
  };

  return { text, report, adoptCount };
}

/** `sync-code-input` view: the join-family sync-code field, reporting change / paste / blur. */
export function SyncCodeInputView({
  props,
  emit,
}: ViewComponentProps<"sync-code-input">) {
  const inputRef = useRef<HTMLInputElement>(null);
  const { text, report, adoptCount } = useAdoptedText(
    props.value,
    props.appliedSeq,
  );

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
          const next = event.target.value;
          // Bump the seq before emitting: a synchronous host may re-render before emit returns.
          const seq = report(next);
          emit({ type: "change", value: next, seq });
        }}
        onPaste={() => emit({ type: "paste" })}
        onBlur={() => emit({ type: "blur" })}
        disabled={props.disabled}
        className={className}
      />
    </div>
  );
}
