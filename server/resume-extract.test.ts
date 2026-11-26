import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { extractResumeText } from "./resume-extract.ts";

function minimalPdf(lines: string[], pages = 1): Buffer {
  const content = lines.map((line, index) => `BT /F1 12 Tf 72 ${720 - index * 18} Td (${line}) Tj ET`).join("\n");
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(`<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages} >>`),
  ];
  for (let page = 0; page < pages; page++) {
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + pages * 2} 0 R >> >> /Contents ${4 + page * 2} 0 R >>`));
    objects.push(Buffer.from(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  }
  objects.push(Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  const out: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = out[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${object.toString("utf8")}\nendobj\n`);
    out.push(chunk);
    length += chunk.length;
  });
  const xref = length;
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) trailer += `${String(offset).padStart(10, "0")} 00000 n \n`;
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  out.push(Buffer.from(trailer));
  return Buffer.concat(out);
}

function crc32(buffer: Buffer): number {
  let table = (crc32 as unknown as { table?: Int32Array }).table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    (crc32 as unknown as { table: Int32Array }).table = table;
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function minimalDocx(text: string): Buffer {
  const files: Array<[string, Buffer]> = [
    ["[Content_Types].xml", Buffer.from(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)],
    ["_rels/.rels", Buffer.from(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)],
    ["word/document.xml", Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`)],
  ];
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const compressed = deflateRawSync(data);
    const nameBuffer = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    chunks.push(header, nameBuffer, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);
    offset += header.length + nameBuffer.length + compressed.length;
  }
  const centralStart = offset;
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

describe("extractResumeText", () => {
  it("reads a PDF and reports its page count", async () => {
    const parsed = await extractResumeText(minimalPdf(["Santhoshkumar Karthikeyan", "Data Engineer"]), "resume.pdf");
    expect(parsed.kind).toBe("pdf");
    expect(parsed.pages).toBe(1);
    expect(parsed.text).toContain("Santhoshkumar Karthikeyan");
    expect(parsed.text).toContain("Data Engineer");
  });

  it("reads a Word document", async () => {
    const parsed = await extractResumeText(minimalDocx("Data Engineer with Databricks"), "resume.docx");
    expect(parsed.kind).toBe("docx");
    expect(parsed.pages).toBeNull();
    expect(parsed.text).toContain("Data Engineer with Databricks");
  });

  it("reads plain text and Markdown", async () => {
    expect((await extractResumeText(Buffer.from("  SQL, PySpark  ", "utf8"), "resume.txt")).text).toBe("SQL, PySpark");
    expect((await extractResumeText(Buffer.from("# Resume", "utf8"), "resume.md")).kind).toBe("text");
  });

  it("refuses corrupt, empty and unsupported files instead of returning nothing", async () => {
    await expect(extractResumeText(Buffer.from("not a pdf"), "resume.pdf")).rejects.toThrow("could not be read");
    await expect(extractResumeText(Buffer.from(""), "resume.pdf")).rejects.toThrow("empty");
    await expect(extractResumeText(Buffer.from("garbage"), "resume.exe")).rejects.toThrow("Send a PDF");
    await expect(extractResumeText(Buffer.from("garbage"), "resume.docx")).rejects.toThrow("could not be read");
  });
});
