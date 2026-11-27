---
name: powerpoint
description: "Build a real .pptx presentation from an outline: a title slide, then one slide per point with bullets and native bar, line or pie charts. Use when the person asks for a presentation, a slide deck, slides, or a .pptx file."
---

# PowerPoint presentations

Build a real `.pptx` file from an outline. The deck always starts with a title slide carrying the deck
title (and the author, when given), then one slide per entry in the outline. Slides are 16:9. There is no
template picker and no image embedding: what you describe in text and chart data is what the file holds.

## When to use this skill

- The person asks for a presentation, a slide deck, slides, or a `.pptx` file.
- The person gives an outline, a list of points, or data to chart and wants it as slides.

Do not use it for a document to read (`word` skill), a printable handout (`pdf` skill), or a table of
numbers to work with (`excel` skill). A chart that belongs on a page the person looks at in chat is a
dashboard (`data-dashboards` skill), not a deck.

## Entry points

The model tool is `filegen_presentation`. It takes the deck and an optional `path`, and returns the file
path, size and slide count. The path must stay inside the bot's working folder or the person's Downloads;
when no path is given the file goes to Downloads, named after the deck title.

The same generation is available to code through `server/filegen/index.ts`:

- `generatePresentation(deck)` returns the `.pptx` bytes as a `Buffer`.
- `validateDeck(deck)` checks a deck and returns the cleaned deck, or throws `FilegenFailure`.
- `FILEGEN_LIMITS` holds the hard limits below.

`generate-sample.ts`, next to this guide, builds a small sample deck both ways: run it with
`node --experimental-strip-types skills/powerpoint/generate-sample.ts [out-dir]` and it writes the file,
then reads it back and checks the slides and chart are really there. With no out-dir it uses a fresh
temporary folder and prints the path.

## Input shape

A deck is `{ title, author?, slides }`. Each slide is `{ title, body?, bullets?, chart? }`: a title is
required, the rest is optional, and a slide may carry both bullets and a chart. When a slide has both,
the bullets sit on the left and the chart on the right.

```json
{
  "title": "Quarterly Review",
  "author": "SanRemes",
  "slides": [
    { "title": "Highlights", "bullets": ["Revenue up 12%", "Churn down to 3%"] },
    {
      "title": "Revenue by quarter",
      "body": "Growth driven by renewals.",
      "bullets": ["Q3 was the strongest quarter"],
      "chart": {
        "type": "bar",
        "title": "Revenue",
        "categories": ["Q1", "Q2", "Q3"],
        "series": [{ "name": "Revenue", "values": [120, 150, 180] }]
      }
    },
    {
      "title": "Share",
      "chart": { "type": "pie", "categories": ["A", "B"], "series": [{ "name": "Share", "values": [70, 30] }] }
    }
  ]
}
```

## Turning an outline into a deck

- One idea per slide, with the slide title as the point ("Revenue grew every quarter"), not the topic
  ("Revenue"). The body, when the slide has one, is a single sentence; the bullets are the evidence.
- Aim for 5–12 content slides for a talk. A deck over about 20 slides is usually an outline that wants
  splitting into two decks, or a document instead. The hard limit is 100 slides.
- Keep bullets short: one line each, at most about 8 words, and no more than 6–8 bullets on a slide.
  Text longer than that belongs in the speaker's words, not on the slide.
- Put the number on the slide: "Revenue up 12%" beats "Revenue grew". Never invent a number the person
  did not give you; if a figure is missing, ask for it or leave the point out.
- Titles and author are at most 200 characters; any other text is at most 5000 characters.

## Charts

A slide holds at most one chart, of type `bar`, `line` or `pie`. The chart is a native Office chart
drawn from the data, so the person can edit its values in PowerPoint afterwards.

- `categories` is the list of labels along the axis (1–50 entries, each a short label).
- `series` is one entry per row of data (1–10 series), each `{ name, values }`, where `values` has
  exactly one finite number per category. A series whose values do not line up with the categories is
  rejected before anything is built.
- Pick the form by the job: compare values across categories with a bar; show change over time with a
  line; show part-to-whole with a pie. A pie with more than about 5 slices is a table, not a chart —
  use a bar, or fold the small slices into "Other".
- A pie shows its values on the slices; bars and lines show a legend only when there is more than one
  series. Give the chart a short `title` when the slide title does not already say what it shows.
- Charts have no images and no custom colours: bars and lines use the built-in palette in series order.
- Check the numbers before you build: every value must be a real number the person gave you, in the
  same unit and scale across a series. A bar chart does not take percentages mixed with totals.

## Limits

- Slides: 1–100. Titles: at most 200 characters. Body and bullet text: at most 5000 characters each,
  at most 50 bullets per slide.
- Charts: 1–50 categories, 1–10 series, at most 500 values in total across the series, one value per
  category per series, all finite numbers.
- No images, no embedded video, no animations, no speaker notes, no custom fonts or colours. A deck
  that needs any of those is not buildable here — say so and offer the closest plain version.

## When the input is invalid

Validate before you build: call `validateDeck` (or let `filegen_presentation` validate, which it does
first). A bad deck throws `FilegenFailure` with a `code`, a plain `message` and sometimes a `hint` —
report those words as they are, say which slide or chart field is wrong, and fix the input rather than
guessing. The usual failures:

- `slides` empty, or a slide with no title: every slide needs a title, and a deck needs at least one slide.
- A chart series with a different count of values than categories: add or drop values until each series
  has one per category.
- A value that is not a finite number (a word, a blank, `NaN`): replace it with the real number or drop
  the category.
- Text over the length limits: shorten it; do not silently cut it.

Never send a half-built deck, and never retry the same invalid deck unchanged.
