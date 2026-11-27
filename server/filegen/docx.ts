import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

import { validateDocument, type FilegenBlock, type FilegenDocument } from "./types.ts";

const HEADER_FILL = "334D9E";

const run = (text: string, opts: { bold?: boolean; color?: string; size?: number } = {}) =>
  new TextRun({ text, bold: opts.bold ?? false, color: opts.color, size: opts.size ?? 24 });

function headingBlock(level: 1 | 2 | 3, text: string): Paragraph {
  const heading = level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
  return new Paragraph({ heading, children: [run(text, { size: level === 1 ? 32 : level === 2 ? 28 : 26 })] });
}

function cellParagraph(text: string, header: boolean): Paragraph {
  return new Paragraph({
    children: [run(text, { bold: header, color: header ? "FFFFFF" : undefined, size: 22 })],
    alignment: AlignmentType.LEFT,
  });
}

function tableBlock(headers: string[], rows: string[][]): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(
      (header) =>
        new TableCell({
          shading: { type: ShadingType.CLEAR, fill: HEADER_FILL },
          children: [cellParagraph(header, true)],
        }),
    ),
  });
  const bodyRows = rows.map(
    (row) =>
      new TableRow({
        children: row.map((cell) => new TableCell({ children: [cellParagraph(cell, false)] })),
      }),
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  });
}

function blockParagraph(block: FilegenBlock): Array<Paragraph | Table> {
  switch (block.type) {
    case "heading":
      return [headingBlock(block.level, block.text)];
    case "paragraph":
      return [new Paragraph({ children: [run(block.text)], spacing: { after: 160 } })];
    case "bullets":
      return block.items.map((item) => new Paragraph({ bullet: { level: 0 }, children: [run(item)] }));
    case "table":
      return [tableBlock(block.headers, block.rows)];
  }
}

/**
 * Builds a .docx from a validated document: a title heading, then the
 * blocks in order — headings, paragraphs, bullet lists and shaded tables.
 */
export async function generateDocument(input: unknown): Promise<Buffer> {
  const doc: FilegenDocument = validateDocument(input);
  const children: Array<Paragraph | Table> = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [run(doc.title, { size: 44 })] }),
    ...(doc.author ? [new Paragraph({ children: [run(doc.author, { color: "6B7280", size: 24 })], spacing: { after: 240 } })] : []),
  ];
  for (const block of doc.blocks) children.push(...blockParagraph(block));
  const document = new Document({
    creator: doc.author ?? "",
    title: doc.title,
    sections: [{ children }],
  });
  return Packer.toBuffer(document);
}
