import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import type { ConfigStatus } from "@/state/config-status";
import { useStore } from "@/state/store";

/** The first-run install is still running: the app waits on it, so the person sees the install instead of a chat
 * that cannot answer yet. A failure is not due here; the gate shows it with a way through instead. */
export function qwenSetupDue(localQwen: ConfigStatus["localQwen"]): boolean {
  return localQwen?.state === "starting" || localQwen?.state === "pulling";
}

export function QwenSetupGate() {
  const { state } = useStore();
  const [dismissed, setDismissed] = useState(false);
  const continueRef = useRef<HTMLButtonElement>(null);
  const localQwen = state.config?.localQwen;
  const failed = localQwen?.state === "failed" && !dismissed;
  useEffect(() => {
    if (failed) continueRef.current?.focus();
  }, [failed]);
  if (!qwenSetupDue(localQwen) && !failed) return null;
  const percent = localQwen?.state === "pulling" ? (localQwen.percent ?? 0) : 0;
  const status = localQwen?.state === "pulling"
    ? t("qwenSetup.percent", { percent })
    : t("qwenSetup.starting");
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-app px-6 text-center">
      <h1 className="text-[20px] font-semibold tracking-[-0.01em] text-ink">{t(failed ? "qwenSetup.failedTitle" : "qwenSetup.title")}</h1>
      {failed ? (
        <>
          <p className="max-w-md text-[13px]/[18px] text-ink-secondary">{t("qwenSetup.failedBody")}</p>
          {localQwen?.error && <p className="max-w-md text-[12px]/[16px] text-ink-tertiary">{localQwen.error}</p>}
          <button ref={continueRef} type="button" className="ui-button ui-button-primary mt-2" onClick={() => setDismissed(true)}>{t("qwenSetup.continue")}</button>
        </>
      ) : (
        <>
          <Loader2 size={20} className="animate-spin text-ink-secondary motion-reduce:animate-none" aria-hidden="true" />
          <p role="status" className="text-[14px] text-ink-secondary tabular-nums">{status}</p>
          <p className="max-w-md text-[13px]/[18px] text-ink-secondary">{t("qwenSetup.downloading")}</p>
          {localQwen?.state === "pulling" && (
            <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={status} className="mt-1 h-2 w-64 max-w-full rounded-full bg-raised">
              <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
