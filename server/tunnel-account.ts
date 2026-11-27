// The server's account with the SanRemes control plane: an emailed code signs
// this machine in, the control plane reserves its public address, and the
// service keeps that address while the server runs, re-provisioning it when
// the control plane reclaims it. Nothing here may contain an account bearer,
// installation credential, connector token or Cloudflare resource id.
import {
  ControlPlaneError,
  normalizeAccountEmail,
  normalizeControlPlaneURL,
  type ControlPlaneClient,
} from "../electron/control-plane-client.mjs";
import type { CredentialDocument } from "../electron/secure-credential-state.mjs";

export type { CredentialDocument };

/** The account's fields in the secure credential document. */
export const TUNNEL_CLIENT_INSTANCE_FIELD = "companionClientInstanceId";
export const TUNNEL_ACCOUNT_TOKEN_FIELD = "companionAccountToken";
export const TUNNEL_ACCOUNT_USER_ID_FIELD = "companionAccountUserId";
export const TUNNEL_ACCOUNT_EMAIL_FIELD = "companionAccountEmail";
export const TUNNEL_INSTALLATION_ID_FIELD = "companionInstallationId";
export const TUNNEL_INSTALLATION_CREDENTIAL_FIELD = "companionInstallationCredential";
export const TUNNEL_INSTALLATION_EXPIRY_FIELD = "companionInstallationCredentialExpiresAt";
export const TUNNEL_ACCOUNT_CLEANUP_PENDING_FIELD = "companionAccountCleanupPending";
export const TUNNEL_ENDPOINT_RELEASE_PENDING_FIELD = "companionEndpointReleasePending";

export const TUNNEL_ENDPOINT_FIELD = "managedCompanionEndpointUrl";
export const TUNNEL_TOKEN_FIELD = "managedCompanionConnectorToken";
export const TUNNEL_ORIGIN_VERSION_FIELD = "managedCompanionOriginVersion";
export const TUNNEL_ORIGIN_VERSION = 2;

export const DEFAULT_CONTROL_PLANE_URL = "https://accounts.sanremes.invalid";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID = UUID;
const INSTALLATION_CREDENTIAL = /^omb_install_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

const ownString = (document: CredentialDocument, field: string): string =>
  typeof document?.[field] === "string" ? (document[field] as string) : "";

/** Development must name an exact origin so an OTP or bearer never reaches an accidental host; an invalid override disables the feature. */
export function resolveControlPlaneURL({ isPackaged, environment = process.env }: { isPackaged?: boolean; environment?: NodeJS.ProcessEnv } = {}): string {
  if (Object.hasOwn(environment, "SANREMES_CONTROL_PLANE_URL")) {
    return normalizeControlPlaneURL(environment.SANREMES_CONTROL_PLANE_URL);
  }
  return isPackaged ? DEFAULT_CONTROL_PLANE_URL : "";
}

/** Only a complete HTTPS origin can ever become a tunnel address. */
export function normalizeTunnelEndpoint(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "";
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    return "";
  }
  return parsed.origin;
}

export interface TunnelAccess {
  endpoint: string;
  token: string;
}

function validConnectorToken(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = Buffer.byteLength(value);
  return bytes >= 40 && bytes <= 16 * 1024 && value.trim() === value && !/[\0\r\n\t ]/.test(value);
}

function normalizeTunnelAccess(credentials: CredentialDocument): TunnelAccess | null {
  const endpoint = normalizeTunnelEndpoint(credentials?.[TUNNEL_ENDPOINT_FIELD]);
  const token = credentials?.[TUNNEL_TOKEN_FIELD];
  if (!endpoint || !validConnectorToken(token)) return null;
  return { endpoint, token };
}

/** Fail-closed version gate: an older tunnel still points at the reusable LAN port and must be reconciled before its token starts again. */
export function tunnelAccess(credentials: CredentialDocument): TunnelAccess | null {
  if (credentials?.[TUNNEL_ORIGIN_VERSION_FIELD] !== TUNNEL_ORIGIN_VERSION) return null;
  return normalizeTunnelAccess(credentials);
}

export function withTunnelAccess(credentials: CredentialDocument, provision: { endpoint?: { url?: string }; connectorToken?: string }): CredentialDocument {
  const endpoint = normalizeTunnelEndpoint(provision?.endpoint?.url);
  const token = provision?.connectorToken;
  if (!endpoint || !validConnectorToken(token)) {
    throw new Error("The control plane returned an invalid tunnel endpoint");
  }
  return {
    ...credentials,
    [TUNNEL_ENDPOINT_FIELD]: endpoint,
    [TUNNEL_TOKEN_FIELD]: token,
    [TUNNEL_ORIGIN_VERSION_FIELD]: TUNNEL_ORIGIN_VERSION,
  };
}

export function withoutTunnelAccess(credentials: CredentialDocument): CredentialDocument {
  const next = { ...credentials };
  delete next[TUNNEL_ENDPOINT_FIELD];
  delete next[TUNNEL_TOKEN_FIELD];
  delete next[TUNNEL_ORIGIN_VERSION_FIELD];
  return next;
}

export interface StoredTunnelAccount {
  email: string;
  userId: string;
  accountToken: string;
  installationId: string;
  installationCredential: string;
}

export function storedAccount(credentials: CredentialDocument): StoredTunnelAccount | null {
  const email = normalizeAccountEmail(ownString(credentials, TUNNEL_ACCOUNT_EMAIL_FIELD));
  const userId = ownString(credentials, TUNNEL_ACCOUNT_USER_ID_FIELD);
  if (!email || !userId || userId.length > 256) return null;
  return {
    email,
    userId,
    accountToken: ownString(credentials, TUNNEL_ACCOUNT_TOKEN_FIELD),
    installationId: INSTALLATION_ID.test(ownString(credentials, TUNNEL_INSTALLATION_ID_FIELD))
      ? (credentials[TUNNEL_INSTALLATION_ID_FIELD] as string)
      : "",
    installationCredential: INSTALLATION_CREDENTIAL.test(ownString(credentials, TUNNEL_INSTALLATION_CREDENTIAL_FIELD))
      ? (credentials[TUNNEL_INSTALLATION_CREDENTIAL_FIELD] as string)
      : "",
  };
}

export function accountCleanupPending(credentials: CredentialDocument): boolean {
  return credentials?.[TUNNEL_ACCOUNT_CLEANUP_PENDING_FIELD] === true;
}

export function withoutTunnelAccount(credentials: CredentialDocument): CredentialDocument {
  const next = withoutTunnelAccess(credentials);
  for (const field of [
    TUNNEL_ACCOUNT_TOKEN_FIELD,
    TUNNEL_ACCOUNT_USER_ID_FIELD,
    TUNNEL_ACCOUNT_EMAIL_FIELD,
    TUNNEL_INSTALLATION_ID_FIELD,
    TUNNEL_INSTALLATION_CREDENTIAL_FIELD,
    TUNNEL_INSTALLATION_EXPIRY_FIELD,
    TUNNEL_ACCOUNT_CLEANUP_PENDING_FIELD,
    TUNNEL_ENDPOINT_RELEASE_PENDING_FIELD,
  ]) {
    delete next[field];
  }
  // The installation UUID survives sign-out so a same-account recovery adopts the existing server record.
  return next;
}

export function withInstallationCredentials(
  credentials: CredentialDocument,
  installation: { installation: { id: string }; credential: string; credentialExpiresAt: number | null },
): CredentialDocument {
  const next: CredentialDocument = {
    ...credentials,
    [TUNNEL_INSTALLATION_ID_FIELD]: installation.installation.id,
    [TUNNEL_INSTALLATION_CREDENTIAL_FIELD]: installation.credential,
  };
  if (Number.isSafeInteger(installation.credentialExpiresAt)) {
    next[TUNNEL_INSTALLATION_EXPIRY_FIELD] = installation.credentialExpiresAt;
  } else {
    delete next[TUNNEL_INSTALLATION_EXPIRY_FIELD];
  }
  return next;
}

export function withProvisionedAccount(
  credentials: CredentialDocument,
  { accountToken, user, installation, provision }: {
    accountToken: string;
    user: { id: string; email: string };
    installation: { installation: { id: string }; credential: string; credentialExpiresAt: number | null };
    provision: { endpoint?: { url?: string }; connectorToken?: string };
  },
): CredentialDocument {
  const next: CredentialDocument = {
    ...withInstallationCredentials(withTunnelAccess(credentials, provision), installation),
    [TUNNEL_ACCOUNT_TOKEN_FIELD]: accountToken,
    [TUNNEL_ACCOUNT_USER_ID_FIELD]: user.id,
    [TUNNEL_ACCOUNT_EMAIL_FIELD]: user.email,
  };
  delete next[TUNNEL_ACCOUNT_CLEANUP_PENDING_FIELD];
  delete next[TUNNEL_ENDPOINT_RELEASE_PENDING_FIELD];
  return next;
}

export function withAuthenticatedAccount(
  credentials: CredentialDocument,
  { accountToken, user, clientInstanceId, preserveCleanupPending = false }: {
    accountToken: string;
    user: { id: string; email: string };
    clientInstanceId: string;
    preserveCleanupPending?: boolean;
  },
): CredentialDocument {
  const next: CredentialDocument = {
    ...credentials,
    [TUNNEL_ACCOUNT_TOKEN_FIELD]: accountToken,
    [TUNNEL_ACCOUNT_USER_ID_FIELD]: user.id,
    [TUNNEL_ACCOUNT_EMAIL_FIELD]: user.email,
  };
  if (!UUID.test(ownString(next, TUNNEL_CLIENT_INSTANCE_FIELD))) {
    next[TUNNEL_CLIENT_INSTANCE_FIELD] = clientInstanceId;
  }
  if (preserveCleanupPending) {
    next[TUNNEL_ACCOUNT_CLEANUP_PENDING_FIELD] = true;
  } else {
    delete next[TUNNEL_ACCOUNT_CLEANUP_PENDING_FIELD];
  }
  return next;
}

const FRIENDLY_MESSAGES = Object.freeze({
  invalid_email: "Enter a valid email address.",
  invalid_request: "The secure connection request was not accepted. Check the details and try again.",
  invalid_otp: "That code is not valid. Check the email and try again.",
  otp_expired: "That code expired. Email yourself a new one.",
  unauthorized: "Your sign-in expired. Email yourself a new code to reconnect.",
  forbidden: "The secure connection request was not allowed. Try signing in again.",
  signed_out: "Your sign-in expired. Email yourself a new code to reconnect.",
  network_unavailable: "SanRemes could not reach its secure connection service. Check your internet and try again.",
  rate_limited: "Too many attempts were made. Wait a little, then try again.",
  credential_rotation_rate_limited: "This computer was reconnected too often. Wait a little, then try again.",
  installation_limit_reached: "This account has reached its computer limit. Remove an old computer and try again.",
  installation_exists: "This computer is already connected. Try again to recover it.",
  endpoint_busy: "The secure connection is still being prepared. Try again in a moment.",
  endpoint_rate_limited: "The secure connection service is busy right now. Local pairing still works; try again in {wait}.",
  update_required: "This version of SanRemes can no longer make secure links. Update SanRemes, then try again. Local pairing still works.",
  endpoint_capacity: "Secure HTTPS links are temporarily full. Try again in {wait}, or pair on this network.",
  endpoint_unavailable: "The secure connection service could not finish setup. Local pairing still works. If this keeps happening, contact support with the error reference.",
  endpoint_cleanup_pending: "The secure connection is still being removed. Try signing out again shortly.",
  control_plane_unavailable: "Secure access is not available right now. Local pairing still works.",
  internal_error: "The secure connection service had a problem. Local pairing still works; try again.",
  invalid_response: "The secure connection service returned an unexpected response. Try again.",
  request_failed: "The secure connection request could not be completed. Local pairing still works; try again.",
});

function retryWait(retryAfterMs: number | undefined): string {
  const seconds = Math.ceil((retryAfterMs ?? 0) / 1_000);
  if (!(seconds > 0)) return "a few minutes";
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}

export function friendlyTunnelAccountError(error: unknown): string {
  const code = error instanceof ControlPlaneError ? error.code : "";
  const message = (FRIENDLY_MESSAGES[code as keyof typeof FRIENDLY_MESSAGES] ?? FRIENDLY_MESSAGES.request_failed)
    .replace("{wait}", () => retryWait(error instanceof ControlPlaneError ? error.retryAfterMs : undefined));
  const reference = error instanceof ControlPlaneError && error.requestId ? ` Reference: ${error.requestId}.` : "";
  return `${message}${reference}`;
}

const PROBLEMS = new Set(["unconfigured", "unreachable", "sign_in", "busy", "limit", "update", "address", "failed"]);
type Problem = "unconfigured" | "unreachable" | "sign_in" | "busy" | "limit" | "update" | "address" | "failed";
const PROBLEM_OF: Record<string, Problem> = {
  control_plane_unavailable: "unreachable", network_unavailable: "unreachable",
  unauthorized: "sign_in", forbidden: "sign_in", signed_out: "sign_in", invalid_otp: "sign_in", otp_expired: "sign_in", invalid_email: "sign_in",
  rate_limited: "busy", credential_rotation_rate_limited: "busy", endpoint_rate_limited: "busy", endpoint_busy: "busy", endpoint_capacity: "busy",
  installation_limit_reached: "limit", update_required: "update",
};

/** `problem` is one fixed word for a diagnosis, never a message or a control-plane code. */
function accountProblem(code: string): Problem {
  return PROBLEM_OF[code] ?? "failed";
}

/** `problem` is one fixed word for a diagnosis, never a message or a control-plane code. */
function publicState({ available, status, email, endpoint, message, problem }: {
  available: boolean; status: string; email?: string; endpoint?: string; message?: string; problem?: Problem;
}): TunnelAccountState {
  const state: TunnelAccountState = { available: Boolean(available), status };
  if (problem && PROBLEMS.has(problem)) state.problem = problem;
  const normalizedEmail = normalizeAccountEmail(email);
  if (normalizedEmail) state.email = normalizedEmail;
  const accessEndpoint = (() => {
    if (typeof endpoint !== "string") return "";
    try {
      const parsed = new URL(endpoint);
      return parsed.protocol === "https:" && parsed.pathname === "/" && !parsed.search && !parsed.hash ? parsed.origin : "";
    } catch {
      return "";
    }
  })();
  if (accessEndpoint) state.endpoint = accessEndpoint;
  const safeMessage = typeof message === "string" && message.length >= 1 && message.length <= 280 ? message : null;
  if (safeMessage) state.message = safeMessage;
  return Object.freeze(state);
}

export interface TunnelAccountState {
  available: boolean;
  status: string;
  email?: string;
  endpoint?: string;
  message?: string;
  /** What failed, as one fixed word for a diagnosis: never a message or a control-plane code. */
  problem?: Problem;
}

export interface TunnelAccountService {
  state(): Promise<TunnelAccountState>;
  requestCode(email: string): Promise<TunnelAccountState>;
  verifyCode(email: string, code: string): Promise<TunnelAccountState>;
  retry(): Promise<TunnelAccountState>;
  signOut(): Promise<TunnelAccountState>;
  restore(): Promise<TunnelAccountState>;
  /** Cancels background recovery timers (autoRecover only). */
  dispose(): void;
}

const DEFAULT_HEALTH_CACHE_MS = 30_000;
const DEFAULT_AUTO_RETRY_BASE_MS = 10 * 60_000;
const DEFAULT_AUTO_RETRY_MAX_MS = 6 * 60 * 60_000;
const DEFAULT_ENDPOINT_CHECK_INTERVAL_MS = 15 * 60_000;
const DEFAULT_FIRST_ENDPOINT_CHECK_MS = 2 * 60_000;
const ENDPOINT_NEEDS_RECONCILE = new Set(["deleting", "deleted", "error"]);
/** "ready" too: the connector verifies its route once, so after a long sleep it can report ready for a reclaimed tunnel. */
const WATCHDOG_CHECK_STATES = new Set(["starting", "ready", "retrying", "error"]);

const AUTO_RETRY_CODES = new Set([
  "endpoint_capacity",
  "endpoint_rate_limited",
  "endpoint_unavailable",
  "endpoint_busy",
  "network_unavailable",
  "control_plane_unavailable",
  "internal_error",
  "rate_limited",
  "credential_rotation_rate_limited",
]);

const defaultSetTimer = (callback: () => void, milliseconds: number): unknown => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref?.();
  return timer;
};

export function createTunnelAccountService({
  client,
  readCredentials,
  updateCredentials,
  identity,
  newClientInstanceId,
  activatePersistedEndpoint = async () => ({ status: "stopped", ready: false }),
  stopManagedEndpoint = async () => {},
  managedConnectionState = () => ({ status: "stopped", ready: false }),
  tunnelIsOn = () => false,
  now = Date.now,
  healthCacheMs = DEFAULT_HEALTH_CACHE_MS,
  autoRecover = false,
  setTimer = defaultSetTimer,
  clearTimer = (handle: unknown) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  random = Math.random,
  autoRetryBaseMs = DEFAULT_AUTO_RETRY_BASE_MS,
  autoRetryMaxMs = DEFAULT_AUTO_RETRY_MAX_MS,
  endpointCheckIntervalMs = DEFAULT_ENDPOINT_CHECK_INTERVAL_MS,
  firstEndpointCheckMs = DEFAULT_FIRST_ENDPOINT_CHECK_MS,
  // Only the code, HTTP status, request id and retry delay: never an email, token, credential or address.
  log = () => {},
}: {
  client: ControlPlaneClient | null;
  readCredentials: () => CredentialDocument;
  updateCredentials: (
    derive: (current: CredentialDocument) => CredentialDocument,
    afterPersist?: (next: CredentialDocument) => Promise<void> | void,
  ) => Promise<unknown>;
  /** `kind`: a self-hosted server says `server` on registration and when it asks for its address. */
  identity: { name: string; platform: string; appVersion?: string; kind?: "desktop" | "server" };
  newClientInstanceId: () => string;
  activatePersistedEndpoint?: () => Promise<{ status: string; ready: boolean }>;
  stopManagedEndpoint?: () => Promise<void>;
  managedConnectionState?: () => { status: string; ready: boolean };
  tunnelIsOn?: () => boolean;
  now?: () => number;
  healthCacheMs?: number;
  autoRecover?: boolean;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
  autoRetryBaseMs?: number;
  autoRetryMaxMs?: number;
  endpointCheckIntervalMs?: number;
  firstEndpointCheckMs?: number;
  /** One line per failed setup step: code, HTTP status, request id, retry delay. */
  log?: (line: string) => void;
}): TunnelAccountService {
  const configured = Boolean(client);
  let healthy = false;
  let lastHealthCheck: number | null = null;
  let healthProbe: Promise<boolean> | null = null;
  let phase: { status: string; email?: string; endpoint?: string; message?: string; problem?: Problem } | null = null;
  let transition = Promise.resolve();
  let autoRetryTimer: unknown = null;
  let autoRetryAttempt = 0;
  let watchdogTimer: unknown = null;
  let lastEndpointCheck: number | null = null;
  let disposed = false;

  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = transition.then(work, work);
    transition = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  const credentials = (): CredentialDocument => readCredentials?.() ?? {};

  const cancelAutoRetry = (): void => {
    if (autoRetryTimer !== null) clearTimer(autoRetryTimer);
    autoRetryTimer = null;
  };

  const resetAutoRetry = (): void => {
    cancelAutoRetry();
    autoRetryAttempt = 0;
  };

  let retryFromTimer = (): Promise<unknown> => Promise.resolve();

  const scheduleAutoRetry = (error: unknown): void => {
    if (!autoRecover || disposed || !configured) return;
    if (!(error instanceof ControlPlaneError) || !AUTO_RETRY_CODES.has(error.code)) return;
    const document = credentials();
    if (!storedAccount(document) || accountCleanupPending(document)) return;
    cancelAutoRetry();
    const backoff = Math.min(autoRetryMaxMs, autoRetryBaseMs * 2 ** Math.min(autoRetryAttempt, 20));
    const jittered = Math.round(backoff * (0.8 + 0.4 * random()));
    const delay = Math.min(autoRetryMaxMs, Math.max(jittered, error.retryAfterMs ?? 0));
    autoRetryAttempt += 1;
    writeLog(`tunnel account: retrying ${error.code} in ${Math.round(delay / 1_000)}s (attempt ${autoRetryAttempt})`);
    autoRetryTimer = setTimer(() => {
      autoRetryTimer = null;
      void retryFromTimer().catch(() => {});
    }, delay);
  };

  const probeControlPlane = async ({ force = false } = {}): Promise<boolean> => {
    if (!configured) return false;
    const checkedAt = now();
    if (!force && lastHealthCheck !== null && checkedAt - lastHealthCheck < Math.max(0, healthCacheMs)) {
      return healthy;
    }
    if (healthProbe) return healthProbe;
    healthProbe = (async () => {
      try {
        await client!.health();
        healthy = true;
      } catch {
        healthy = false;
      }
      lastHealthCheck = now();
      return healthy;
    })().finally(() => {
      healthProbe = null;
    });
    return healthProbe;
  };

  const requireHealthyControlPlane = async (): Promise<void> => {
    if (!(await probeControlPlane({ force: true }))) {
      throw new ControlPlaneError("control_plane_unavailable");
    }
  };

  const settledState = (): TunnelAccountState => {
    if (!configured) {
      return publicState({
        available: false,
        status: "signed-out",
        message: FRIENDLY_MESSAGES.control_plane_unavailable, problem: "unconfigured",
      });
    }
    const document = credentials();
    const account = storedAccount(document);
    const persistedAccess = tunnelAccess(document);
    const available = healthy || Boolean(account);
    if (!healthy) {
      return publicState({
        available,
        status: account ? "error" : "signed-out",
        email: account?.email,
        endpoint: persistedAccess?.endpoint,
        message: FRIENDLY_MESSAGES.control_plane_unavailable, problem: "unreachable",
      });
    }
    if (
      phase &&
      ["connecting", "error"].includes(phase.status) &&
      account &&
      persistedAccess &&
      !accountCleanupPending(document) &&
      managedConnectionState?.()?.ready === true
    ) {
      phase = null;
    }
    if (phase) return publicState({ available, ...phase });
    if (!account) return publicState({ available, status: "signed-out" });
    const access = persistedAccess;
    if (!access) {
      return publicState({
        available,
        status: "error",
        email: account.email,
        message: "This computer still needs a secure address. Try again; local pairing continues to work.", problem: "address",
      });
    }
    const connection = managedConnectionState?.() ?? {};
    if (tunnelIsOn()) {
      if (["starting", "retrying"].includes(connection.status)) {
        return publicState({
          available,
          status: "connecting",
          email: account.email,
          endpoint: access.endpoint,
          message: "The secure connection is starting. Local pairing remains available.",
        });
      }
      if (["unavailable", "error"].includes(connection.status)) {
        return publicState({
          available,
          status: "error",
          email: account.email,
          endpoint: access.endpoint,
          message: "The secure connection needs attention. Local pairing still works.", problem: "address",
        });
      }
    }
    return publicState({
      available,
      status: "ready",
      email: account.email,
      endpoint: access.endpoint,
    });
  };

  const ensureClientIdentity = async (): Promise<string> => {
    const existing = ownString(credentials(), TUNNEL_CLIENT_INSTANCE_FIELD);
    if (UUID.test(existing)) return existing;
    const candidate = newClientInstanceId?.();
    if (!UUID.test(candidate ?? "")) throw new Error("A stable computer identity could not be created");
    await updateCredentials((document) => {
      if (UUID.test(ownString(document, TUNNEL_CLIENT_INSTANCE_FIELD))) return document;
      return { ...document, [TUNNEL_CLIENT_INSTANCE_FIELD]: candidate };
    });
    return ownString(credentials(), TUNNEL_CLIENT_INSTANCE_FIELD);
  };

  const markCleanupPending = async (): Promise<void> => {
    await updateCredentials((document) => ({
      ...document,
      [TUNNEL_ACCOUNT_CLEANUP_PENDING_FIELD]: true,
    }));
  };

  const clearAfterCleanup = async (): Promise<void> => {
    await updateCredentials(withoutTunnelAccount);
    await stopManagedEndpoint();
    phase = null;
  };

  /** True only once revocation has scheduled endpoint cleanup, so the local retry credentials may be forgotten. */
  const cleanupCurrentAccount = async ({ markPending = true } = {}): Promise<boolean> => {
    const document = credentials();
    const account = storedAccount(document);
    if (!account) {
      await clearAfterCleanup();
      return true;
    }
    if (markPending && !accountCleanupPending(document)) await markCleanupPending();
    await stopManagedEndpoint();

    // Delete first for immediate feedback; revocation below stays mandatory.
    if (account.installationCredential) {
      try {
        await client!.deleteEndpoint(account.installationCredential);
      } catch {
        // The revocation below still forgets the local account.
      }
    }
    if (!account.accountToken) {
      throw new ControlPlaneError("signed_out", 401);
    }

    // A lost response can leave a server installation with no local ID, so revoke every record matching this computer's UUID before forgetting the bearer.
    const clientInstanceId = ownString(document, TUNNEL_CLIENT_INSTANCE_FIELD);
    if (!UUID.test(clientInstanceId)) {
      throw new ControlPlaneError("invalid_client_identity");
    }

    if (account.installationId) {
      await client!.revokeInstallation(account.accountToken, account.installationId).catch(() => {});
    }
    const installations = await client!.listInstallations(account.accountToken);
    for (const installation of installations) {
      if (
        installation.clientInstanceId !== clientInstanceId &&
        installation.id !== account.installationId
      ) {
        continue;
      }
      try {
        await client!.revokeInstallation(account.accountToken, installation.id);
      } catch (error) {
        if (!(error instanceof ControlPlaneError) || error.status !== 404) throw error;
      }
    }
    try {
      await client!.signOut(account.accountToken);
    } catch {
      // The local account is forgotten either way.
    }
    await clearAfterCleanup();
    return true;
  };

  /** Finish a give-back the control plane left pending: until that removal is done it creates no address for this installation. */
  const finishPendingRelease = async (): Promise<void> => {
    const document = credentials();
    const credential = storedAccount(document)?.installationCredential;
    if (document[TUNNEL_ENDPOINT_RELEASE_PENDING_FIELD] !== true || !credential) return;
    try {
      await client!.deleteEndpoint(credential);
    } catch {
      return;
    }
    await updateCredentials((current) => {
      const next = { ...current };
      delete next[TUNNEL_ENDPOINT_RELEASE_PENDING_FIELD];
      return next;
    });
  };

  const provision = async ({ accountToken, user }: {
    accountToken: string;
    user: { id: string; email: string };
  }): Promise<TunnelAccountState> => {
    const clientInstanceId = await ensureClientIdentity();
    await finishPendingRelease();
    const before = credentials();
    const previous = storedAccount(before);
    const installation = await client!.ensureInstallation({
      accountToken,
      currentCredential:
        previous?.userId === user.id ? previous.installationCredential : "",
      clientInstanceId,
      name: identity.name,
      platform: identity.platform,
      appVersion: identity.appVersion, ...(identity.kind ? { kind: identity.kind } : {}),
    });
    // Persist the verified installation before provisioning, or each Retry rotates the credential until rate-limited.
    try {
      await updateCredentials((document) => withInstallationCredentials(document, installation));
    } catch (error) {
      if (previous?.installationId !== installation.installation.id ||
          previous?.installationCredential !== installation.credential) {
        await client!.revokeInstallation(accountToken, installation.installation.id).catch(() => {});
      }
      throw error;
    }
    // The control plane answers for the address below: no separate check is due.
    lastEndpointCheck = now();
    const endpoint = await client!.ensureEndpoint(installation.credential, { appVersion: identity.appVersion, ...(identity.kind ? { kind: identity.kind } : {}) });
    try {
      await updateCredentials((document) =>
        withProvisionedAccount(document, {
          accountToken,
          user,
          installation,
          provision: endpoint,
        }),
      );
    } catch (error) {
      // Best-effort cleanup avoids an invisible tunnel; no secret ever reaches a log or exception.
      await client!.deleteEndpoint(installation.credential).catch(() => {});
      await client!.revokeInstallation(accountToken, installation.installation.id).catch(() => {});
      throw error;
    }
    resetAutoRetry();
    const connection = await activatePersistedEndpoint();
    phase = null;
    if (
      tunnelIsOn() &&
      connection &&
      ["unavailable", "error"].includes(connection.status)
    ) {
      phase = {
        status: "error",
        email: user.email,
        endpoint: endpoint.endpoint.url,
        message: "The address is ready, but this app could not start its secure connection. Local pairing still works.", problem: "address",
      };
    }
    return settledState();
  };

  const writeLog = (line: string): void => {
    try {
      log(line);
    } catch {
      // Logging never fails the account step.
    }
  };

  const failAction = (
    error: unknown,
    { email, expiredSessionIsSignedOut = false, signedOut = false }: { email?: string; expiredSessionIsSignedOut?: boolean; signedOut?: boolean } = {},
  ): string => {
    const message = friendlyTunnelAccountError(error);
    writeLog(
      error instanceof ControlPlaneError
        ? `tunnel account: setup failed code=${error.code} status=${error.status || "none"} ref=${error.requestId || "none"}`
        : "tunnel account: setup failed on this computer (not a control-plane answer)",
    );
    phase = {
      status:
        signedOut ||
        (expiredSessionIsSignedOut && error instanceof ControlPlaneError && error.status === 401)
          ? "signed-out"
          : "error",
      email,
      message,
      problem: accountProblem(error instanceof ControlPlaneError ? error.code : ""),
    };
    return message;
  };

  const requestCode = (rawEmail: string): Promise<TunnelAccountState> => serialize(async () => {
    if (!configured) throw new Error(FRIENDLY_MESSAGES.control_plane_unavailable);
    const email = normalizeAccountEmail(rawEmail);
    let requested: { email?: string };
    try {
      await requireHealthyControlPlane();
      requested = await client!.requestOTP(email) as { email?: string };
    } catch (error) {
      const message = failAction(error, { email, signedOut: true });
      throw new Error(message);
    }
    phase = {
      status: "signed-out",
      email: requested.email,
    };
    return settledState();
  });

  const verifyCode = (rawEmail: string, rawCode: string): Promise<TunnelAccountState> => serialize(async () => {
    if (!configured) throw new Error(FRIENDLY_MESSAGES.control_plane_unavailable);
    const email = normalizeAccountEmail(rawEmail);
    phase = { status: "connecting", email };
    let verified: { accountToken: string; user: { id: string; email: string } };
    try {
      await requireHealthyControlPlane();
      verified = await client!.verifyOTP(email, rawCode);
    } catch (error) {
      const message = failAction(error, { email, signedOut: true });
      throw new Error(message);
    }

    const previous = storedAccount(credentials());
    const refreshingPendingCleanup = Boolean(
      previous &&
      previous.userId === verified.user.id &&
      accountCleanupPending(credentials()),
    );
    let authenticatedPersisted = false;
    try {
      if (previous && previous.userId !== verified.user.id) {
        await cleanupCurrentAccount();
      }
      const existingIdentity = ownString(credentials(), TUNNEL_CLIENT_INSTANCE_FIELD);
      const clientInstanceId = UUID.test(existingIdentity)
        ? existingIdentity
        : newClientInstanceId?.();
      if (!UUID.test(clientInstanceId ?? "")) {
        throw new Error("A stable computer identity could not be created");
      }
      await updateCredentials((document) =>
        withAuthenticatedAccount(document, {
          ...verified,
          clientInstanceId,
          preserveCleanupPending: refreshingPendingCleanup,
        }),
      );
      authenticatedPersisted = true;
      if (refreshingPendingCleanup) {
        // Finish the interrupted sign-out; never turn it into a new endpoint provisioning.
        await cleanupCurrentAccount({ markPending: false });
        return settledState();
      }
      return await provision(verified);
    } catch (error) {
      if (!authenticatedPersisted) await client!.signOut(verified.accountToken).catch(() => {});
      failAction(error, {
        email: authenticatedPersisted ? verified.user.email : previous?.email ?? email,
        expiredSessionIsSignedOut: authenticatedPersisted,
      });
      if (authenticatedPersisted) scheduleAutoRetry(error);
      return settledState();
    }
  });

  const retryWork = async (): Promise<TunnelAccountState> => {
    if (!configured) return settledState();
    const account = storedAccount(credentials());
    if (!account) {
      phase = null;
      return settledState();
    }
    if (accountCleanupPending(credentials())) {
      phase = { status: "connecting", email: account.email };
      try {
        await requireHealthyControlPlane();
        await cleanupCurrentAccount({ markPending: false });
      } catch (error) {
        failAction(error, { email: account.email, expiredSessionIsSignedOut: true });
      }
      return settledState();
    }
    phase = { status: "connecting", email: account.email };
    try {
      await requireHealthyControlPlane();
      return await provision({
        accountToken: account.accountToken,
        user: { id: account.userId, email: account.email },
      });
    } catch (error) {
      failAction(error, { email: account.email, expiredSessionIsSignedOut: true });
      scheduleAutoRetry(error);
      return settledState();
    }
  };

  const retry = (): Promise<TunnelAccountState> => serialize(async () => retryWork());

  /** Re-provisions only on a definitive "no endpoint" answer; a network or service failure keeps everything as is. */
  const reconcileIfEndpointGone = async ({ onGone = () => retryWork() } = {}): Promise<TunnelAccountState | null> => {
    const document = credentials();
    const account = storedAccount(document);
    const access = tunnelAccess(document);
    if (!account || !access || accountCleanupPending(document)) return null;
    // A stored address without a usable installation credential can never be checked, released or re-issued:
    // provisioning again (with the account) is the only way it is ever asked about.
    if (!account.installationCredential) {
      // Counted as a check, so a provisioning that keeps failing is tried once per check interval, not per event.
      lastEndpointCheck = now();
      return onGone();
    }
    if (typeof client!.getEndpoint !== "function") return null;
    lastEndpointCheck = now();
    let endpoint: { url: string; status: string } | null;
    try {
      endpoint = await client!.getEndpoint(account.installationCredential);
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status === 401) return onGone();
      return null;
    }
    if (endpoint && endpoint.url === access.endpoint && !ENDPOINT_NEEDS_RECONCILE.has(endpoint.status)) {
      return null;
    }
    return onGone();
  };

  const endpointCheckDue = (): boolean =>
    lastEndpointCheck === null || now() - lastEndpointCheck >= endpointCheckIntervalMs / 2;

  /** Only while the tunnel is running: a check-in marks a reclaimed tunnel as recently seen. */
  const recoveryDue = ({ atLaunch = false } = {}): boolean => {
    if (!autoRecover || !tunnelIsOn()) return false;
    if (atLaunch) return true;
    if (autoRetryTimer !== null) return false;
    const connection = managedConnectionState?.() ?? {};
    return WATCHDOG_CHECK_STATES.has(connection.status) && endpointCheckDue();
  };

  const watchdogTick = (): void => {
    watchdogTimer = null;
    if (disposed) return;
    watchdogTimer = setTimer(watchdogTick, endpointCheckIntervalMs);
    if (phase?.status === "signed-out") return;
    if (recoveryDue()) void serialize(() => reconcileIfEndpointGone()).catch(() => {});
  };

  const startWatchdog = (): void => {
    if (!autoRecover || disposed || !configured || watchdogTimer !== null) return;
    watchdogTimer = setTimer(watchdogTick, firstEndpointCheckMs);
  };

  const signOut = (): Promise<TunnelAccountState> => serialize(async () => {
    resetAutoRetry();
    if (!storedAccount(credentials())) {
      await clearAfterCleanup();
      return settledState();
    }
    const email = storedAccount(credentials())?.email;
    phase = { status: "connecting", email };
    try {
      // No health preflight: local access must stop on Sign out even when the control plane is down.
      await cleanupCurrentAccount();
      healthy = true;
      lastHealthCheck = now();
      return settledState();
    } catch (error) {
      failAction(error, { email });
      return settledState();
    }
  });

  const restore = (): Promise<TunnelAccountState> => serialize(async () => {
    if (!configured) return settledState();
    startWatchdog();
    if (!(await probeControlPlane({ force: true }))) return settledState();
    if (accountCleanupPending(credentials())) return retryWork();
    await ensureClientIdentity();
    const account = storedAccount(credentials());
    if (account && !tunnelAccess(credentials())) return retryWork();
    if (autoRecover && account && tunnelIsOn()) {
      const reconciled = await reconcileIfEndpointGone();
      if (reconciled) return reconciled;
    }
    phase = null;
    return settledState();
  });

  const dispose = (): void => {
    disposed = true;
    cancelAutoRetry();
    if (watchdogTimer !== null) clearTimer(watchdogTimer);
    watchdogTimer = null;
  };

  retryFromTimer = () => serialize(retryWork);

  return Object.freeze({
    state: async () => {
      await probeControlPlane();
      return settledState();
    },
    requestCode,
    verifyCode,
    retry,
    signOut,
    restore,
    dispose,
  });
}
