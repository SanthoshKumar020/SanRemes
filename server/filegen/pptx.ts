import PptxGenJSModule from "pptxgenjs";

import { validateDeck, type FilegenChart, type FilegenDeck } from "./types.ts";

const TITLE = "334D9E";
const INK = "1F2937";
const MUTED = "6B7280";
const ACCENT = ["334D9E", "0E7C6B", "C2571B", "7A4FA3", "9E2B25", "3E7CB1", "5B8C5A", "B08D2E", "4A6FA5", "8A5A83"];

// pptxgenjs 4.0.1 ships its class and namespace merged in one declaration
// file, and under moduleResolution NodeNext the default import resolves to
// the module namespace rather than the class, so its own types are
// unreachable here. The surface below is the part this module uses; the
// runtime default export is the class, verified by the round-trip tests.
interface PptxSlide {
  background: { color: string };
  addText(
    text: string | Array<{ text: string; options: { bullet?: { indent: number }; breakLine?: boolean; fontSize?: number; color?: string } }>,
    options: { x: number; y: number; w: number; h: number; fontSize?: number; bold?: boolean; color?: string; align?: "left"; valign?: "top" },
  ): void;
  addShape(shape: "rect", options: { x: number; y: number; w: number; h: number; fill: { color: string } }): void;
  addChart(
    type: "bar" | "line" | "pie",
    data: Array<{ name: string; labels: string[]; values: number[] }>,
    options: {
      x: number;
      y: number;
      w: number;
      h: number;
      chartColors: string[];
      showTitle: boolean;
      title: string;
      showLegend: boolean;
      legendPos: "b";
      showValue: boolean;
      dataLabelPosition?: "outEnd";
    },
  ): void;
}

interface PptxPresentation {
  defineLayout(layout: { name: string; width: number; height: number }): void;
  layout: string;
  author: string;
  title: string;
  addSlide(): PptxSlide;
  write(options: { outputType: "nodebuffer" }): Promise<Buffer>;
}

const PptxGenJS = PptxGenJSModule as unknown as new () => PptxPresentation;

function chartData(chart: FilegenChart): Array<{ name: string; labels: string[]; values: number[] }> {
  return chart.series.map((series) => ({ name: series.name, labels: chart.categories, values: series.values }));
}

/**
 * Builds a .pptx from a validated deck: a title slide, then one slide per
 * entry, with bullets and a native chart where the slide carries one.
 */
export async function generatePresentation(input: unknown): Promise<Buffer> {
  const deck: FilegenDeck = validateDeck(input);
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";
  pptx.author = deck.author ?? "";
  pptx.title = deck.title;

  const titleSlide = pptx.addSlide();
  titleSlide.background = { color: "F8FAFC" };
  titleSlide.addText(deck.title, { x: 0.7, y: 2.6, w: 11.93, h: 1.4, fontSize: 40, bold: true, color: TITLE, align: "left" });
  if (deck.author) {
    titleSlide.addText(deck.author, { x: 0.7, y: 4.1, w: 11.93, h: 0.6, fontSize: 18, color: MUTED, align: "left" });
  }

  for (const slide of deck.slides) {
    const page = pptx.addSlide();
    page.addText(slide.title, { x: 0.6, y: 0.35, w: 12.13, h: 0.8, fontSize: 28, bold: true, color: INK });
    page.addShape("rect", { x: 0.6, y: 1.2, w: 12.13, h: 0.03, fill: { color: TITLE } });
    let bodyTop = 1.5;
    if (slide.body) {
      page.addText(slide.body, { x: 0.6, y: bodyTop, w: 12.13, h: 1.0, fontSize: 16, color: INK });
      bodyTop = 2.6;
    }
    if (slide.bullets?.length) {
      page.addText(
        slide.bullets.map((item) => ({ text: item, options: { bullet: { indent: 14 }, breakLine: true, fontSize: 16, color: INK } })),
        { x: 0.6, y: bodyTop, w: slide.chart ? 6.4 : 12.13, h: 5.0, valign: "top" },
      );
    }
    if (slide.chart) {
      const chart = slide.chart;
      page.addChart(chart.type, chartData(chart), {
        x: slide.bullets?.length ? 7.3 : 0.6,
        y: bodyTop,
        w: slide.bullets?.length ? 5.4 : 12.13,
        h: 5.0,
        chartColors: ACCENT,
        showTitle: Boolean(chart.title),
        title: chart.title ?? "",
        showLegend: chart.series.length > 1,
        legendPos: "b",
        showValue: chart.type === "pie",
        dataLabelPosition: chart.type === "pie" ? "outEnd" : undefined,
      });
    }
  }

  const out = await pptx.write({ outputType: "nodebuffer" });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as unknown as ArrayBuffer);
}
