import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, MessageSquare, Play, Plus, RefreshCw, Square, Trash2, Video } from "lucide-react";

import { useStoreDispatch } from "@/state/store-select";
import { useStore } from "@/state/store";
import { TOOL_PAGE_TITLE, ToolPage, ToolPageActions, ToolPageHeader } from "./ToolPageShell";
import {
  addCompanionTranscript, answerCompanionQuestion, askCompanionQuestion, createMeetingCompanion, deleteMeetingCompanion,
  fetchCompanionNotesText, fetchMeetingCompanion, fetchMeetingCompanions, saveCompanionNotes, setCompanionArtifacts,
  startMeetingCompanion, stopMeetingCompanion,
  type CompanionSummary, type MeetingCompanion,
} from "@/lib/meetings";

/** Meeting companion: you join the Google Meet yourself; this keeps the notes, the transcript lines the browser can see, the questions asked in the call, and the live Doc or Whiteboard. */
export function MeetingsPage() {
  const dispatch = useStoreDispatch();
  const { state } = useStore();
  const [meetings, setMeetings] = useState<CompanionSummary[] | null>(null);
  const [selected, setSelected] = useState<MeetingCompanion | null>(null);
  const [notesText, setNotesText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [line, setLine] = useState("");
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState("");
  const [docTitle, setDocTitle] = useState("");
  const [whiteboardTitle, setWhiteboardTitle] = useState("");
  const back = useRef<HTMLButtonElement>(null);
  const loadAbort = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    try {
      const payload = await fetchMeetingCompanions();
      if (controller.signal.aborted) return;
      setMeetings(payload.meetings);
      setError(null);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (loadAbort.current === controller) loadAbort.current = null;
    }
  }, []);

  const open = useCallback(async (id: string) => {
    try {
      const [detail, text] = await Promise.all([fetchMeetingCompanion(id), fetchCompanionNotesText(id)]);
      setSelected(detail.meeting);
      setNotesText(text.text);
      setSummary(detail.meeting.notes.summary);
      setDocTitle(detail.meeting.artifacts.docTitle ?? "");
      setWhiteboardTitle(detail.meeting.artifacts.whiteboardTitle ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    back.current?.focus({ preventScroll: true });
    void load();
    return () => { loadAbort.current?.abort(); };
  }, [load]);

  const act = async (key: string, work: () => Promise<unknown>, done?: string, reopen = true) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await work();
      if (done) setNotice(done);
      await load();
      if (reopen && selected) await open(selected.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    if (!url.trim()) return;
    const created = await act("create", () => createMeetingCompanion({
      url: url.trim(),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(state.bots[0]?.id ? { botId: state.bots[0].id } : {}),
    }), "Meeting companion created. Join the Meet yourself, then start it.");
    void created;
    setUrl("");
    setTitle("");
    setShowForm(false);
  };

  const statusLabel = (meeting: Pick<MeetingCompanion, "status">): string =>
    meeting.status === "live" ? "Live now" : meeting.status === "ended" ? "Ended" : "Waiting for you to join";

  return (
    <ToolPage label="Meetings">
      <ToolPageHeader backLabel="Back" onBack={() => dispatch({ type: "showChat" })} backRef={back}>
        <h1 className={TOOL_PAGE_TITLE}>Meetings</h1>
        <span className="text-[13px] text-ink-secondary">Notes and questions for the Google Meet you join yourself.</span>
        <ToolPageActions>
          <button type="button" className="ui-button ui-button-md" onClick={() => void load()} disabled={busy !== null}>
            <RefreshCw size={16} aria-hidden="true" />
            Reload
          </button>
          <button type="button" className="ui-button ui-button-md ui-button-primary" onClick={() => setShowForm((openForm) => !openForm)}>
            <Plus size={16} aria-hidden="true" />
            New meeting
          </button>
        </ToolPageActions>
      </ToolPageHeader>

      {error && <p role="status" className="mt-3 text-[13px] text-danger">{error}</p>}
      {notice && <p role="status" className="mt-3 text-[13px] text-ink-secondary">{notice}</p>}

      <p className="mt-3 text-[13px] text-ink-secondary">
        The companion never joins a meeting by itself and never records silently. You join the Meet in your browser and
        approve it there; the companion only keeps the notes, the transcript lines the browser can see, and the questions
        asked in the call.
      </p>

      {showForm && (
        <section aria-label="New meeting" className="mt-4 rounded-xl border border-hairline p-4">
          <div className="grid gap-3">
            <label className="grid gap-1 text-[13px] text-ink-secondary">
              Google Meet link
              <input
                className="rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://meet.google.com/abc-defg-hij"
                dir="auto"
              />
            </label>
            <label className="grid gap-1 text-[13px] text-ink-secondary">
              Title
              <input
                className="rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Weekly sync"
                dir="auto"
              />
            </label>
            <div>
              <button
                type="button"
                className="ui-button ui-button-md ui-button-primary"
                disabled={busy === "create" || !url.trim()}
                onClick={() => void create()}
              >
                Create companion
              </button>
            </div>
          </div>
        </section>
      )}

      {!meetings ? (
        <p className="mt-6 text-[13px] text-ink-secondary">Loading…</p>
      ) : meetings.length === 0 ? (
        <p className="mt-6 text-[13px] text-ink-secondary">No meetings yet. Paste a Google Meet link to start one.</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {meetings.map((meeting) => (
            <li key={meeting.id} className="rounded-xl border border-hairline p-4">
              <div className="flex items-start justify-between gap-3">
                <button type="button" className="min-w-0 text-left" onClick={() => void open(meeting.id)}>
                  <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
                    <Video size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
                    <span className="truncate">{meeting.title}</span>
                  </p>
                  <p className="mt-1 text-[12px] text-ink-tertiary">
                    {statusLabel(meeting)} · {meeting.lines} transcript lines · {meeting.unanswered} unanswered questions
                  </p>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  {meeting.status === "waiting" && (
                    <button
                      type="button"
                      className="ui-icon-button"
                      aria-label="Start companion — I joined the meeting myself"
                      title="Start companion — I joined the meeting myself"
                      disabled={busy === `start:${meeting.id}`}
                      onClick={() => void act(`start:${meeting.id}`, () => startMeetingCompanion(meeting.id), "Companion is live.")}
                    >
                      <Play size={16} aria-hidden="true" />
                    </button>
                  )}
                  {meeting.status === "live" && (
                    <button
                      type="button"
                      className="ui-icon-button"
                      aria-label="Stop companion"
                      title="Stop companion"
                      disabled={busy === `stop:${meeting.id}`}
                      onClick={() => void act(`stop:${meeting.id}`, () => stopMeetingCompanion(meeting.id), "Companion stopped.")}
                    >
                      <Square size={16} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="ui-icon-button"
                    aria-label="Delete meeting"
                    title="Delete meeting"
                    disabled={busy === `delete:${meeting.id}`}
                    onClick={() => {
                      if (selected?.id === meeting.id) setSelected(null);
                      void act(`delete:${meeting.id}`, () => deleteMeetingCompanion(meeting.id), "Meeting deleted.", false);
                    }}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <section aria-label={selected.title} className="mt-6 rounded-xl border border-hairline p-4">
          <h2 className="text-[15px] font-medium text-ink">{selected.title}</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">{statusLabel(selected)} · {selected.url}</p>

          {selected.status === "live" && (
            <div className="mt-3 grid gap-2">
              <label className="grid gap-1 text-[13px] text-ink-secondary">
                Add a transcript line (from the captions you can see)
                <span className="flex gap-2">
                  <input
                    className="w-28 rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                    value={speaker}
                    onChange={(event) => setSpeaker(event.target.value)}
                    placeholder="Speaker"
                    dir="auto"
                  />
                  <input
                    className="min-w-0 flex-1 rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                    value={line}
                    onChange={(event) => setLine(event.target.value)}
                    placeholder="What was said"
                    dir="auto"
                  />
                </span>
              </label>
              <div>
                <button
                  type="button"
                  className="ui-button ui-button-md"
                  disabled={busy === "line" || !line.trim()}
                  onClick={() => void act("line", () => addCompanionTranscript(selected.id, { ...(speaker.trim() ? { speaker: speaker.trim() } : {}), text: line.trim() }))}
                >
                  Add line
                </button>
              </div>
              <label className="grid gap-1 text-[13px] text-ink-secondary">
                Ask a question in the call
                <input
                  className="rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="What was asked?"
                  dir="auto"
                />
              </label>
              <div>
                <button
                  type="button"
                  className="ui-button ui-button-md"
                  disabled={busy === "question" || !question.trim()}
                  onClick={() => void act("question", () => askCompanionQuestion(selected.id, { text: question.trim() }))}
                >
                  <MessageSquare size={16} aria-hidden="true" />
                  Record question
                </button>
              </div>
            </div>
          )}

          {selected.questions.length > 0 && (
            <div className="mt-4 grid gap-2">
              <h3 className="text-[13px] font-medium text-ink">Questions</h3>
              {selected.questions.map((item) => (
                <div key={item.id} className="text-[13px] text-ink-secondary">
                  <p dir="auto">{item.from ? `${item.from}: ` : ""}{item.text}</p>
                  {item.answer
                    ? <p className="mt-0.5 text-ink-tertiary" dir="auto">Answer: {item.answer}</p>
                    : (
                      <span className="mt-1 flex gap-2">
                        <input
                          className="min-w-0 flex-1 rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                          value={answers[item.id] ?? ""}
                          onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))}
                          placeholder="Answer it here"
                          dir="auto"
                        />
                        <button
                          type="button"
                          className="ui-button ui-button-md"
                          disabled={busy === `answer:${item.id}` || !(answers[item.id] ?? "").trim()}
                          onClick={() => void act(`answer:${item.id}`, () => answerCompanionQuestion(selected.id, item.id, (answers[item.id] ?? "").trim()))}
                        >
                          Answer
                        </button>
                      </span>
                    )}
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 grid gap-2">
            <label className="grid gap-1 text-[13px] text-ink-secondary">
              Summary
              <textarea
                className="min-h-20 rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                dir="auto"
              />
            </label>
            <div>
              <button
                type="button"
                className="ui-button ui-button-md"
                disabled={busy === "notes" || !summary.trim()}
                onClick={() => void act("notes", () => saveCompanionNotes(selected.id, {
                  summary: summary.trim(),
                  decisions: selected.notes.decisions,
                  actionItems: selected.notes.actionItems,
                  openQuestions: selected.notes.openQuestions,
                }), "Notes saved.")}
              >
                Save notes
              </button>
            </div>
            <label className="grid gap-1 text-[13px] text-ink-secondary">
              Live Doc the notes go into
              <input
                className="rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                value={docTitle}
                onChange={(event) => setDocTitle(event.target.value)}
                placeholder="Weekly sync notes"
                dir="auto"
              />
            </label>
            <div>
              <button
                type="button"
                className="ui-button ui-button-md"
                disabled={busy === "artifacts" || !docTitle.trim()}
                onClick={() => void act("artifacts", () => setCompanionArtifacts(selected.id, { docTitle: docTitle.trim() }), "Doc named.")}
              >
                <FileText size={16} aria-hidden="true" />
                Name the Doc
              </button>
            </div>
            <label className="grid gap-1 text-[13px] text-ink-secondary">
              Live Whiteboard the notes go onto
              <input
                className="rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                value={whiteboardTitle}
                onChange={(event) => setWhiteboardTitle(event.target.value)}
                placeholder="Weekly sync board"
                dir="auto"
              />
            </label>
            <div>
              <button
                type="button"
                className="ui-button ui-button-md"
                disabled={busy === "artifacts" || !whiteboardTitle.trim()}
                onClick={() => void act("artifacts", () => setCompanionArtifacts(selected.id, { whiteboardTitle: whiteboardTitle.trim() }), "Whiteboard named.")}
              >
                <FileText size={16} aria-hidden="true" />
                Name the Whiteboard
              </button>
            </div>
          </div>

          {notesText && (
            <label className="mt-4 grid gap-1 text-[13px] text-ink-secondary">
              Notes as Markdown — paste into a Doc or onto a Whiteboard
              <textarea
                className="min-h-32 rounded-lg border border-hairline bg-control px-3 py-2 text-[13px] text-ink"
                value={notesText}
                readOnly
                dir="auto"
              />
            </label>
          )}
        </section>
      )}
    </ToolPage>
  );
}
