import { describe, expect, it } from "vitest";
import {
  ARTIFACT_TEMPLATE_TOOL_DEFINITION,
  ARTIFACT_TEMPLATES,
  artifactDeckFromNotes,
  callArtifactTemplateTool,
  listArtifactTemplates,
  renderArtifactTemplate,
} from "./templates.ts";

describe("ARTIFACT_TEMPLATES", () => {
  it("registers doc, slides and design with schemas and examples", () => {
    expect(ARTIFACT_TEMPLATES.map((template) => template.id)).toEqual(["doc", "slides", "design"]);
    for (const template of ARTIFACT_TEMPLATES) {
      expect(template.inputSchema).toMatchObject({ type: "object", required: expect.any(Array) });
      const rendered = template.render(template.example);
      expect(rendered).not.toHaveProperty("error");
    }
  });

  it("lists the templates without their render functions", () => {
    const listed = listArtifactTemplates();
    expect(listed).toHaveLength(3);
    expect(listed[0]).toEqual({ id: "doc", kind: "doc", name: "Document", description: expect.any(String), example: expect.any(Object) });
  });
});

describe("renderArtifactTemplate", () => {
  it("renders each template from its example", () => {
    for (const template of ARTIFACT_TEMPLATES) {
      const rendered = renderArtifactTemplate(template.id, template.example);
      if ("error" in rendered) throw new Error(rendered.error);
      expect(rendered.html).toContain("<!DOCTYPE html>");
      expect(rendered.title.length).toBeGreaterThan(0);
      expect(rendered.height).toBeGreaterThanOrEqual(80);
      expect(rendered.height).toBeLessThanOrEqual(720);
    }
  });

  it("errors on an unknown template and on bad content", () => {
    expect(renderArtifactTemplate("sheet", {})).toMatchObject({ error: expect.stringContaining("Unknown artifact template") });
    expect(renderArtifactTemplate("doc", { title: "T", lines: [] })).toMatchObject({ error: expect.any(String) });
  });
});

describe("artifactDeckFromNotes", () => {
  it("builds a deck from notes", () => {
    const deck = artifactDeckFromNotes("Review", "# Intro\n- one");
    expect(deck.slides).toEqual([{ title: "Intro", bullets: ["one"] }]);
  });
});

describe("callArtifactTemplateTool", () => {
  it("returns JSON with html, title and height for show_html", () => {
    const result = callArtifactTemplateTool({
      template: "doc",
      content: { title: "T", lines: [{ kind: "paragraph", text: "Hello" }] },
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.text) as { template: string; title: string; height: number; html: string; next: string };
    expect(parsed.template).toBe("doc");
    expect(parsed.title).toBe("T");
    expect(parsed.html).toContain("Hello");
    expect(parsed.next).toContain("show_html");
  });

  it("errors on bad arguments and on bad content", () => {
    expect(callArtifactTemplateTool(null)).toMatchObject({ isError: true });
    expect(callArtifactTemplateTool({ template: "doc", content: { title: "T" } })).toMatchObject({ isError: true });
    expect(callArtifactTemplateTool({ template: "nope", content: {} })).toMatchObject({ isError: true });
  });
});

describe("ARTIFACT_TEMPLATE_TOOL_DEFINITION", () => {
  it("names the tool build_artifact and requires template and content", () => {
    expect(ARTIFACT_TEMPLATE_TOOL_DEFINITION.name).toBe("build_artifact");
    expect(ARTIFACT_TEMPLATE_TOOL_DEFINITION.inputSchema).toMatchObject({ required: ["template", "content"] });
    expect(ARTIFACT_TEMPLATE_TOOL_DEFINITION.description).toContain("show_html");
    expect(ARTIFACT_TEMPLATE_TOOL_DEFINITION.description).toContain("[doc-edit]");
  });
});
