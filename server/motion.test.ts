import { describe, expect, it } from "vitest";

import { createStubMotionProvider, generateMotion, MOTION_NOT_CONFIGURED, motionStatus } from "./motion.ts";

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
});
