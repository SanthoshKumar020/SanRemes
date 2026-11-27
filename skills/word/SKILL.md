---
name: word
description: "Build a real .docx document from headings, paragraphs, bullet lists and tables. Use when the person asks for a Word document, a .docx file, or a document to read and edit."
---

# Word documents

Build a real `.docx` file from blocks in order: headings, paragraphs, bullet lists and tables. The
document opens in Word, LibreOffice and Google Docs, and the person can edit every word of it
afterwards. There is no template picker, no page-layout control and no image embedding: what you
describe in blocks is what the file holds.

## When to use this skill

- The person asks for a Word document, a `.docx` file, or a document to read, edit or print.
- The person gives text, an outline or a table and wants it as a document.

Do not use it for slides (`powerpoint` skill), a fixed printable handout (`pdf` skill), or a table of
numbers to work with (`excel` skill). A short answer in chat needs no file at all.

## Entry points

The model tool is `filegen_document`. It takes the document and an optional `path`, and returns the
file path, size and block count. The path must stay inside the bot's working folder or the person's
Downloads; when no path is given the file goes to Downloads, named after the document title.

The same generation is available to code through `server/filegen/index.ts`:

- `generateDocument(doc)` returns the `.docx` bytes as a `Buffer`.
- `validateDocument(doc)` checks a document and returns the cleaned document, or throws
  `FilegenFailure`.
- `FILEGEN_LIMITS` holds the hard limits below.

`generate-sample.ts`, next to this guide, builds a small sample document: run it with
`node --experimental-strip-types skills/word/generate-sample.ts [out-dir]` and it writes the file,
then reads it back with mammoth and checks the text is really there. With no out-dir it uses a fresh
temporary folder and prints the path.

## Input shape

A document is `{ title, author?, blocks }`. Each block is one of:

- `{ type: "heading", level: 1 | 2 | 3, text }`
- `{ type: "paragraph", text }`
- `{ type: "bullets", items: string[] }`
- `{ type: "table", headers: string[], rows: string[][] }` — every row has exactly one cell per header.

```json
{
  "title": "Quarterly Report",
  "author": "SanRemes",
  "blocks": [
    { "type": "heading", "level": 1, "text": "Overview" },
    { "type": "paragraph", "text": "Revenue grew across all three quarters." },
    { "type": "bullets", "items": ["Revenue up 12%", "Churn down to 3%"] },
    {
      "type": "table",
      "headers": ["Quarter", "Revenue"],
      "rows": [["Q1", "120"], ["Q2", "150"], ["Q3", "180"]]
    }
  ]
}
```

## Turning text into a document

- The document title becomes the file's title and its first line. Start the blocks with a level-1
  heading for the first section; use level 2 for sections inside it and level 3 for sub-sections.
  Never skip a level (a level-3 heading directly under the title, with no level-2 above it).
- One idea per paragraph, in short sentences. A paragraph that runs past about 150 words usually
  wants splitting, or a bullet list instead.
- Use bullets for lists of points, steps or findings — at most 50 items per list, and keep each item
  to one or two lines. Use a table when the points have matching fields (a quarter and a revenue, a
  name and a date); use bullets when they do not.
- Tables get a shaded header row. Keep headers short (one to three words) and cells plain text; a
  cell holds words or a number as text, never a formula — a `.docx` table does not calculate.
- Titles and author are at most 200 characters; any other text is at most 5000 characters.
- Never invent a fact, figure or quote the person did not give you. If a section is missing its
  content, ask for it or leave the section out and say so.

## Limits

- Blocks: 1–500. Tables: at most 20 columns and 500 rows; every row has exactly one cell per header.
- Bullet lists: at most 50 items each.
- No images, no headers or footers, no page numbers, no footnotes, no custom fonts or styles. A
  document that needs any of those is not buildable here — say so and offer the closest plain version.

## When the input is invalid

Validate before you build: call `validateDocument` (or let `filegen_document` validate, which it does
first). A bad document throws `FilegenFailure` with a `code`, a plain `message` and sometimes a
`hint` — report those words as they are, say which block is wrong, and fix the input rather than
guessing. The usual failures:

- `blocks` empty: a document needs at least one block.
- A table row with a different count of cells than headers: add or drop cells until every row has
  exactly one per header.
- A heading with a level other than 1, 2 or 3, or a block type that is not heading, paragraph,
  bullets or table: use only the four block types above.
- Text over the length limits: shorten it; do not silently cut it.

Never send a half-built document, and never retry the same invalid document unchanged.
