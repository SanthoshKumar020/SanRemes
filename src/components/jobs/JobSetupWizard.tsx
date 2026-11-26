import { useState, type ChangeEvent, type FormEvent } from "react";
import { Loader2, LockKeyhole } from "lucide-react";

import { t } from "@/lib/i18n";
import {
  DEFAULT_DAILY_CAP, clampDailyCap, dailyCapNeedsRiskConfirm, ensureJobBots, extractResume, fetchPlatforms, savePlatformLogin, saveProfile,
  type Bot, type JobsProfile, type JobsSettings, type JobsState,
} from "@/lib/jobs";
import { requestPanelPage } from "@/lib/page-open";
import { useOptionalStoreRef } from "@/state/store-ref";
import { DEGREE_PATTERN, parseResumeText, type ParsedResumeProfile } from "../../../server/resume-parse.ts";

const FIELD = "w-full min-w-0 rounded-lg border border-hairline/60 bg-inset px-3 py-1.5 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60";
const LABEL = "flex flex-col gap-1 text-[12px] font-medium text-ink-secondary";
const PLATFORMS = [
  { key: "naukri" as const, site: "naukri.com" as const, labelKey: "jobs.platforms.naukri" as const, signInUrl: "https://www.naukri.com/nlogin/login" },
  { key: "linkedin" as const, site: "linkedin.com" as const, labelKey: "jobs.platforms.linkedin" as const, signInUrl: "https://www.linkedin.com/login" },
] as const;

type PlatformKey = (typeof PLATFORMS)[number]["key"];

interface PlatformDraft {
  enabled: boolean;
  username: string;
  password: string;
  twoFactor: boolean;
  loginId: string | null;
  savedUsername: string | null;
  saving: boolean;
  error: string;
  selfOpened: boolean;
  signedIn: boolean | null;
  checking: boolean;
  checkNote: string;
}

function blankPlatform(): PlatformDraft {
  return {
    enabled: false, username: "", password: "", twoFactor: false, loginId: null, savedUsername: null,
    saving: false, error: "", selfOpened: false, signedIn: null, checking: false, checkNote: "",
  };
}

function skillsFromText(text: string): string[] {
  return text.split(",").map((skill) => skill.trim()).filter(Boolean);
}

function splitEducation(value: string): { degree: string; college: string; year: string } {
  const parts = value.split(/[;,]/u).map((part) => part.trim()).filter(Boolean);
  const yearPart = parts.find((part) => /^(?:19|20)\d{2}$/.test(part));
  const rest = parts.filter((part) => part !== yearPart);
  if (!rest.length) return { degree: "", college: "", year: yearPart ?? "" };
  if (DEGREE_PATTERN.test(rest[0]!)) return { degree: rest[0]!, college: rest.slice(1).join(", "), year: yearPart ?? "" };
  if (rest.length === 1) return { degree: rest[0]!, college: "", year: yearPart ?? "" };
  return { degree: "", college: rest.join(", "), year: yearPart ?? "" };
}

function composeEducation(degree: string, college: string, year: string): string {
  return [degree.trim(), college.trim(), year.trim()].filter(Boolean).join(", ");
}

export function JobSetupWizard({ existingBots, initialProfile, initialSettings, onDone }: {
  existingBots: readonly Bot[];
  initialProfile?: JobsProfile | null;
  initialSettings?: JobsSettings;
  onDone: (state: JobsState) => void;
}) {
  const storeRef = useOptionalStoreRef();
  const initialEducation = splitEducation(initialProfile?.education ?? "");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [path, setPath] = useState<"resume" | "manual">("resume");
  const [name, setName] = useState(initialProfile?.name ?? "");
  const [title, setTitle] = useState(initialProfile?.title ?? "");
  const [location, setLocation] = useState(initialProfile?.location ?? "");
  const [yearsText, setYearsText] = useState("");
  const [noticePeriod, setNoticePeriod] = useState(initialProfile?.noticePeriod ?? "");
  const [salaryCurrent, setSalaryCurrent] = useState(initialProfile?.salaryCurrent ?? "");
  const [salaryExpected, setSalaryExpected] = useState(initialProfile?.salaryExpected ?? "");
  const [eduDegree, setEduDegree] = useState(initialEducation.degree);
  const [eduCollege, setEduCollege] = useState(initialEducation.college);
  const [eduYear, setEduYear] = useState(initialEducation.year);
  const [skillsText, setSkillsText] = useState((initialProfile?.skills ?? []).join(", "));
  const [resumeText, setResumeText] = useState(initialProfile?.resumeText ?? "");
  const [resumeFileName, setResumeFileName] = useState(initialProfile?.resumeFileName ?? "");
  const [platforms, setPlatforms] = useState<Record<PlatformKey, PlatformDraft>>({ naukri: blankPlatform(), linkedin: blankPlatform() });
  const [dailyCap, setDailyCap] = useState(initialSettings?.dailyCap ?? DEFAULT_DAILY_CAP);
  const [capConfirmed, setCapConfirmed] = useState(false);
  const [askBeforeEach, setAskBeforeEach] = useState(initialSettings?.autoApply === false);
  const [bots, setBots] = useState<{ resumeBot: Bot; applyBot: Bot } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [extractNote, setExtractNote] = useState("");
  const [parsedNote, setParsedNote] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [savedState, setSavedState] = useState<JobsState | null>(null);

  const education = composeEducation(eduDegree, eduCollege, eduYear);

  const patchPlatform = (key: PlatformKey, patch: Partial<PlatformDraft>) =>
    setPlatforms((current) => ({ ...current, [key]: { ...current[key], ...patch } }));

  const profileBody = (): { profile: Partial<JobsProfile> } => ({
    profile: {
      name: name.trim(), title: title.trim() || undefined, location: location.trim(),
      noticePeriod: noticePeriod.trim() || undefined, salaryCurrent: salaryCurrent.trim() || undefined,
      salaryExpected: salaryExpected.trim() || undefined, skills: skillsFromText(skillsText),
      education: education || undefined,
      resumeText: resumeText.trim() || undefined, resumeFileName: resumeFileName || undefined, updatedAt: Date.now(),
    },
  });

  const applyParsed = (parsed: ParsedResumeProfile) => {
    let filled = false;
    if (parsed.name && !name.trim()) { setName(parsed.name); filled = true; }
    if (parsed.title && !title.trim()) { setTitle(parsed.title); filled = true; }
    if (parsed.locations?.length && !location.trim()) { setLocation(parsed.locations.join(", ")); filled = true; }
    if (parsed.yearsOfExperience !== undefined && !yearsText.trim()) { setYearsText(String(parsed.yearsOfExperience)); filled = true; }
    if (parsed.salaryCurrent && !salaryCurrent.trim()) { setSalaryCurrent(parsed.salaryCurrent); filled = true; }
    if (parsed.salaryExpected && !salaryExpected.trim()) { setSalaryExpected(parsed.salaryExpected); filled = true; }
    if (parsed.noticePeriod && !noticePeriod.trim()) { setNoticePeriod(parsed.noticePeriod); filled = true; }
    if (parsed.skills?.length && !skillsText.trim()) { setSkillsText(parsed.skills.join(", ")); filled = true; }
    if (parsed.education && !eduDegree.trim() && !eduCollege.trim() && !eduYear.trim()) {
      const split = splitEducation(parsed.education);
      setEduDegree(split.degree);
      setEduCollege(split.college);
      setEduYear(split.year);
      filled = true;
    }
    if (filled) setParsedNote(t("jobs.profile.parsed"));
  };

  const readResumeFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setResumeFileName(file.name);
    setExtractNote("");
    setParsedNote("");
    if (/\.txt$|\.md$/i.test(file.name) || file.type.startsWith("text/")) {
      try {
        const text = await file.text();
        setResumeText(text);
        applyParsed(parseResumeText(text));
      } catch {
        setResumeText("");
      }
      return;
    }
    if (/\.pdf$|\.docx$/i.test(file.name)) {
      setExtracting(true);
      try {
        const extracted = await extractResume(file);
        setResumeText(extracted.text);
        setExtractNote(t("jobs.profile.extracted", { name: file.name }));
        applyParsed(parseResumeText(extracted.text));
      } catch (cause) {
        setError(cause instanceof Error && cause.message ? cause.message : t("jobs.error.extract"));
      } finally {
        setExtracting(false);
      }
    }
  };

  const saveStepOne = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !name.trim() || !location.trim()) return;
    setSaving(true);
    setError("");
    try {
      const state = await saveProfile(profileBody());
      setSavedState(state);
      const made = await ensureJobBots(existingBots);
      setBots(made);
      const withBots = await saveProfile({ profile: {}, settings: { applyBotId: made.applyBot.id, resumeBotId: made.resumeBot.id } });
      setSavedState(withBots);
      setStep(2);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("jobs.error.save"));
    } finally {
      setSaving(false);
    }
  };

  const saveLogin = async (key: PlatformKey) => {
    const platform = PLATFORMS.find((entry) => entry.key === key)!;
    const draft = platforms[key];
    if (!bots || draft.saving || !draft.username.trim() || !draft.password) return;
    patchPlatform(key, { saving: true, error: "" });
    try {
      const saved = await savePlatformLogin(platform.site, { username: draft.username.trim(), password: draft.password, totp: "" }, bots.applyBot.id);
      patchPlatform(key, { loginId: saved.id, savedUsername: saved.username, password: "", saving: false });
    } catch (cause) {
      patchPlatform(key, { saving: false, error: cause instanceof Error && cause.message ? cause.message : t("jobs.error.login") });
    }
  };

  const openSelfSignIn = (key: PlatformKey) => {
    const platform = PLATFORMS.find((entry) => entry.key === key)!;
    if (!bots) return;
    if (!storeRef) {
      patchPlatform(key, { error: t("jobs.platforms.selfSignInUnavailable") });
      return;
    }
    requestPanelPage(bots.applyBot.id, platform.signInUrl);
    storeRef.dispatch({ type: "toggleComputer", open: true, botId: bots.applyBot.id });
    patchPlatform(key, { selfOpened: true, error: "" });
  };

  const checkSignIn = async (key: PlatformKey) => {
    if (!bots) return;
    patchPlatform(key, { checking: true, checkNote: "", error: "" });
    try {
      const { platforms: statuses } = await fetchPlatforms();
      const status = statuses.find((entry) => entry.platform === key);
      if (status?.signedIn === true) {
        patchPlatform(key, { signedIn: true, checking: false, checkNote: t("jobs.platforms.signedIn") });
      } else if (status?.signedIn === false) {
        patchPlatform(key, { signedIn: false, checking: false, checkNote: t("jobs.platforms.checkNotSignedIn") });
      } else {
        patchPlatform(key, { checking: false, checkNote: t("jobs.platforms.checkUnknown") });
      }
    } catch (cause) {
      patchPlatform(key, { checking: false, error: cause instanceof Error && cause.message ? cause.message : t("jobs.error.platforms") });
    }
  };

  const saveStepTwo = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || (dailyCapNeedsRiskConfirm(dailyCap) && !capConfirmed)) return;
    setSaving(true);
    setError("");
    try {
      const settings: Partial<JobsSettings> = {
        dailyCap,
        ...(askBeforeEach ? { autoApply: false } : { autoApply: true }),
        ...(bots ? { applyBotId: bots.applyBot.id, resumeBotId: bots.resumeBot.id } : {}),
        platforms: Object.fromEntries(PLATFORMS.map(({ key }) => {
          const draft = platforms[key];
          return [key, { enabled: draft.enabled, ...(draft.loginId ? { loginId: draft.loginId } : {}) }];
        })) as JobsSettings["platforms"],
        twoFactor: Object.fromEntries(PLATFORMS.map(({ key }) => [key, platforms[key].twoFactor])) as JobsSettings["twoFactor"],
      };
      const state = await saveProfile({ profile: {}, settings });
      setSavedState(state);
      setStep(3);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("jobs.error.save"));
    } finally {
      setSaving(false);
    }
  };

  const steps = [t("jobs.setup.step1"), t("jobs.setup.step2"), t("jobs.setup.step3")];
  const capNeedsConfirm = dailyCapNeedsRiskConfirm(dailyCap);

  return (
    <section aria-label={t("jobs.setup.title")} data-jobs-wizard="" className="mx-auto w-full max-w-2xl">
      <ol className="mb-6 flex gap-2" aria-label={t("jobs.setup.title")}>
        {steps.map((label, index) => (
          <li key={label} aria-current={step === index + 1 ? "step" : undefined}
            className={step === index + 1 ? "flex-1 rounded-full bg-ink px-3 py-1.5 text-center text-[12px] font-medium text-panel" : "flex-1 rounded-full bg-raised px-3 py-1.5 text-center text-[12px] text-ink-secondary"}>
            {index + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 1 && (
        <form onSubmit={(event) => void saveStepOne(event)} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2" role="group" aria-label={t("jobs.setup.pathLabel")}>
            <button type="button" aria-pressed={path === "resume"} onClick={() => setPath("resume")}
              className={path === "resume" ? "rounded-xl border border-accent px-3 py-2.5 text-left text-[13px] font-medium text-ink" : "rounded-xl border border-hairline/60 bg-card px-3 py-2.5 text-left text-[13px] text-ink-secondary"}>
              {t("jobs.setup.pathResume")}
            </button>
            <button type="button" aria-pressed={path === "manual"} onClick={() => setPath("manual")}
              className={path === "manual" ? "rounded-xl border border-accent px-3 py-2.5 text-left text-[13px] font-medium text-ink" : "rounded-xl border border-hairline/60 bg-card px-3 py-2.5 text-left text-[13px] text-ink-secondary"}>
              {t("jobs.setup.pathManual")}
            </button>
          </div>
          <p className="text-[12px] leading-snug text-ink-tertiary">{t(path === "resume" ? "jobs.setup.pathResumeHint" : "jobs.setup.pathManualHint")}</p>
          <label className={LABEL}>{t("jobs.profile.name")}
            <input name="profileName" type="text" autoComplete="off" required value={name} onChange={(event) => setName(event.target.value)} disabled={saving} className={FIELD} />
          </label>
          <label className={LABEL}>{t("jobs.profile.title")}
            <input name="profileTitle" type="text" autoComplete="off" value={title} onChange={(event) => setTitle(event.target.value)} disabled={saving} className={FIELD} />
          </label>
          <label className={LABEL}>{t("jobs.profile.location")}
            <input name="profileLocation" type="text" autoComplete="off" required value={location} onChange={(event) => setLocation(event.target.value)} disabled={saving} className={FIELD} />
          </label>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={LABEL}>{t("jobs.profile.years")}
              <input name="profileYears" type="text" autoComplete="off" inputMode="decimal" value={yearsText} onChange={(event) => setYearsText(event.target.value)} disabled={saving} className={FIELD} />
            </label>
            <label className={LABEL}>{t("jobs.profile.noticePeriod")}
              <input name="profileNotice" type="text" autoComplete="off" value={noticePeriod} onChange={(event) => setNoticePeriod(event.target.value)} disabled={saving} className={FIELD} />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className={LABEL}>{t("jobs.profile.salaryCurrent")}
              <input name="profileSalaryCurrent" type="text" autoComplete="off" inputMode="numeric" value={salaryCurrent} onChange={(event) => setSalaryCurrent(event.target.value)} disabled={saving} className={FIELD} />
            </label>
            <label className={LABEL}>{t("jobs.profile.salaryExpected")}
              <input name="profileSalaryExpected" type="text" autoComplete="off" inputMode="numeric" value={salaryExpected} onChange={(event) => setSalaryExpected(event.target.value)} disabled={saving} className={FIELD} />
            </label>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className={LABEL}>{t("jobs.profile.eduDegree")}
              <input name="profileEduDegree" type="text" autoComplete="off" value={eduDegree} onChange={(event) => setEduDegree(event.target.value)} disabled={saving} className={FIELD} />
            </label>
            <label className={LABEL}>{t("jobs.profile.eduCollege")}
              <input name="profileEduCollege" type="text" autoComplete="off" value={eduCollege} onChange={(event) => setEduCollege(event.target.value)} disabled={saving} className={FIELD} />
            </label>
            <label className={LABEL}>{t("jobs.profile.eduYear")}
              <input name="profileEduYear" type="text" autoComplete="off" inputMode="numeric" value={eduYear} onChange={(event) => setEduYear(event.target.value)} disabled={saving} className={FIELD} />
            </label>
          </div>
          <label className={LABEL}>{t("jobs.profile.skills")}
            <textarea name="profileSkills" rows={2} value={skillsText} onChange={(event) => setSkillsText(event.target.value)} disabled={saving} className={FIELD} />
            <span className="text-[12px] font-normal leading-snug text-ink-tertiary">{t("jobs.profile.skillsHint")}</span>
          </label>
          {path === "resume" && (
            <>
              <label className={LABEL}>{t("jobs.profile.resumeFile")}
                <input name="resumeFile" type="file" accept=".txt,.md,.pdf,.docx" onChange={(event) => void readResumeFile(event)} disabled={saving || extracting} className={FIELD} />
                <span className="text-[12px] font-normal leading-snug text-ink-tertiary">{t("jobs.profile.resumeFileHint")}</span>
              </label>
              {resumeFileName && <p role="status" className="text-[12px] text-ink-secondary">{t("jobs.profile.resumeFileKept", { name: resumeFileName })}</p>}
              {extracting && <p role="status" className="text-[12px] text-ink-secondary">{t("jobs.profile.extracting")}</p>}
              {extractNote && <p role="status" className="text-[12px] text-ink-secondary">{extractNote}</p>}
              {parsedNote && <p role="status" className="text-[12px] text-ink-secondary">{parsedNote}</p>}
              <label className={LABEL}>{t("jobs.profile.resumeText")}
                <textarea name="resumeText" rows={8} value={resumeText} onChange={(event) => setResumeText(event.target.value)} disabled={saving} className={FIELD} />
                <span className="text-[12px] font-normal leading-snug text-ink-tertiary">{t("jobs.profile.resumeTextHint")}</span>
              </label>
            </>
          )}
          {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
          <div className="flex justify-end">
            <button type="submit" disabled={saving || !name.trim() || !location.trim()} className="ui-button ui-button-md ui-button-primary inline-flex items-center gap-1.5 disabled:opacity-50">
              {saving && <Loader2 size={13} className="animate-spin" />}{t("jobs.setup.next")}
            </button>
          </div>
        </form>
      )}

      {step === 2 && (
        <form onSubmit={(event) => void saveStepTwo(event)} className="flex flex-col gap-4">
          <p className="rounded-xl border border-warning/40 bg-card px-3.5 py-2.5 text-[13px] leading-relaxed text-ink" role="note">{t("jobs.platforms.riskWarning")}</p>
          <p className="flex items-start gap-1.5 text-[12px] leading-snug text-ink-tertiary">
            <LockKeyhole size={12} aria-hidden="true" className="mt-[2px] shrink-0" />{t("jobs.platforms.vaultNote")}
          </p>
          <p className="text-[12px] leading-snug text-ink-tertiary">{t("jobs.platforms.chromeNote")}</p>
          {PLATFORMS.map(({ key, labelKey }) => {
            const draft = platforms[key];
            return (
              <fieldset key={key} data-jobs-platform={key} className="rounded-xl border border-hairline/60 bg-card p-3.5">
                <legend className="px-1 text-[13px] font-medium text-ink">{t(labelKey)}</legend>
                <label className="flex items-center gap-2 text-[13px] text-ink">
                  <input type="checkbox" checked={draft.enabled} disabled={saving} onChange={(event) => patchPlatform(key, { enabled: event.target.checked })} />
                  {t("jobs.platforms.enable", { platform: t(labelKey) })}
                </label>
                {draft.enabled && (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-hairline/60 bg-card p-3">
                      <p className="text-[13px] font-medium text-ink">{t("jobs.platforms.selfSignIn")}</p>
                      <p className="mt-1 text-[12px] leading-snug text-ink-tertiary">{t("jobs.platforms.selfSignInNote")}</p>
                      <div className="mt-2.5 flex flex-wrap gap-2">
                        <button type="button" disabled={!bots || draft.checking} onClick={() => openSelfSignIn(key)} className="ui-button ui-button-md disabled:opacity-50">{t("jobs.platforms.openSignIn")}</button>
                        <button type="button" disabled={!bots || draft.checking} onClick={() => void checkSignIn(key)} className="ui-button ui-button-md disabled:opacity-50">{draft.checking ? t("jobs.platforms.checkingSignIn") : t("jobs.platforms.checkSignIn")}</button>
                      </div>
                      {draft.signedIn === true && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("jobs.platforms.signedIn")}</p>}
                      {draft.signedIn !== true && draft.checkNote && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{draft.checkNote}</p>}
                      {draft.selfOpened && draft.signedIn !== true && !draft.checkNote && <p role="status" className="mt-2 text-[12px] text-ink-secondary">{t("jobs.platforms.selfSignInOpened")}</p>}
                    </div>
                    <div className="rounded-xl border border-hairline/60 bg-card p-3">
                      <p className="text-[13px] font-medium text-ink">{t("jobs.platforms.saveLoginTitle")}</p>
                      <div className="mt-2.5 flex flex-col gap-2.5">
                        <label className={LABEL}>{t("jobs.platforms.username")}
                          <input name={`${key}Username`} type="text" autoComplete="off" value={draft.username} onChange={(event) => patchPlatform(key, { username: event.target.value })} disabled={saving || draft.saving} className={FIELD} />
                        </label>
                        <label className={LABEL}>{t("jobs.platforms.password")}
                          <input name={`${key}Password`} type="password" autoComplete="new-password" value={draft.password} placeholder="••••••••"
                            onChange={(event) => patchPlatform(key, { password: event.target.value })} disabled={saving || draft.saving} className={FIELD} />
                        </label>
                        <label className="flex items-center gap-2 text-[13px] text-ink">
                          <input type="checkbox" checked={draft.twoFactor} disabled={saving || draft.saving} onChange={(event) => patchPlatform(key, { twoFactor: event.target.checked })} />
                          {t("jobs.platforms.twoFactor")}
                        </label>
                        {draft.twoFactor && <p className="text-[12px] leading-snug text-ink-tertiary">{t("jobs.platforms.twoFactorWarning")}</p>}
                        {draft.savedUsername
                          ? <p role="status" className="text-[12px] text-ink-secondary">{t("jobs.platforms.savedAs", { username: draft.savedUsername })} · {t("jobs.platforms.passwordKept")}</p>
                          : <div><button type="button" disabled={draft.saving || !draft.username.trim() || !draft.password} onClick={() => void saveLogin(key)} className="ui-button ui-button-md disabled:opacity-50">{t("jobs.platforms.saveLogin")}</button></div>}
                      </div>
                    </div>
                  </div>
                )}
                {draft.error && <p role="alert" className="mt-2 text-[12px] text-danger">{draft.error}</p>}
              </fieldset>
            );
          })}
          <label className={LABEL}>{t("jobs.platforms.cap")}
            <input name="dailyCap" type="number" min={1} max={50} value={dailyCap} disabled={saving}
              onChange={(event) => { setDailyCap(clampDailyCap(Number(event.target.value))); setCapConfirmed(false); }} className={FIELD} />
            <span className="text-[12px] font-normal leading-snug text-ink-tertiary">{t("jobs.platforms.capHint")}</span>
          </label>
          {capNeedsConfirm && (
            <div className="rounded-xl border border-warning/40 bg-card px-3.5 py-2.5">
              <p className="text-[13px] leading-relaxed text-ink">{t("jobs.platforms.capRaise")}</p>
              <label className="mt-2 flex items-center gap-2 text-[13px] text-ink">
                <input type="checkbox" checked={capConfirmed} onChange={(event) => setCapConfirmed(event.target.checked)} />
                {t("jobs.platforms.capRaiseConfirm")}
              </label>
            </div>
          )}
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" checked={askBeforeEach} disabled={saving} onChange={(event) => setAskBeforeEach(event.target.checked)} />
            {t("jobs.setup.askBeforeEach")}
          </label>
          <p className="text-[12px] leading-snug text-ink-tertiary">{t("jobs.setup.askBeforeEachHint")}</p>
          {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
          <div className="flex justify-between">
            <button type="button" disabled={saving} onClick={() => setStep(1)} className="ui-button ui-button-md">{t("jobs.setup.back")}</button>
            <button type="submit" disabled={saving || (capNeedsConfirm && !capConfirmed)} className="ui-button ui-button-md ui-button-primary inline-flex items-center gap-1.5 disabled:opacity-50">
              {saving && <Loader2 size={13} className="animate-spin" />}{t("jobs.setup.next")}
            </button>
          </div>
        </form>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-4" data-jobs-review="">
          <h2 className="text-[17px] font-semibold text-ink">{t("jobs.review.title")}</h2>
          <section aria-label={t("jobs.review.profile")} className="rounded-xl border border-hairline/60 bg-card p-3.5 text-[13px] leading-relaxed text-ink-secondary">
            <p><span className="font-medium text-ink">{name.trim()}</span>{title.trim() ? ` · ${title.trim()}` : ""} · {location.trim()}</p>
            {yearsText.trim() && <p className="mt-1">{t("jobs.review.years", { years: yearsText.trim() })}</p>}
            {education && <p className="mt-1">{education}</p>}
            {skillsText.trim() && <p className="mt-1">{skillsText.trim()}</p>}
          </section>
          <section aria-label={t("jobs.review.platforms")} className="rounded-xl border border-hairline/60 bg-card p-3.5 text-[13px] leading-relaxed text-ink-secondary">
            {PLATFORMS.map(({ key, labelKey }) => (
              <p key={key}>{t(labelKey)}: {platforms[key].enabled ? (platforms[key].signedIn ? t("jobs.platforms.signedIn") : (platforms[key].savedUsername ?? t("jobs.review.none"))) : t("jobs.review.none")}</p>
            ))}
            <p>{t("jobs.platforms.cap")}: {dailyCap}</p>
            <p>{t("jobs.setup.askBeforeEach")}: {askBeforeEach ? t("jobs.review.yes") : t("jobs.review.no")}</p>
          </section>
          <section aria-label={t("jobs.review.bots")} className="rounded-xl border border-hairline/60 bg-card p-3.5 text-[13px] leading-relaxed text-ink-secondary">
            {bots ? <p>{t("jobs.setup.botsReady", { resume: bots.resumeBot.name, apply: bots.applyBot.name })}</p> : <p>{t("jobs.error.bots")}</p>}
          </section>
          <p className="text-[12px] leading-snug text-ink-tertiary">{askBeforeEach ? t("jobs.review.finishHint") : t("jobs.review.finishHintAuto")}</p>
          {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
          <div className="flex justify-between">
            <button type="button" onClick={() => setStep(2)} className="ui-button ui-button-md">{t("jobs.setup.back")}</button>
            <button type="button" onClick={() => savedState && onDone(savedState)} disabled={!savedState} className="ui-button ui-button-md ui-button-primary disabled:opacity-50">{t("jobs.setup.finish")}</button>
          </div>
        </div>
      )}
    </section>
  );
}
