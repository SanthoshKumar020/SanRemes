// Artifact templates on the show_html engine: the registry a bot calls through
// the build_artifact tool. A template renders self-contained HTML; the bot shows
// it with show_html, which already owns versioning, point-editing, publish and
// .html download. Nothing here touches the turn machinery: the coordinator
// registers ARTIFACT_TEMPLATE_TOOL_DEFINITION in the agents catalog.
import { renderDoc, type DocInput } from "./doc.ts";
import { renderDeck, deckFromNotes, type DeckInput } from "./slides.ts";
import { renderDesign, type DesignInput } from "./design.ts";

export type ArtifactKind = "doc" | "slides" | "design";

export interface ArtifactRender {
  html: string;
  title: string;
  height: number;
}

export interface ArtifactTemplate {
  id: string;
  kind: ArtifactKind;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  example: Record<string, unknown>;
  render(input: unknown): ArtifactRender | { error: string };
}

const DOC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "The document title." },
    lines: {
      type: "array",
      description: "The lines in order. kind is title, heading, paragraph, bullet or quote.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { kind: { type: "string" }, text: { type: "string" } },
        required: ["kind", "text"],
      },
    },
  },
  required: ["title", "lines"],
};

const DECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "The deck title." },
    slides: {
      type: "array",
      description: "One object per slide: title, bullets (a list), text, notes (speaker notes) and layout (title, bullets or quote).",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          bullets: { type: "array", items: { type: "string" } },
          text: { type: "string" },
          notes: { type: "string" },
          layout: { type: "string" },
        },
      },
    },
  },
  required: ["title", "slides"],
};

const DESIGN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    layout: { type: "string", description: "hero, pricing, portfolio, dashboard or signup." },
    brand: { type: "string", description: "The product or company name." },
    headline: { type: "string", description: "The page's main headline." },
    subhead: { type: "string" },
    ctaLabel: { type: "string", description: "The main button's label." },
    features: {
      type: "array",
      items: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, text: { type: "string" } }, required: ["title", "text"] },
    },
    tiers: {
      type: "array",
      description: "Pricing only: exactly 3 tiers, each { name, price, features, highlight? }.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, price: { type: "string" }, features: { type: "array", items: { type: "string" } }, highlight: { type: "boolean" } },
        required: ["name", "price", "features"],
      },
    },
    projects: {
      type: "array",
      description: "Portfolio only: each { title, text, tag? }.",
      items: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, text: { type: "string" }, tag: { type: "string" } }, required: ["title", "text"] },
    },
    stats: {
      type: "array",
      description: "Dashboard only: each { label, value, change? }.",
      items: { type: "object", additionalProperties: false, properties: { label: { type: "string" }, value: { type: "string" }, change: { type: "string" } }, required: ["label", "value"] },
    },
  },
  required: ["layout", "brand", "headline"],
};

export const ARTIFACT_TEMPLATES: ReadonlyArray<ArtifactTemplate> = [
  {
    id: "doc",
    kind: "doc",
    name: "Document",
    description: "A living document whose lines the person edits in place.",
    inputSchema: DOC_SCHEMA,
    example: {
      title: "Launch notes",
      lines: [
        { kind: "heading", text: "What ships" },
        { kind: "bullet", text: "Search across every project" },
        { kind: "paragraph", text: "The release goes out on Friday." },
      ],
    } satisfies DocInput,
    render: (input) => renderDoc(input),
  },
  {
    id: "slides",
    kind: "slides",
    name: "Slides",
    description: "A deck from notes, presentable in the chat with next/previous and a Present mode.",
    inputSchema: DECK_SCHEMA,
    example: {
      title: "Quarter review",
      slides: [
        { title: "Quarter review", layout: "title" },
        { title: "What went well", bullets: ["Shipped search", "Support replies under an hour"] },
        { title: "Next", text: "Double down on search quality." },
      ],
    } satisfies DeckInput,
    render: (input) => renderDeck(input),
  },
  {
    id: "design",
    kind: "design",
    name: "Design",
    description: "A landing page or mockup: hero, pricing, portfolio, dashboard or signup.",
    inputSchema: DESIGN_SCHEMA,
    example: {
      layout: "hero",
      brand: "Acme",
      headline: "Ship work faster",
      subhead: "One place for your team's docs, decks and designs.",
      ctaLabel: "Start free",
      features: [{ title: "Fast", text: "Nothing to install." }],
    } satisfies DesignInput,
    render: (input) => renderDesign(input),
  },
];

export function listArtifactTemplates(): ReadonlyArray<Pick<ArtifactTemplate, "id" | "kind" | "name" | "description" | "example">> {
  return ARTIFACT_TEMPLATES.map(({ id, kind, name, description, example }) => ({ id, kind, name, description, example }));
}

/** Render one template by id; an unknown id or bad input is an error, never a guess. */
export function renderArtifactTemplate(id: unknown, input: unknown): ArtifactRender | { error: string } {
  const template = ARTIFACT_TEMPLATES.find((entry) => entry.id === id);
  if (!template) return { error: `Unknown artifact template: ${typeof id === "string" ? id : "?"}. Use doc, slides or design.` };
  return template.render(input);
}

/** Notes into a deck without hand-writing slides: `# ` starts a slide, `- ` a bullet. */
export function artifactDeckFromNotes(title: string, notes: string): DeckInput {
  return deckFromNotes(title, notes);
}

export const ARTIFACT_TEMPLATE_TOOL_DEFINITION = {
  name: "build_artifact",
  description:
    "Build a doc, deck or design from structured content and get back self-contained HTML to show with show_html. Use template 'doc' for a living document the person edits in place (lines are contenteditable; their edits arrive as a [doc-edit] message — parse its JSON lines, rebuild with the edited lines, and show_html again with the same app_id so the version history keeps the earlier draft), 'slides' for a deck from notes (presentable in the chat with next/previous and a Present mode), and 'design' for a landing page or mockup (layout hero, pricing, portfolio, dashboard or signup). Pass the rendered html to show_html verbatim, with the returned title and height.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      template: { type: "string", description: "doc, slides or design." },
      content: { type: "object", description: "The template's input: doc { title, lines }, slides { title, slides }, design { layout, brand, headline, ... }." },
    },
    required: ["template", "content"],
  },
};

/** The build_artifact handler: renders the template and returns its HTML for show_html. */
export function callArtifactTemplateTool(args: unknown): { text: string; isError?: boolean } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { text: "build_artifact needs { template, content }.", isError: true };
  const { template, content } = args as { template?: unknown; content?: unknown };
  const rendered = renderArtifactTemplate(template, content);
  if ("error" in rendered) return { text: rendered.error, isError: true };
  return {
    text: JSON.stringify({
      template,
      title: rendered.title,
      height: rendered.height,
      html: rendered.html,
      next: "Call show_html with this html, title and height.",
    }),
  };
}
