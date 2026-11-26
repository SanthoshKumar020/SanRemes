// Resume text extraction from an uploaded file. PDF goes through unpdf (Mozilla's PDF.js, pure JavaScript);
// Word goes through mammoth; plain text is read as UTF-8. Anything else, or a file with no readable text,
// is refused instead of silently producing an empty profile.
import mammoth from "mammoth";
import { extractText } from "unpdf";

export type ResumeFileKind = "pdf" | "docx" | "text";

export interface ExtractedResume {
  text: string;
  /** PDF page count, when the format reports one. */
  pages: number | null;
  kind: ResumeFileKind;
}

const MAX_BYTES = 10_000_000;
const MAX_TEXT_CHARS = 200_000;

function kindFor(filename: string): ResumeFileKind | null {
  if (/\.pdf$/i.test(filename)) return "pdf";
  if (/\.docx$/i.test(filename)) return "docx";
  if (/\.(txt|md)$/i.test(filename)) return "text";
  return null;
}

export async function extractResumeText(buffer: Buffer, filename: string): Promise<ExtractedResume> {
  const kind = kindFor(filename);
  if (!kind) throw new Error("Send a PDF, Word (.docx), text, or Markdown resume.");
  if (buffer.length === 0) throw new Error("That file is empty.");
  if (buffer.length > MAX_BYTES) throw new Error("That file is too large to read.");
  let text: string;
  let pages: number | null = null;
  try {
    if (kind === "pdf") {
      const parsed = await extractText(new Uint8Array(buffer), { mergePages: true });
      text = parsed.text;
      pages = parsed.totalPages;
    } else if (kind === "docx") {
      text = (await mammoth.extractRawText({ buffer })).value;
    } else {
      text = buffer.toString("utf8");
    }
  } catch {
    throw new Error("That file could not be read. Check it opens, then try again.");
  }
  text = text.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("No readable text was found in that file.");
  return { text: text.slice(0, MAX_TEXT_CHARS), pages, kind };
}
