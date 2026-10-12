// Press-and-hold confirmation: the action fires after the button has been
// held for `durationMs`, with the fill showing progress. Works with pointer
// (mouse, touch, pen) and keyboard (hold Space or Enter).
import type { KeyboardEvent, PointerEvent } from "react";

interface HoldButtonProps {
  label: string;
  /** read out with the button, e.g. "Press and hold for one second" */
  hint: string;
  durationMs?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  onConfirm: () => void;
}

export function HoldButton(props: HoldButtonProps) {
  const duration = props.durationMs ?? 1000;
  const [progress, setProgress] = React.useState(0);
  const startRef = React.useRef<number | undefined>(undefined);
  const frameRef = React.useRef<number | undefined>(undefined);
  const firedRef = React.useRef(false);
  const onConfirmRef = React.useRef(props.onConfirm);
  onConfirmRef.current = props.onConfirm;
  const hintId = React.useMemo(() => `stp-hold-${Math.random().toString(36).slice(2)}`, []);

  const stopFrame = () => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = undefined;
  };

  const tick = () => {
    if (startRef.current === undefined) return;
    const p = Math.min(1, (performance.now() - startRef.current) / duration);
    setProgress(p);
    if (p >= 1) {
      startRef.current = undefined;
      stopFrame();
      if (!firedRef.current) {
        firedRef.current = true;
        onConfirmRef.current();
      }
      return;
    }
    frameRef.current = requestAnimationFrame(tick);
  };

  const begin = () => {
    if (props.disabled || firedRef.current || startRef.current !== undefined) return;
    startRef.current = performance.now();
    frameRef.current = requestAnimationFrame(tick);
  };

  const cancel = () => {
    if (firedRef.current) return;
    startRef.current = undefined;
    stopFrame();
    setProgress(0);
  };

  React.useEffect(() => stopFrame, []);
  React.useEffect(() => {
    if (props.disabled) cancel();
  }, [props.disabled]);

  const isHoldKey = (e: KeyboardEvent) => e.key === " " || e.key === "Enter" || e.key === "Spacebar";

  return (
    <>
      <button
        type="button"
        className="stp-hold"
        disabled={props.disabled}
        autoFocus={props.autoFocus}
        aria-describedby={hintId}
        onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture?.(e.pointerId);
          begin();
        }}
        onPointerUp={cancel}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
          if (!isHoldKey(e)) return;
          e.preventDefault();
          if (!e.repeat) begin();
        }}
        onKeyUp={(e: KeyboardEvent<HTMLButtonElement>) => {
          if (!isHoldKey(e)) return;
          e.preventDefault();
          cancel();
        }}
        onBlur={cancel}
        onContextMenu={(e) => e.preventDefault()}
      >
        <span className="stp-hold-fill" style={{ width: `${progress * 100}%` }} aria-hidden="true" />
        <span className="stp-hold-label">{props.label}</span>
      </button>
      <span id={hintId} className="stp-small stp-muted stp-center">
        {props.hint}
      </span>
    </>
  );
}
