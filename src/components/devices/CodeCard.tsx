import { Check, Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { codeUntil } from "@/lib/pairing-time";

/** "Waiting for it to connect…", then "X is connected". */
export function Waiting({ connected, waiting = t("devicesPage.addFlow.waiting") }: { connected: string | null; waiting?: string }) {
  return connected
    ? <p role="status" data-pair-state="connected" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink"><Check size={14} aria-hidden="true" className="text-success" />{t("devicesPage.addFlow.connected", { name: connected })}</p>
    : <p role="status" data-pair-state="waiting" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary"><Loader2 size={14} aria-hidden="true" className="motion-safe:animate-spin" />{waiting}</p>;
}

/** A code typed by hand: the code, in groups the eye can hold, then until when it works. */
export function TypedCode({ label, code, expiresAt }: { label: string; code: string; expiresAt: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[12px] leading-4 text-ink-tertiary">{label}</span>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span data-pairing-code="" className="font-mono text-[16px] font-medium leading-6 tracking-[0.12em] text-ink tabular-nums">{code}</span>
        <span className="text-[12px] leading-4 text-ink-tertiary">{codeUntil(expiresAt)}</span>
      </span>
    </div>
  );
}

