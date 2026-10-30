import { useState, type ReactNode } from "react";
import { demoLoginFn } from "@/lib/api";

export function DemoButton({
  className,
  children,
  onError,
}: {
  className: string;
  children: ReactNode;
  onError?: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setBusy(true);
    setError(null);
    try {
      const result = await demoLoginFn();
      if (!result.ok) {
        setError(result.error);
        onError?.(result.error);
        setBusy(false);
        return;
      }
      window.location.assign(result.redirect);
    } catch {
      const message = "Could not open the demo. Try again in a moment.";
      setError(message);
      onError?.(message);
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1.5">
      <button type="button" onClick={open} disabled={busy} className={className}>
        {busy ? "Opening workspace…" : children}
      </button>
      {error && !onError ? (
        <span className="max-w-[16rem] text-xs text-destructive">{error}</span>
      ) : null}
    </span>
  );
}
