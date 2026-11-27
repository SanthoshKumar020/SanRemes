import { constants, copyFileSync, existsSync, linkSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { decodeAttachmentAttribute, escapeAttribute } from "../src/lib/composer-attachments.ts";
import { ATTACHMENTS_DIR, ocrAttachmentText } from "./attachments.ts";
import { botBox } from "./bot-box/box.ts";
import { boxUploadsDir, uploadsConversation } from "./bot-box/plan.ts";
import { DATA_DIR } from "./config.ts";

const TAG = /(<attached-(?:file|image)[\t ]+path=")([^"\r\n]*)(")/g;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TEXT_BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
};

/**
 * The bot box hides the data folder, uploads included, so an `<attached-file>` path would be unreadable there.
 * Each upload the text names is linked into the conversation's uploads folder (plan.ts boxUploadsDir), which the server
 * owns and every box of the conversation sees read-only, and the path is rewritten to it. The bot can read the upload but
 * never write it or swap the folder for a link. Only the text sent to the engine changes; with the box off, or a working
 * folder that is neither a conversation's own nor `turn`'s bot's own folder (a room's), nothing does.
 */
export function attachmentsForBox(text: string, cwd: string | undefined, turn?: { botId: string; threadId: string }, boxed = botBox.enabled(), dataDir = DATA_DIR, attachmentsDir = ATTACHMENTS_DIR): string {
  if (!boxed || !cwd || !text.includes("<attached-")) return text;
  const ids = uploadsConversation(resolve(cwd), resolve(dataDir), turn);
  if (!ids) return text;
  const uploads = resolve(attachmentsDir), shown = boxUploadsDir(resolve(dataDir), ids.botId, ids.threadId);
  return text.replace(TAG, (tag, open: string, raw: string, close: string) => {
    const path = decodeAttachmentAttribute(raw), name = basename(path);
    if (resolve(dirname(path)) !== uploads || !NAME.test(name) || !existsSync(path)) return tag;
    const target = join(shown, name);
    try {
      // Uploads never change under their name, so one an earlier turn put here is kept.
      if (!existsSync(target)) {
        mkdirSync(shown, { recursive: true, mode: 0o700 });
        try {
          linkSync(path, target);
        } catch {
          // Another file system: a copy, renamed into place so one cut short never passes for a whole one.
          const partial = `${target}.${process.pid}.partial`;
          try {
            copyFileSync(path, partial, constants.COPYFILE_FICLONE);
            renameSync(partial, target);
          } finally {
            rmSync(partial, { force: true });
          }
        }
      }
    } catch {
      return tag;
    }
    return `${open}${escapeAttribute(target)}${close}`;
  });
}

/**
 * Text read from attached images and PDFs, appended after the tag that names them, so an engine without
 * image input still sees what they say. A read that finds nothing, or a file outside the uploads folder,
 * adds nothing; the tag itself is left for attachmentsForBox.
 */
export async function attachmentTextForTurn(text: string, cwd: string | undefined, turn?: { botId: string; threadId: string }, dataDir = DATA_DIR, attachmentsDir = ATTACHMENTS_DIR): Promise<string> {
  if (!cwd || !text.includes("<attached-")) return text;
  const ids = uploadsConversation(resolve(cwd), resolve(dataDir), turn);
  if (!ids) return text;
  const uploads = resolve(attachmentsDir);
  const matches = [...text.matchAll(TAG)];
  if (!matches.length) return text;
  const inserts = new Map<number, string>();
  for (const match of matches) {
    const path = decodeAttachmentAttribute(match[2]!), name = basename(path);
    if (resolve(dirname(path)) !== uploads || !NAME.test(name) || !existsSync(path)) continue;
    const mime = TEXT_BY_EXTENSION[extname(name).slice(1).toLowerCase()];
    if (!mime) continue;
    const read = await ocrAttachmentText(path, mime);
    if (!read.ok || !read.text.trim()) continue;
    const escaped = read.text.trim().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    inserts.set(match.index!, `\n<attached-image-text name="${escapeAttribute(name)}">${escaped}</attached-image-text>`);
  }
  if (!inserts.size) return text;
  let out = "", at = 0;
  for (const match of matches) {
    const insert = inserts.get(match.index!);
    if (!insert) continue;
    // TAG ends at the path's closing quote; the insert goes after the whole tag.
    const close = text.indexOf("/>", match.index!);
    if (close === -1) continue;
    const end = close + 2;
    out += text.slice(at, end) + insert;
    at = end;
  }
  return out + text.slice(at);
}
