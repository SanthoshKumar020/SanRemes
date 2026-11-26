import { resumeDiff, type ResumeDiffLine } from "@/lib/jobs";
import { t } from "@/lib/i18n";

/** Added and removed lines between the base resume and a tailored one, so invented lines stand out. */
export function ResumeDiff({ base, tailored }: { base: string; tailored: string }) {
  const lines: ResumeDiffLine[] = resumeDiff(base, tailored);
  return (
    <div aria-label={t("jobs.resumes.diffTitle")} className="mt-2 rounded-lg border border-hairline/60 bg-inset p-3">
      <p className="text-[12px] leading-snug text-ink-tertiary">{t("jobs.resumes.diffNote")}</p>
      <div className="mt-2 flex flex-col gap-0.5 font-mono text-[12px] leading-relaxed">
        {lines.map((line, index) => (
          <p key={index} className={line.type === "added" ? "font-medium text-ink" : line.type === "removed" ? "text-ink-tertiary line-through" : "text-ink-secondary"}>
            {line.type === "added" ? `+ ${line.text}` : line.type === "removed" ? `− ${line.text}` : `  ${line.text}`}
          </p>
        ))}
      </div>
    </div>
  );
}
