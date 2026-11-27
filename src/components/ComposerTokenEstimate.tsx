import { useMemo } from "react";
import { estimateSendTokens } from "../../server/token-estimate/estimate";
import { formatTokens } from "@/lib/usage";
import { t } from "@/lib/i18n";
import type { Attachment } from "@/lib/composer-attachments";
import type { Message } from "@/state/store";

/** The draft plus the thread context, estimated in tokens. Nothing while there is nothing to send. */
export function ComposerTokenEstimate({ draft, messages, attachments, model }: {
  draft: string;
  messages: readonly Message[];
  attachments: readonly Attachment[];
  model?: string;
}) {
  const estimate = useMemo(() => estimateSendTokens({
    draft,
    context: messages.map((message) => message.text ?? ""),
    attachments: attachments.flatMap((attachment) => (attachment.kind === "paste" ? [attachment.text] : [])),
    model,
  }), [draft, messages, attachments, model]);
  if (estimate.totalTokens === 0) return null;
  return (
    <span
      data-token-estimate
      title={t("composer.tokenEstimate.note")}
      className="me-1 shrink-0 text-[12px] leading-4 text-ink-tertiary tabular-nums"
    >
      {t("composer.tokenEstimate.label", { tokens: formatTokens(estimate.totalTokens) })}
    </span>
  );
}
