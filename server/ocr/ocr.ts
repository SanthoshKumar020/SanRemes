import { existsSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";

export const OCR_LANG = "eng";
export const OCR_LANG_FILE = "eng.traineddata.gz";
export const OCR_MAX_CHARS = 100_000;
export const OCR_TIMEOUT_MS = 30_000;

const OCR_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type OcrResult =
  | { ok: true; text: string; confidence: number }
  | { ok: false; reason: "unsupported-type" | "empty-image" | "no-ocr-data" | "no-text" | "ocr-failed" };

export interface OcrEngine {
  recognize(image: Buffer, langPath: string): Promise<{ text: string; confidence: number }>;
  close(): Promise<void>;
}

type TesseractWorker = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;

async function createTesseractEngine(): Promise<OcrEngine> {
  const { createWorker } = await import("tesseract.js");
  let worker: TesseractWorker | null = null;
  return {
    async recognize(image, langPath) {
      worker ??= await createWorker(OCR_LANG, undefined, { langPath });
      const { data } = await worker.recognize(image);
      return { text: data.text.trim(), confidence: data.confidence };
    },
    async close() {
      await worker?.terminate();
      worker = null;
    },
  };
}

let sharedEngine: Promise<OcrEngine> | null = null;

function defaultEngine(): Promise<OcrEngine> {
  sharedEngine ??= createTesseractEngine().catch((error: unknown) => {
    sharedEngine = null;
    throw error;
  });
  return sharedEngine;
}

export async function closeOcr(): Promise<void> {
  const engine = await sharedEngine?.catch(() => null);
  sharedEngine = null;
  await engine?.close().catch(() => undefined);
}

export function resolveOcrLangPath(env: NodeJS.ProcessEnv = process.env, dataDir: string = DATA_DIR): string | null {
  const override = env.SANREMES_OCR_LANG_PATH?.trim();
  if (override && existsSync(join(override, OCR_LANG_FILE))) return override;
  const local = join(dataDir, "ocr", "lang-data");
  if (existsSync(join(local, OCR_LANG_FILE))) return local;
  return null;
}

export interface OcrOptions {
  engine?: () => Promise<OcrEngine>;
  langPath?: string | null;
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("ocr timed out")), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function extractImageText(image: Buffer, mime: string, opts: OcrOptions = {}): Promise<OcrResult> {
  if (!OCR_IMAGE_MIMES.has(mime.split(";")[0]!.trim().toLowerCase())) return { ok: false, reason: "unsupported-type" };
  if (image.byteLength === 0) return { ok: false, reason: "empty-image" };
  const langPath = opts.langPath !== undefined ? opts.langPath : resolveOcrLangPath();
  if (!langPath) return { ok: false, reason: "no-ocr-data" };
  try {
    const engine = await (opts.engine ? opts.engine() : defaultEngine());
    const { text, confidence } = await withTimeout(engine.recognize(image, langPath), opts.timeoutMs ?? OCR_TIMEOUT_MS);
    if (!text) return { ok: false, reason: "no-text" };
    return { ok: true, text: text.slice(0, OCR_MAX_CHARS), confidence };
  } catch {
    return { ok: false, reason: "ocr-failed" };
  }
}
