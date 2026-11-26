import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { keySaved } from "@/lib/product-events";
import { addedServers, isAddedServer } from "@/lib/openai-compat-endpoints";
import type { OllamaPull, OllamaStatus } from "../../shared/local-model";
import { KEY_FIELD } from "./keys/KeyRow";
import { OllamaStatusLine } from "./OllamaStatusLine";

/** Ollama ignores the key; the server's add-server route still asks for one. */
const PLACEHOLDER_KEY = "ollama";
const DOWNLOAD_URL = "https://ollama.com/download";

export const ollamaBaseUrl = (origin: string) => `${origin.replace(/\/+$/, "")}/v1`;
const sameBase = (a: string | undefined, b: string) => a?.trim().replace(/\/+$/, "") === b;

/** Finds Ollama on this computer, or at an address someone enters, and adds it in one click: no key, no URL to type. */
export function OllamaServer({ visible }: { visible: boolean }) {
  const { state, dispatch, refreshInstances, refreshModels } = useStore();
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pull, setPull] = useState<OllamaPull>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);

  const latest = useRef(0);
  const looked = useRef(false);

  const check = useCallback((url: string) => {
    const request = ++latest.current;
    setChecking(true);
    setError(null);
    void api<{ status: OllamaStatus }>(`/api/instances/ollama${url ? `?url=${encodeURIComponent(url)}` : ""}`)
      .then((result) => { if (request === latest.current) setStatus(result.status); })
      .catch((cause: Error) => { if (request === latest.current) { setStatus(null); setError(cause.message || t("apiInstances.failed")); } })
      .finally(() => { if (request === latest.current) setChecking(false); });
  }, []);
  // Connections mounts every row, folded or not; a folded section has nothing to show yet.
  useEffect(() => {
    if (!visible || looked.current) return;
    looked.current = true;
    check("");
  }, [visible, check]);

  const pulling = pull.state === "pulling";
  const pullPercent = pull.state === "pulling" ? pull.percent : 0;
  const pullModel = useCallback(() => {
    if (!status || status.state !== "no-models" || pulling) return;
    setError(null);
    setPull({ state: "pulling", percent: 0 });
    void api<{ pull: OllamaPull }>("/api/instances/ollama/pull", {
      method: "POST",
      body: JSON.stringify({ url: status.url }),
    }).catch((cause: Error) => {
      setPull({ state: "idle" });
      setError(cause.message || t("apiInstances.failed"));
    });
  }, [status, pulling]);
  useEffect(() => {
    if (!pulling || !status) return;
    const url = status.url;
    const timer = window.setInterval(() => {
      void api<{ pull: OllamaPull }>(`/api/instances/ollama/pull?url=${encodeURIComponent(url)}`, { background: true })
        .then((result) => {
          setPull(result.pull);
          if (result.pull.state === "ready") check(url);
          if (result.pull.state === "failed") setError(result.pull.error);
        })
        .catch((cause: Error) => {
          setPull({ state: "idle" });
          setError(cause.message || t("apiInstances.failed"));
        });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pulling, status, check]);

  // The added Ollama keeps the list it got when added; a model pulled since shows only in the check until that list reloads.
  const compatUrl = state.config?.openaiCompat?.url;
  const reloaded = useRef<OllamaStatus | null>(null);
  useEffect(() => {
    if (status?.state !== "ready" || reloaded.current === status) return;
    reloaded.current = status;
    const base = ollamaBaseUrl(status.url);
    const stale = state.instances.filter((instance) =>
      (isAddedServer(instance) ? instance.url === base : instance.instanceId === "openaiCompat" && sameBase(compatUrl, base))
      && status.models.some((model) => !instance.models.options.some((option) => option.id === model.name)));
    for (const instance of stale) void refreshModels(instance.instanceId).catch(() => {});
  }, [status, state.instances, compatUrl, refreshModels]);

  const target = status ? ollamaBaseUrl(status.url) : null;
  const present = Boolean(target && (addedServers(state.instances).some((server) => server.url === target) || sameBase(compatUrl, target)));
  const canAdd = Boolean(target && !present && !busy && !checking && !pulling && (status?.state === "ready" || status?.state === "no-models"));

  const add = () => {
    if (!canAdd || !target) return;
    setBusy(true);
    setError(null);
    void api<{ instances?: unknown }>("/api/instances/openai-compat", {
      method: "POST",
      body: JSON.stringify({ displayName: "Ollama", url: target, key: PLACEHOLDER_KEY, catalog: "ollama" }),
    }).then(
      async (created) => {
        keySaved("custom_endpoint", "settings", "unverified");
        if (Array.isArray(created.instances)) dispatch({ type: "instances", instances: created.instances as InstanceInfo[] });
        else await refreshInstances({ reportErrors: true });
      },
      (cause: unknown) => {
        keySaved("custom_endpoint", "settings", "error");
        setError(cause instanceof Error && cause.message ? cause.message : t("apiInstances.failed"));
      },
    ).finally(() => setBusy(false));
  };

  return (
    <div data-ollama-server>
      <div role="status" aria-live="polite">
        {checking
          ? <p className="flex items-center gap-1.5 text-[12px] leading-4 text-ink-secondary"><Loader2 size={12} className="animate-spin" aria-hidden="true" />{t("ollama.checking")}</p>
          : status && <OllamaStatusLine status={status} />}
      </div>
      {!checking && status?.state === "not-running" && (
        <a href={DOWNLOAD_URL} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[12px] font-medium text-accent-text hover:underline">{t("ollama.download")}</a>
      )}
      <div className="mt-2 flex flex-col gap-1.5">
        <input
          type="url"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") check(address.trim()); }}
          placeholder="http://127.0.0.1:11434"
          aria-label={t("ollama.address")}
          spellCheck={false}
          disabled={busy || pulling}
          className={KEY_FIELD}
        />
        <p className="text-[12px] leading-4 text-ink-secondary">{t("ollama.addressHint")}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {status?.state === "no-models" && (
            <button type="button" onClick={pullModel} disabled={pulling || checking || busy} className="ui-button">
              {pulling ? t("ollama.pulling", { percent: pullPercent }) : t("ollama.pull")}
            </button>
          )}
          <button type="button" onClick={add} disabled={!canAdd} className="ui-button">
            {busy ? t("ollama.adding") : t("ollama.add")}
          </button>
          <button type="button" onClick={() => check(address.trim())} disabled={checking || busy || pulling} className="settings-quiet cursor-pointer">
            {t("common.checkAgain")}
          </button>
        </div>
        {pulling && (
          <div className="flex flex-col gap-1">
            <p role="status" className="text-[12px] leading-4 text-ink-secondary tabular-nums">{t("ollama.pulling", { percent: pullPercent })}</p>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pullPercent} aria-valuetext={t("ollama.pulling", { percent: pullPercent })} className="h-2 w-full rounded-full bg-raised">
              <div className="h-full rounded-full bg-success" style={{ width: `${pullPercent}%` }} />
            </div>
          </div>
        )}
        {present && <p className="text-[12px] text-ink-secondary">{t("ollama.added")}</p>}
      </div>
      {error && <div role="alert" className="mt-1 text-[12px] text-danger">{error}</div>}
    </div>
  );
}
