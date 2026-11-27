import { PDFDocument, PageSizes, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { validateDocument, type FilegenBlock, type FilegenDocument } from "./types.ts";

const MARGIN = 56;
const BODY = 11;
const LEADING = 16;
const INK = rgb(0.12, 0.16, 0.22);
const MUTED = rgb(0.42, 0.45, 0.5);
const ACCENT = rgb(0.2, 0.3, 0.62);
const HEADER_FILL = rgb(0.2, 0.3, 0.62);
const HEADER_TEXT = rgb(1, 1, 1);
const GRID = rgb(0.82, 0.84, 0.88);
const ROW_ALT = rgb(0.96, 0.97, 0.99);

function wrap(font: PDFFont, size: number, maxWidth: number, text: string): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      while (font.widthOfTextAtSize(line, size) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > maxWidth) cut--;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [""];
}

interface Cursor {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  width: number;
  height: number;
  count: number;
}

function newPage(cursor: Cursor): void {
  cursor.page = cursor.doc.addPage(PageSizes.A4);
  cursor.width = cursor.page.getWidth();
  cursor.height = cursor.page.getHeight();
  cursor.y = cursor.height - MARGIN;
  cursor.count++;
}

function footer(cursor: Cursor, font: PDFFont): void {
  cursor.page.drawText(String(cursor.count), {
    x: cursor.width - MARGIN - font.widthOfTextAtSize(String(cursor.count), 9),
    y: 28,
    size: 9,
    font,
    color: MUTED,
  });
}

function ensureSpace(cursor: Cursor, needed: number, font: PDFFont): void {
  if (cursor.y - needed < MARGIN + 20) {
    footer(cursor, font);
    newPage(cursor);
  }
}

function drawLines(cursor: Cursor, font: PDFFont, lines: string[], size: number, color = INK, xOffset = 0): void {
  for (const line of lines) {
    ensureSpace(cursor, LEADING, font);
    cursor.page.drawText(line, { x: MARGIN + xOffset, y: cursor.y - size, size, font, color });
    cursor.y -= LEADING;
  }
}

function tableWidths(font: PDFFont, headers: string[], rows: string[][], available: number): number[] {
  const raw = headers.map((header, c) => {
    let widest = font.widthOfTextAtSize(header, 10);
    for (const row of rows) widest = Math.max(widest, font.widthOfTextAtSize(row[c]!, 10));
    return widest + 16;
  });
  const total = raw.reduce((sum, width) => sum + width, 0);
  if (total <= available) return raw;
  return raw.map((width) => (width / total) * available);
}

function drawTable(cursor: Cursor, font: PDFFont, bold: PDFFont, headers: string[], rows: string[][]): void {
  const available = cursor.width - MARGIN * 2;
  const widths = tableWidths(font, headers, rows, available);
  const cellPad = 8;
  const linesFor = (cells: string[], useBold: boolean) =>
    cells.map((cell, c) => wrap(useBold ? bold : font, 10, widths[c]! - cellPad * 2, cell));
  const headerLines = linesFor(headers, true);
  const rowLines = rows.map((row) => linesFor(row, false));
  const rowHeight = (lines: string[][]) => Math.max(...lines.map((cell) => cell.length)) * 14 + cellPad;
  const headerHeight = rowHeight(headerLines);
  ensureSpace(cursor, headerHeight, font);
  const drawRow = (lines: string[][], height: number, header: boolean, alt: boolean) => {
    ensureSpace(cursor, height, font);
    let x = MARGIN;
    for (let c = 0; c < lines.length; c++) {
      const cellFont = header ? bold : font;
      cursor.page.drawRectangle({
        x,
        y: cursor.y - height,
        width: widths[c]!,
        height,
        color: header ? HEADER_FILL : alt ? ROW_ALT : rgb(1, 1, 1),
        borderColor: GRID,
        borderWidth: 0.5,
      });
      lines[c]!.forEach((line, i) => {
        cursor.page.drawText(line, { x: x + cellPad, y: cursor.y - 12 - i * 14, size: 10, font: cellFont, color: header ? HEADER_TEXT : INK });
      });
      x += widths[c]!;
    }
    cursor.y -= height;
  };
  drawRow(headerLines, headerHeight, true, false);
  rowLines.forEach((lines, i) => drawRow(lines, rowHeight(lines), false, i % 2 === 1));
  cursor.y -= 6;
}

function drawBlock(cursor: Cursor, font: PDFFont, bold: PDFFont, block: FilegenBlock): void {
  const textWidth = cursor.width - MARGIN * 2;
  switch (block.type) {
    case "heading": {
      const size = block.level === 1 ? 22 : block.level === 2 ? 17 : 14;
      cursor.y -= block.level === 1 ? 10 : 8;
      ensureSpace(cursor, size + 8, font);
      cursor.page.drawText(block.text, { x: MARGIN, y: cursor.y - size, size, font: bold, color: block.level === 1 ? ACCENT : INK });
      cursor.y -= size + 10;
      break;
    }
    case "paragraph":
      drawLines(cursor, font, wrap(font, BODY, textWidth, block.text), BODY);
      cursor.y -= 6;
      break;
    case "bullets":
      for (const item of block.items) {
        const lines = wrap(font, BODY, textWidth - 16, item);
        const page = cursor.page;
        const top = cursor.y;
        drawLines(cursor, font, lines, BODY, INK, 16);
        cursor.y -= 2;
        page.drawText("•", { x: MARGIN + 4, y: top - BODY, size: BODY, font, color: INK });
      }
      cursor.y -= 4;
      break;
    case "table":
      drawTable(cursor, font, bold, block.headers, block.rows);
      break;
  }
}

/**
 * Builds a .pdf from a validated document: A4 pages with a title, headings,
 * wrapped paragraphs, bullet lists and ruled tables, numbered in the footer.
 */
export async function generatePdf(input: unknown): Promise<Buffer> {
  const doc: FilegenDocument = validateDocument(input);
  const pdf = await PDFDocument.create();
  pdf.setTitle(doc.title);
  if (doc.author) pdf.setAuthor(doc.author);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const cursor: Cursor = { doc: pdf, page: pdf.addPage(PageSizes.A4), y: 0, width: 0, height: 0, count: 0 };
  cursor.width = cursor.page.getWidth();
  cursor.height = cursor.page.getHeight();
  cursor.y = cursor.height - MARGIN;
  cursor.count = 1;
  cursor.page.drawText(doc.title, { x: MARGIN, y: cursor.y - 26, size: 26, font: bold, color: ACCENT, maxWidth: cursor.width - MARGIN * 2 });
  cursor.y -= 26 + 8;
  if (doc.author) {
    cursor.page.drawText(doc.author, { x: MARGIN, y: cursor.y - 13, size: 13, font, color: MUTED });
    cursor.y -= 13 + 8;
  }
  cursor.page.drawLine({ start: { x: MARGIN, y: cursor.y }, end: { x: cursor.width - MARGIN, y: cursor.y }, thickness: 1, color: ACCENT });
  cursor.y -= 18;
  for (const block of doc.blocks) drawBlock(cursor, font, bold, block);
  footer(cursor, font);
  return Buffer.from(await pdf.save());
}
