// Design templates: starter landing-page and mockup layouts a model fills in.
// Static and inert: buttons and forms change nothing outside the page.
import { artifactShell, escapeHtml } from "./html.ts";

export const DESIGN_LIMITS = {
  maxTitleChars: 200,
  maxTextChars: 500,
  maxItems: 12,
  maxItemChars: 200,
  maxHtmlBytes: 200_000,
} as const;

export type DesignLayout = "hero" | "pricing" | "portfolio" | "dashboard" | "signup";

export interface DesignFeature {
  title: string;
  text: string;
}

export interface DesignTier {
  name: string;
  price: string;
  features: string[];
  highlight?: boolean;
}

export interface DesignProject {
  title: string;
  text: string;
  tag?: string;
}

export interface DesignStat {
  label: string;
  value: string;
  change?: string;
}

export interface DesignInput {
  layout: DesignLayout;
  brand: string;
  headline: string;
  subhead?: string;
  ctaLabel?: string;
  features?: DesignFeature[];
  tiers?: DesignTier[];
  projects?: DesignProject[];
  stats?: DesignStat[];
}

const LAYOUTS: ReadonlySet<string> = new Set(["hero", "pricing", "portfolio", "dashboard", "signup"]);

function checkText(value: unknown, max: number, what: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") return `${what} needs text.`;
  return value.length > max ? `${what} is over ${max} characters.` : null;
}

export function validateDesignInput(input: unknown): { design: DesignInput } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "A design needs { layout, brand, headline }." };
  const raw = input as Record<string, unknown>;
  if (typeof raw.layout !== "string" || !LAYOUTS.has(raw.layout)) {
    return { error: "A design needs a layout: hero, pricing, portfolio, dashboard or signup." };
  }
  const bad =
    checkText(raw.brand, DESIGN_LIMITS.maxTitleChars, "The brand") ??
    checkText(raw.headline, DESIGN_LIMITS.maxTitleChars, "The headline") ??
    checkText(raw.subhead, DESIGN_LIMITS.maxTextChars, "The subhead") ??
    checkText(raw.ctaLabel, 80, "The call to action");
  if (bad) return { error: bad };
  if (typeof raw.brand !== "string" || !raw.brand.trim()) return { error: "A design needs a brand name." };
  if (typeof raw.headline !== "string" || !raw.headline.trim()) return { error: "A design needs a headline." };
  const list = (value: unknown, what: string): { items: Record<string, unknown>[] } | { error: string } => {
    if (value === undefined) return { items: [] };
    if (!Array.isArray(value)) return { error: `${what} needs a list.` };
    if (value.length > DESIGN_LIMITS.maxItems) return { error: `${what} holds at most ${DESIGN_LIMITS.maxItems} items.` };
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `${what} needs objects.` };
    }
    return { items: value as Record<string, unknown>[] };
  };
  const readFeatures = (): { features: DesignFeature[] } | { error: string } => {
    const got = list(raw.features, "Features");
    if ("error" in got) return got;
    const features: DesignFeature[] = [];
    for (const item of got.items) {
      const badFeature = checkText(item.title, DESIGN_LIMITS.maxItemChars, "A feature title") ?? checkText(item.text, DESIGN_LIMITS.maxItemChars, "A feature");
      if (badFeature) return { error: badFeature };
      if (typeof item.title !== "string" || typeof item.text !== "string") return { error: "A feature needs { title, text }." };
      features.push({ title: item.title, text: item.text });
    }
    return { features };
  };
  const readTiers = (): { tiers: DesignTier[] } | { error: string } => {
    const got = list(raw.tiers, "Tiers");
    if ("error" in got) return got;
    const tiers: DesignTier[] = [];
    for (const item of got.items) {
      const badTier = checkText(item.name, DESIGN_LIMITS.maxItemChars, "A tier name") ?? checkText(item.price, 40, "A tier price");
      if (badTier) return { error: badTier };
      if (typeof item.name !== "string" || typeof item.price !== "string" || !Array.isArray(item.features)) {
        return { error: "A tier needs { name, price, features }." };
      }
      for (const feature of item.features) {
        if (typeof feature !== "string" || feature.length > DESIGN_LIMITS.maxItemChars) return { error: "A tier feature needs short text." };
      }
      tiers.push({ name: item.name, price: item.price, features: item.features as string[], ...(item.highlight === true ? { highlight: true } : {}) });
    }
    return { tiers };
  };
  const readProjects = (): { projects: DesignProject[] } | { error: string } => {
    const got = list(raw.projects, "Projects");
    if ("error" in got) return got;
    const projects: DesignProject[] = [];
    for (const item of got.items) {
      const badProject = checkText(item.title, DESIGN_LIMITS.maxItemChars, "A project title") ?? checkText(item.text, DESIGN_LIMITS.maxItemChars, "A project") ?? checkText(item.tag, 40, "A project tag");
      if (badProject) return { error: badProject };
      if (typeof item.title !== "string" || typeof item.text !== "string") return { error: "A project needs { title, text }." };
      projects.push({ title: item.title, text: item.text, ...(typeof item.tag === "string" ? { tag: item.tag } : {}) });
    }
    return { projects };
  };
  const readStats = (): { stats: DesignStat[] } | { error: string } => {
    const got = list(raw.stats, "Stats");
    if ("error" in got) return got;
    const stats: DesignStat[] = [];
    for (const item of got.items) {
      const badStat = checkText(item.label, DESIGN_LIMITS.maxItemChars, "A stat label") ?? checkText(item.value, 40, "A stat value") ?? checkText(item.change, 40, "A stat change");
      if (badStat) return { error: badStat };
      if (typeof item.label !== "string" || typeof item.value !== "string") return { error: "A stat needs { label, value }." };
      stats.push({ label: item.label, value: item.value, ...(typeof item.change === "string" ? { change: item.change } : {}) });
    }
    return { stats };
  };
  const features = readFeatures();
  if ("error" in features) return features;
  const tiers = readTiers();
  if ("error" in tiers) return tiers;
  const projects = readProjects();
  if ("error" in projects) return projects;
  const stats = readStats();
  if ("error" in stats) return stats;
  const design: DesignInput = {
    layout: raw.layout as DesignLayout,
    brand: (raw.brand as string).trim(),
    headline: (raw.headline as string).trim(),
    ...(typeof raw.subhead === "string" ? { subhead: raw.subhead } : {}),
    ...(typeof raw.ctaLabel === "string" ? { ctaLabel: raw.ctaLabel } : {}),
    ...(features.features.length ? { features: features.features } : {}),
    ...(tiers.tiers.length ? { tiers: tiers.tiers } : {}),
    ...(projects.projects.length ? { projects: projects.projects } : {}),
    ...(stats.stats.length ? { stats: stats.stats } : {}),
  };
  if (design.layout === "pricing" && design.tiers?.length !== 3) return { error: "Pricing needs exactly 3 tiers." };
  if (design.layout === "portfolio" && !design.projects?.length) return { error: "A portfolio needs at least one project." };
  if (design.layout === "dashboard" && !design.stats?.length) return { error: "A dashboard needs at least one stat." };
  return { design };
}

const NAV = (brand: string) =>
  `<nav><span class="brand">${escapeHtml(brand)}</span><span class="nav-links"><a>Product</a><a>Pricing</a><a>About</a></span><span class="cta">${escapeHtml("Sign in")}</span></nav>`;

const CTA = (label?: string) =>
  label ? `<div class="cta-row"><button type="button" class="cta-btn">${escapeHtml(label)}</button></div>` : "";

const FEATURES = (features?: DesignFeature[]) =>
  features?.length
    ? `<section class="features">${features.map((feature) => `<div class="feature"><h3>${escapeHtml(feature.title)}</h3><p>${escapeHtml(feature.text)}</p></div>`).join("")}</section>`
    : "";

function heroBody(design: DesignInput): string {
  return `${NAV(design.brand)}
<header class="hero"><h1>${escapeHtml(design.headline)}</h1>
${design.subhead ? `<p class="subhead">${escapeHtml(design.subhead)}</p>` : ""}
${CTA(design.ctaLabel)}</header>
${FEATURES(design.features)}
<footer>© ${escapeHtml(design.brand)}</footer>`;
}

function pricingBody(design: DesignInput): string {
  const tiers = design.tiers ?? [];
  return `${NAV(design.brand)}
<header class="page-head"><h1>${escapeHtml(design.headline)}</h1>
${design.subhead ? `<p class="subhead">${escapeHtml(design.subhead)}</p>` : ""}</header>
<section class="tiers">${tiers.map((tier) => `<div class="tier${tier.highlight ? " highlight" : ""}">
<h3>${escapeHtml(tier.name)}</h3><div class="price">${escapeHtml(tier.price)}</div>
<ul>${tier.features.map((feature) => `<li>${escapeHtml(feature)}</li>`).join("")}</ul>
<button type="button" class="cta-btn">Choose ${escapeHtml(tier.name)}</button></div>`).join("")}</section>
<footer>© ${escapeHtml(design.brand)}</footer>`;
}

function portfolioBody(design: DesignInput): string {
  const projects = design.projects ?? [];
  return `${NAV(design.brand)}
<header class="page-head"><h1>${escapeHtml(design.headline)}</h1>
${design.subhead ? `<p class="subhead">${escapeHtml(design.subhead)}</p>` : ""}</header>
<section class="grid">${projects.map((project, i) => `<article class="card">
<div class="thumb tone-${i % 4}"></div>
${project.tag ? `<span class="tag">${escapeHtml(project.tag)}</span>` : ""}
<h3>${escapeHtml(project.title)}</h3><p>${escapeHtml(project.text)}</p></article>`).join("")}</section>
<footer>© ${escapeHtml(design.brand)}</footer>`;
}

function dashboardBody(design: DesignInput): string {
  const stats = design.stats ?? [];
  const bars = [42, 68, 55, 80, 62, 90, 74];
  return `<div class="dash">
<aside><span class="brand">${escapeHtml(design.brand)}</span><a class="active">Overview</a><a>Reports</a><a>Settings</a></aside>
<main><h1>${escapeHtml(design.headline)}</h1>
${design.subhead ? `<p class="subhead">${escapeHtml(design.subhead)}</p>` : ""}
<section class="stats">${stats.map((stat) => `<div class="stat"><span class="stat-value">${escapeHtml(stat.value)}</span><span class="stat-label">${escapeHtml(stat.label)}</span>${stat.change ? `<span class="stat-change">${escapeHtml(stat.change)}</span>` : ""}</div>`).join("")}</section>
<section class="chart" aria-label="Chart placeholder"><div class="bars">${bars.map((height) => `<div class="bar" style="height:${height}%"></div>`).join("")}</div><span>Weekly activity</span></section>
</main></div>`;
}

function signupBody(design: DesignInput): string {
  return `<div class="split">
<section class="split-copy"><span class="brand">${escapeHtml(design.brand)}</span>
<h1>${escapeHtml(design.headline)}</h1>
${design.subhead ? `<p class="subhead">${escapeHtml(design.subhead)}</p>` : ""}
${FEATURES(design.features)}</section>
<section class="split-form"><form id="signup"><h2>Create your account</h2>
<label>Name<input name="name" autocomplete="name"></label>
<label>Email<input name="email" type="email" autocomplete="email"></label>
<label>Password<input name="password" type="password" autocomplete="new-password"></label>
<button type="submit" class="cta-btn">${escapeHtml(design.ctaLabel ?? "Create account")}</button>
<p id="form-note" role="status">A mockup: nothing is sent.</p></form></section></div>`;
}

const BODIES: Record<DesignLayout, (design: DesignInput) => string> = {
  hero: heroBody,
  pricing: pricingBody,
  portfolio: portfolioBody,
  dashboard: dashboardBody,
  signup: signupBody,
};

/** The design as show_html `html`. */
export function renderDesign(input: unknown): { html: string; title: string; height: number } | { error: string } {
  const checked = validateDesignInput(input);
  if ("error" in checked) return checked;
  const { design } = checked;
  const html = artifactShell({
    title: `${design.brand} — ${design.headline}`,
    css: `body{font-size:15px;line-height:1.5}
nav{display:flex;align-items:center;gap:24px;padding:16px 32px;border-bottom:1px solid var(--color-border-primary)}
.brand{font-weight:600;font-size:17px}
.nav-links{display:flex;gap:20px;margin-left:auto;font-size:14px;color:var(--color-text-secondary)}
.nav-links a{cursor:pointer}
.cta{margin-left:auto;font-size:14px}
.nav-links + .cta{margin-left:0}
.hero,.page-head{max-width:720px;margin:0 auto;padding:64px 24px 32px;text-align:center}
.hero h1,.page-head h1{font-size:40px;line-height:1.15;margin:0 0 16px}
.subhead{font-size:18px;color:var(--color-text-secondary);margin:0}
.cta-row{margin-top:28px}
.cta-btn{font:inherit;font-size:15px;padding:12px 24px;border-radius:999px;border:1px solid var(--color-border-primary);background:var(--color-text-primary);color:var(--color-background-primary);cursor:pointer}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;max-width:960px;margin:0 auto;padding:16px 24px 48px}
.feature h3{font-size:16px;margin:0 0 6px}
.feature p{font-size:14px;color:var(--color-text-secondary);margin:0}
footer{text-align:center;font-size:13px;color:var(--color-text-secondary);padding:24px;border-top:1px solid var(--color-border-primary)}
.tiers{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;max-width:960px;margin:0 auto;padding:16px 24px 48px}
.tier{border:1px solid var(--color-border-primary);border-radius:12px;padding:24px;display:flex;flex-direction:column;gap:12px}
.tier.highlight{border-color:var(--color-text-primary)}
.tier h3{font-size:16px;margin:0}
.price{font-size:28px;font-weight:600}
.tier ul{margin:0;padding-left:18px;font-size:14px;color:var(--color-text-secondary);line-height:1.7}
.tier .cta-btn{margin-top:auto;background:var(--color-background-secondary);color:inherit}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;max-width:960px;margin:0 auto;padding:16px 24px 48px}
.card{border:1px solid var(--color-border-primary);border-radius:12px;padding:16px}
.thumb{height:120px;border-radius:8px;margin-bottom:12px}
.tone-0{background:linear-gradient(135deg,#7c8cff,#b8c0ff)}
.tone-1{background:linear-gradient(135deg,#5ec2a6,#a8e6cf)}
.tone-2{background:linear-gradient(135deg,#f2a65a,#ffd9a0)}
.tone-3{background:linear-gradient(135deg,#e0789a,#ffc2d4)}
.tag{display:inline-block;font-size:12px;color:var(--color-text-secondary);border:1px solid var(--color-border-primary);border-radius:999px;padding:2px 8px;margin-bottom:8px}
.card h3{font-size:16px;margin:0 0 4px}
.card p{font-size:14px;color:var(--color-text-secondary);margin:0}
.dash{display:flex;min-height:560px}
.dash aside{width:200px;flex-shrink:0;border-right:1px solid var(--color-border-primary);padding:20px;display:flex;flex-direction:column;gap:4px}
.dash aside a{display:block;padding:8px 10px;border-radius:8px;font-size:14px;color:var(--color-text-secondary);cursor:pointer}
.dash aside a.active{background:var(--color-background-secondary);color:inherit}
.dash main{flex:1;padding:24px 32px;min-width:0}
.dash h1{font-size:24px;margin:0 0 8px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:20px 0}
.stat{border:1px solid var(--color-border-primary);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:2px}
.stat-value{font-size:24px;font-weight:600}
.stat-label{font-size:13px;color:var(--color-text-secondary)}
.stat-change{font-size:12px;color:var(--color-text-secondary)}
.chart{border:1px solid var(--color-border-primary);border-radius:12px;padding:16px}
.bars{display:flex;align-items:flex-end;gap:10px;height:120px;margin-bottom:8px}
.bar{flex:1;background:var(--color-text-secondary);opacity:.5;border-radius:4px 4px 0 0}
.chart span{font-size:13px;color:var(--color-text-secondary)}
.split{display:grid;grid-template-columns:1fr 1fr;min-height:560px}
.split-copy{padding:48px 40px;display:flex;flex-direction:column;gap:16px;justify-content:center}
.split-copy h1{font-size:36px;line-height:1.2;margin:0}
.split-copy .features{padding:0;margin-top:8px}
.split-form{padding:48px 40px;display:flex;align-items:center;background:var(--color-background-secondary)}
.split-form form{width:100%;max-width:360px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.split-form h2{font-size:20px;margin:0}
.split-form label{display:flex;flex-direction:column;gap:6px;font-size:14px}
.split-form input{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--color-border-primary);background:var(--color-background-primary);color:inherit}
#form-note{font-size:13px;color:var(--color-text-secondary);margin:0}`,
    body: BODIES[design.layout](design),
    script:
      design.layout === "signup"
        ? `(function () { "use strict"; document.getElementById("signup").addEventListener("submit", function (event) { event.preventDefault(); document.getElementById("form-note").textContent = "This is a mockup, so the account was not created."; }); })();`
        : undefined,
  });
  if (new TextEncoder().encode(html).length > DESIGN_LIMITS.maxHtmlBytes) {
    return { error: `The design renders over ${Math.round(DESIGN_LIMITS.maxHtmlBytes / 1000)} KB. Shorten it.` };
  }
  return { html, title: `${design.brand} — ${design.headline}`, height: design.layout === "dashboard" || design.layout === "signup" ? 600 : 640 };
}
