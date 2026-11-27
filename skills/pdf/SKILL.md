---
name: pdf
description: "Build a real .pdf document from headings, paragraphs, bullet lists and tables, paginated on A4 with page numbers. Use when the person asks for a PDF, a printable handout, or a fixed-layout document."
---

# PDF documents

Build a real `.pdf` file from blocks in order: headings, paragraphs, bullet lists and tables. Pages
are A4, content flows across pages as it needs to, and each page carries its page number. A PDF is
fixed: the person reads and prints it exactly as built, and cannot edit it the way they can a Word
document. There is no template picker, no landscape mode and no image embedding: what you describe in
blocks is what the file holds.

## When to use this skill

- The person asks for a PDF, a printable handout, or a fixed-layout document to share or print.
- The person wants the Word document's content in a form nobody can accidentally edit.

Do not use it for a document the person will keep editing (`word` skill), for slides (`powerpoint`
skill), or for a table of numbers to work with (`excel` skill). A short answer in chat needs no file
at all.

## Entry points

The model tool is `filegen_pdf`. It takes the document and an optional `path`, and returns the file
path, size and page count. The path must stay inside the bot's working folder or the person's
Downloads; when no path is given the file goes to Downloads, named after the document title.

The same generation is available to code through `server/filegen/index.ts`:

- `generatePdf(doc)` returns the `.pdf` bytes as a `Buffer`.
- `validateDocument(doc)` checks a document and returns the cleaned document, or throws
  `FilegenFailure`.
- `FILEGEN_LIMITS` holds the hard limits below.

The PDF takes the same block model as the Word document — the same `{ title, author?, blocks }`
shape, so a document built for `filegen_document` builds as a PDF unchanged. `generate-sample.ts`,
next to this guide, builds a small sample document: run it with
`node --experimental-strip-types skills/pdf/generate-sample.ts [out-dir]` and it writes the file,
then loads it back and checks the pages and text are really there. With no out-dir it uses a fresh
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

## Turning text into a PDF

- The document title becomes the file's title and its first line. Start the blocks with a level-1
  heading for the first section; use level 2 for sections inside it and level 3 for sub-sections.
  Never skip a level.
- One idea per paragraph, in short sentences. A paragraph that runs past about 150 words usually
  wants splitting, or a bullet list instead.
- Use bullets for lists of points, steps or findings — at most 50 items per list, and keep each item
  to one or two lines. Use a table when the points have matching fields; use bullets when they do not.
- Tables get a shaded header row with ruled lines. Keep headers short (one to three words) and cells
  plain text; a cell holds words or a number as text, never a formula — a PDF table does not calculate.
- Titles and author are at most 200 characters; any other text is at most 5000 characters.
- Never invent a fact, figure or quote the person did not give you. If a section is missing its
  content, ask for it or leave the section out and say so.

## Tables: the wide-table limit

A PDF page is A4 portrait, and every column of a table shares that width. A table with a few columns
reads well; a table near the 20-column limit squeezes each column so narrow the text wraps to a
letter or two. Do not promise a wide table with small type or a landscape page — neither exists here.

- Keep tables to 8 columns or fewer. A table that needs more columns is two tables, or a Word
  document instead.
- Keep cell text short. Long cells wrap and push the row tall, which is fine for a few rows and
  unreadable for hundreds.
- Split a long table rather than forcing it: one table per section, each with its own heading.

## Limits

- Blocks: 1–500. Tables: at most 20 columns and 500 rows; every row has exactly one cell per header.
- Bullet lists: at most 50 items each.
- No images, no landscape pages, no headers or footers beyond the page number, no footnotes, no
  custom fonts or styles. A PDF that needs any of those is not buildable here — say so and offer the
  closest plain version, usually the same content as a Word document.

## When the input is invalid

Validate before you build: call `validateDocument` (or let `filegen_pdf` validate, which it does
first). A bad document throws `FilegenFailure` with a `code`, a plain `message` and sometimes a
`hint` — report those words as they are, say which block is wrong, and fix the input rather than
guessing. The usual failures:

- `blocks` empty: a document needs at least one block.
- A table row with a different count of cells than headers: add or drop cells until every row has
  exactly one per header.
- A heading with a level other than 1, 2 or 3, or a block type that is not heading, paragraph,
  bullets or table: use only the four block types above.
- Text over the length limits: shorten it; do not silently cut it.

Never send a half-built PDF, and never retry the same invalid document unchanged.
