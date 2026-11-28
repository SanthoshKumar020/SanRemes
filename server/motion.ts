// Motion (MP4 explainers): the provider seam and the stub that stands in until a paid video-generation key exists.
// No provider is attached and no paid API is ever called from here; the stub refuses in plain words, and the paid
// toggle in the admin settings is what lets a future provider be attempted at all.
import type { AdminSettings } from "./admin-settings.ts";

export const MOTION_NOT_CONFIGURED = "Motion needs a paid video-generation key — none is configured";

export interface MotionResult {
  ok: boolean;
  /** Where the finished video is, when a provider produced one. */
  file?: string;
  /** Plain words for why no video was made. */
  reason?: string;
}

export interface MotionProvider {
  id: string;
  label: string;
  generate(prompt: string): Promise<MotionResult>;
}

/** The only provider shipped: every attempt is refused before any network call, paid or otherwise. */
export function createStubMotionProvider(): MotionProvider {
  return {
    id: "none",
    label: "No video provider",
    generate: async (_prompt: string): Promise<MotionResult> => ({ ok: false, reason: MOTION_NOT_CONFIGURED }),
  };
}

export interface MotionStatus {
  paidEnabled: boolean;
  provider: string;
  ready: boolean;
  reason: string;
}

/** What the admin surface reports: Motion is never ready while no provider is attached, toggle or no toggle. */
export function motionStatus(settings: Pick<AdminSettings, "motionPaid">, provider: MotionProvider = createStubMotionProvider()): MotionStatus {
  if (provider.id === "none") {
    return {
      paidEnabled: settings.motionPaid,
      provider: "none",
      ready: false,
      reason: settings.motionPaid ? MOTION_NOT_CONFIGURED : "Motion is off. It also needs a paid video-generation key.",
    };
  }
  return {
    paidEnabled: settings.motionPaid,
    provider: provider.id,
    ready: settings.motionPaid,
    reason: settings.motionPaid ? "" : "Motion is off.",
  };
}

/** The one call path: off refuses before the provider is consulted, and a stub provider refuses with its own words. */
export async function generateMotion(
  settings: Pick<AdminSettings, "motionPaid">,
  prompt: string,
  provider: MotionProvider = createStubMotionProvider(),
): Promise<MotionResult> {
  if (!settings.motionPaid) return { ok: false, reason: "Motion is off. Switch on the paid toggle first — it still needs a video-generation key." };
  if (!prompt.trim()) return { ok: false, reason: "Say what the video should show." };
  return provider.generate(prompt);
}
