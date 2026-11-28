import { describe, expect, it } from "vitest";

import { createStubMotionProvider, generateMotion, LOCAL_MOTION_ID, MOTION_NOT_CONFIGURED, motionStatus } from "./motion.ts";

describe("motion stub", () => {
  it("is never ready and refuses every attempt without calling any paid API", async () => {
    expect(motionStatus({ motionPaid: false })).toEqual({
      paidEnabled: false, provider: "none", ready: false, reason: "Motion is off. It also needs a paid video-generation key.",
    });
    expect(motionStatus({ motionPaid: true })).toEqual({
      paidEnabled: true, provider: "none", ready: false, reason: MOTION_NOT_CONFIGURED,
    });
    await expect(createStubMotionProvider().generate("a harbour at dawn")).resolves.toEqual({ ok: false, reason: MOTION_NOT_CONFIGURED });
    await expect(generateMotion({ motionPaid: false }, "a harbour at dawn")).resolves.toEqual({
      ok: false, reason: "Motion is off. Switch on the paid toggle first — it still needs a video-generation key.",
    });
    await expect(generateMotion({ motionPaid: true }, "a harbour at dawn")).resolves.toEqual({ ok: false, reason: MOTION_NOT_CONFIGURED });
    await expect(generateMotion({ motionPaid: true }, "   ")).resolves.toEqual({ ok: false, reason: "Say what the video should show." });
  });

  it("treats the free local provider as ready without the paid toggle", async () => {
    const local = { id: LOCAL_MOTION_ID, label: "Local", generate: async () => ({ ok: true as const, file: "/tmp/motion.mp4" }) };
    expect(motionStatus({ motionPaid: false }, local)).toEqual({ paidEnabled: false, provider: "local", ready: true, reason: "" });
    await expect(generateMotion({ motionPaid: false }, "a harbour at dawn", local)).resolves.toEqual({ ok: true, file: "/tmp/motion.mp4" });
    await expect(generateMotion({ motionPaid: false }, "   ", local)).resolves.toEqual({ ok: false, reason: "Say what the video should show." });
  });
});
