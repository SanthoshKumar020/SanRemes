// Motion's free local provider: a template-based animated explainer rendered with ffmpeg — the prompt's sentences
// become scenes, each a title card that fades in and out over an alternating background with a sliding accent bar.
// It is animation, not AI-generated footage: no model, no key, no network. It needs ffmpeg and a TrueType font on
// the machine; without either it refuses in plain words and the paid stub stands.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { execFileInGroupAsync } from "./group-exec.ts";
import { LOCAL_MOTION_ID, type MotionProvider, type MotionResult } from "./motion.ts";
const MAX_SCENES = 8;
const MAX_SCENE_CHARS = 120;
const WRAP_WIDTH = 34;
const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 24;
const BACKGROUNDS = ["0x1a1a2e", "0x16213e", "0x0f3460", "0x1b1b2f"];
const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "C:\\Windows\\Fonts\\arial.ttf",
  "C:\\Windows\\Fonts\\segoeui.ttf",
];

/** The prompt's sentences, in order, at most eight, each short enough to fit a title card. */
export function scenesFor(prompt: string): string[] {
  const scenes: string[] = [];
  for (const line of prompt.split("\n")) {
    for (const piece of line.split(/(?<=[.!?])\s+/)) {
      const text = piece.trim();
      if (!text) continue;
      scenes.push(text.length > MAX_SCENE_CHARS ? `${text.slice(0, MAX_SCENE_CHARS - 1).trimEnd()}…` : text);
      if (scenes.length >= MAX_SCENES) return scenes;
    }
  }
  return scenes;
}

/** Word-wrapped lines for one title card, each short enough for the frame at the title size. */
export function wrapText(text: string, width = WRAP_WIDTH): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function resolveMotionFont(): string | null {
  const fromEnv = process.env.SANREMES_MOTION_FONT?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of FONT_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function findFfmpeg(): boolean {
  try {
    return spawnSync("ffmpeg", ["-version"], { timeout: 5000, stdio: "ignore", windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}

/** Whether the local provider can render on this machine, and why not when it cannot. */
export function localMotionStatus(): { available: boolean; reason: string } {
  if (!findFfmpeg()) return { available: false, reason: "ffmpeg was not found on this machine, so no local video can be rendered." };
  if (!resolveMotionFont()) return { available: false, reason: "No TrueType font was found on this machine, so titles cannot be drawn." };
  return { available: true, reason: "" };
}

/** Colons and backslashes end an ffmpeg filter option, so paths inside a filter escape them. */
function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

export interface LocalMotionProviderOptions {
  outDir: string;
  secondsPerScene?: number;
  now?: () => number;
}

export function createLocalMotionProvider(options: LocalMotionProviderOptions): MotionProvider {
  const seconds = options.secondsPerScene ?? 3;
  const now = options.now ?? Date.now;
  return {
    id: LOCAL_MOTION_ID,
    label: "Local animated explainer (ffmpeg)",
    generate: async (prompt: string): Promise<MotionResult> => {
      const status = localMotionStatus();
      if (!status.available) return { ok: false, reason: status.reason };
      const scenes = scenesFor(prompt);
      if (!scenes.length) return { ok: false, reason: "Say what the video should show." };
      const font = resolveMotionFont()!;
      mkdirSync(options.outDir, { recursive: true });
      const work = mkdtempSync(join(tmpdir(), "sanremes-motion-"));
      const outFile = join(options.outDir, `motion-${now()}-${randomUUID().slice(0, 8)}.mp4`);
      try {
        const inputs: string[] = [];
        const filters: string[] = [];
        scenes.forEach((scene, index) => {
          const textFile = join(work, `scene-${index}.txt`);
          writeFileSync(textFile, `${wrapText(scene).join("\n")}\n`);
          inputs.push("-f", "lavfi", "-t", String(seconds), "-i", `color=c=${BACKGROUNDS[index % BACKGROUNDS.length]}:s=${WIDTH}x${HEIGHT}:r=${FPS}`);
          filters.push(
            `[${index}:v]drawtext=fontfile=${escapeFilterPath(font)}:textfile=${escapeFilterPath(textFile)}:fontsize=56:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-20,`
            + `drawbox=x='if(lt(t,0.8),-400+(w-400)/2*t/0.8,(w-400)/2)':y=h*0.62:w=400:h=6:color=white:t=fill,`
            + `fade=t=in:st=0:d=0.5,fade=t=out:st=${seconds - 0.5}:d=0.5[v${index}]`,
          );
        });
        const concat = scenes.map((_, index) => `[v${index}]`).join("") + `concat=n=${scenes.length}:v=1:a=0[out]`;
        await execFileInGroupAsync("ffmpeg", [
          "-hide_banner", "-loglevel", "error", "-y",
          ...inputs,
          "-filter_complex", [...filters, concat].join(";"),
          "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", String(FPS), "-movflags", "+faststart",
          outFile,
        ], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
        return { ok: true, file: outFile };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "ffmpeg failed.";
        return { ok: false, reason: `ffmpeg could not render the video: ${detail.slice(-500)}` };
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}
