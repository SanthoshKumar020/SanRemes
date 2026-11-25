import { useState } from "react";

import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import {
  proposalSummary,
  type PendingProposal,
  type StructuredNotesDoc,
} from "@/lib/memory";
import { localizedRelativeTime } from "@/lib/relative-time";
import { inputCls } from "./field";

const buttonCls = "rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50";
const quietButtonCls = "rounded-md px-2 py-1 text-[13px] text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-50";

/** What the owner can do to structured notes and learned skills from the panel. Forgetting is a two-step
 * arm-then-confirm inside the panel: no dialog, and nothing is lost to a stray click. */
export type StructuredNotesAction =
  | { type: "approve"; id: string }
  | { type: "deny"; id: string }
  | { type: "confirm-note"; path: string }
  | { type: "archive-note"; path: string }
  | { type: "restore-note"; path: string }
  | { type: "forget-note"; path: string }
  | { type: "edit-note"; path: string; text: string }
  | { type: "forget-skill"; name: string }
  | { type: "maintain" };

export function StructuredNotesCard({ doc, pending, busy, onAction }: {
  doc: StructuredNotesDoc | null;
  pending: PendingProposal[] | null;
  busy: boolean;
  onAction: (action: StructuredNotesAction) => void;
}) {
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [arming, setArming] = useState<string | null>(null);
  const loading = doc === null || pending === null;
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("memory.structured.title")}</div>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("memory.structured.help")}</p>
      {loading ? (
        <p className="mt-3 text-[13px] text-ink-secondary">{t("memory.structured.loading")}</p>
      ) : (
        <>
          {pending.length > 0 && (
            <div className="mt-3 rounded-lg border border-accent/40 bg-accent/10 p-3">
              <div className="text-[13px] font-medium text-ink">{t("memory.structured.pendingTitle")}</div>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("memory.structured.pendingHelp")}</p>
              <ul className="mt-2 flex flex-col gap-3">
                {pending.map((proposal) => (
                  <li key={proposal.id} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-ink">{proposalSummary(proposal)}</span>
                    <span className="text-[12px] text-ink-secondary">
                      {localizedRelativeTime(Date.parse(proposal.createdAt), activeLocale())} · {t(proposal.proposedBy === "agent" ? "memory.structured.proposedByBot" : "memory.structured.proposedByYou")}
                    </span>
                    <button type="button" className={buttonCls} disabled={busy} onClick={() => onAction({ type: "approve", id: proposal.id })}>
                      {t("memory.structured.approve")}
                    </button>
                    <button type="button" className={quietButtonCls} disabled={busy} onClick={() => onAction({ type: "deny", id: proposal.id })}>
                      {t("memory.structured.discard")}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4">
            <div className="text-[13px] font-medium text-ink">{t("memory.structured.notesTitle")}</div>
            {doc.notes.length === 0 ? (
              <p className="mt-1 text-[13px] text-ink-secondary">{t("memory.structured.emptyNotes")}</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-3">
                {doc.notes.map((note) => (
                  <li key={note.path} className="rounded-lg border border-hairline/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12px] text-ink-secondary">{note.path}</span>
                      {note.status !== "stated" && (
                        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                          {note.status === "tentative" ? t("memory.structured.tentative") : note.status}
                        </span>
                      )}
                      <span className="text-[12px] text-ink-secondary">
                        {localizedRelativeTime(Date.parse(note.updated), activeLocale())} · {note.sources.length === 1 ? t("memory.structured.sourceOne") : t("memory.structured.sourceMany", { count: note.sources.length })}
                      </span>
                    </div>
                    {editingPath === note.path ? (
                      <>
                        <textarea
                          className={cn(inputCls, "mt-2 min-h-[64px] resize-y text-[13px] leading-relaxed")}
                          value={editingText}
                          aria-label={t("memory.structured.edit")}
                          onChange={(e) => setEditingText(e.target.value)}
                        />
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            className={buttonCls}
                            disabled={busy || !editingText.trim()}
                            onClick={() => { onAction({ type: "edit-note", path: note.path, text: editingText }); setEditingPath(null); }}
                          >
                            {t("memory.structured.save")}
                          </button>
                          <button type="button" className={quietButtonCls} onClick={() => setEditingPath(null)}>
                            {t("memory.structured.cancel")}
                          </button>
                        </div>
                      </>
                    ) : (
                      <p className="mt-1 text-[13px] leading-relaxed text-ink">{note.text}</p>
                    )}
                    {editingPath !== note.path && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {note.status !== "stated" && (
                          <button type="button" className={quietButtonCls} disabled={busy} onClick={() => onAction({ type: "confirm-note", path: note.path })}>
                            {t("memory.structured.confirm")}
                          </button>
                        )}
                        <button type="button" className={quietButtonCls} disabled={busy} onClick={() => { setEditingPath(note.path); setEditingText(note.text); }}>
                          {t("memory.structured.edit")}
                        </button>
                        <button type="button" className={quietButtonCls} disabled={busy} onClick={() => onAction({ type: "archive-note", path: note.path })}>
                          {t("memory.structured.archive")}
                        </button>
                        {arming === `note:${note.path}` ? (
                          <>
                            <button type="button" className={quietButtonCls} disabled={busy} onClick={() => { onAction({ type: "forget-note", path: note.path }); setArming(null); }}>
                              {t("memory.structured.forgetForGood")}
                            </button>
                            <button type="button" className={quietButtonCls} onClick={() => setArming(null)}>
                              {t("memory.structured.cancel")}
                            </button>
                          </>
                        ) : (
                          <button type="button" className={quietButtonCls} disabled={busy} onClick={() => setArming(`note:${note.path}`)}>
                            {t("memory.structured.forget")}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {doc.archive.length > 0 && (
            <div className="mt-4">
              <div className="text-[13px] font-medium text-ink">{t("memory.structured.archivedTitle")}</div>
              <ul className="mt-2 flex flex-col gap-3">
                {doc.archive.map((entry) => (
                  <li key={`${entry.path}:${entry.archived}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-hairline/40 p-3">
                    <span className="font-mono text-[12px] text-ink-secondary">{entry.path}</span>
                    <span className="min-w-0 flex-1 text-[13px] text-ink-secondary">{entry.text}</span>
                    <span className="text-[12px] text-ink-secondary">{entry.reason}</span>
                    <button type="button" className={quietButtonCls} disabled={busy} onClick={() => onAction({ type: "restore-note", path: entry.path })}>
                      {t("memory.structured.restore")}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-4">
            <div className="text-[13px] font-medium text-ink">{t("memory.structured.skillsTitle")}</div>
            {doc.skills.length === 0 ? (
              <p className="mt-1 text-[13px] text-ink-secondary">{t("memory.structured.emptySkills")}</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-3">
                {doc.skills.map((skill) => (
                  <li key={skill.name} className="rounded-lg border border-hairline/40 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12px] text-ink">{skill.name}</span>
                      {skill.edited !== null && (
                        <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">{t("memory.structured.editedByYou")}</span>
                      )}
                      <span className="text-[12px] text-ink-secondary">{localizedRelativeTime(Date.parse(skill.updated), activeLocale())}</span>
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed text-ink">{skill.description}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {arming === `skill:${skill.name}` ? (
                        <>
                          <button type="button" className={quietButtonCls} disabled={busy} onClick={() => { onAction({ type: "forget-skill", name: skill.name }); setArming(null); }}>
                            {t("memory.structured.forgetForGood")}
                          </button>
                          <button type="button" className={quietButtonCls} onClick={() => setArming(null)}>
                            {t("memory.structured.cancel")}
                          </button>
                        </>
                      ) : (
                        <button type="button" className={quietButtonCls} disabled={busy} onClick={() => setArming(`skill:${skill.name}`)}>
                          {t("memory.structured.forget")}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-4">
            <button type="button" className={buttonCls} disabled={busy} onClick={() => onAction({ type: "maintain" })}>
              {t("memory.structured.maintain")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
