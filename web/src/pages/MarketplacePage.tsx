import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  Package,
  Puzzle,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@nous-research/ui/ui/components/badge";
import { Button } from "@nous-research/ui/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@nous-research/ui/ui/components/card";
import { Spinner } from "@nous-research/ui/ui/components/spinner";
import { H2 } from "@nous-research/ui/ui/components/typography/h2";
import { Input } from "@nous-research/ui/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@nous-research/ui/ui/components/dialog";
import { api } from "@/lib/api";
import { useToast } from "@nous-research/ui/hooks/use-toast";

// ── Types ────────────────────────────────────────────────────────────

interface Skill {
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  platforms: string[];
  tags: string[];
  related_skills: string[];
  homepage: string;
  category: string;
  path: string;
  installed: boolean;
  id: string;
  display_name: string;
  body?: string;
}

interface McpServer {
  name: string;
  description: string;
  package: string;
  command: string;
  args: string[];
  homepage: string;
  installed: boolean;
  version: string;
}

interface MarketplaceOverview {
  total_skills: number;
  categories: Record<string, number>;
  popular_tags: Record<string, number>;
  mcp_servers: number;
  recent_skills: Skill[];
}

interface SkillsResponse {
  skills: Skill[];
  total: number;
  categories: Record<string, number>;
  popular_tags: Record<string, number>;
}

// ── Fetch helpers ────────────────────────────────────────────────────

async function fetchOverview(): Promise<MarketplaceOverview> {
  const r = await fetch(`${api.baseUrl}/api/v1/marketplace/overview`);
  if (!r.ok) throw new Error("Failed to load marketplace overview");
  return r.json();
}

async function fetchSkills(params: {
  q?: string;
  category?: string;
  tags?: string;
  limit?: number;
}): Promise<SkillsResponse> {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.category) sp.set("category", params.category);
  if (params.tags) sp.set("tags", params.tags);
  sp.set("limit", String(params.limit ?? 50));
  const r = await fetch(`${api.baseUrl}/api/v1/marketplace/skills?${sp}`);
  if (!r.ok) throw new Error("Failed to load skills");
  return r.json();
}

async function fetchSkillDetail(id: string): Promise<Skill> {
  const r = await fetch(`${api.baseUrl}/api/v1/marketplace/skills/${id}`);
  if (!r.ok) throw new Error("Skill not found");
  return r.json();
}

async function installSkill(identifier: string): Promise<{ ok: boolean }> {
  const r = await fetch(`${api.baseUrl}/api/v1/marketplace/skills/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Install failed" }));
    throw new Error(err.detail || "Install failed");
  }
  return r.json();
}

async function uninstallSkill(name: string): Promise<{ ok: boolean }> {
  const r = await fetch(`${api.baseUrl}/api/v1/marketplace/skills/uninstall`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: "Uninstall failed" }));
    throw new Error(err.detail || "Uninstall failed");
  }
  return r.json();
}

async function fetchMcpServers(q?: string): Promise<McpServer[]> {
  const sp = q ? `?q=${encodeURIComponent(q)}` : "";
  const r = await fetch(`${api.baseUrl}/api/v1/marketplace/mcp${sp}`);
  if (!r.ok) throw new Error("Failed to load MCP servers");
  return r.json();
}

async function refreshIndex(): Promise<{ ok: boolean; indexed: number }> {
  const r = await fetch(`${api.baseUrl}/api/v1/marketplace/skills/refresh`, {
    method: "POST",
  });
  if (!r.ok) throw new Error("Failed to refresh");
  return r.json();
}

// ── Skill Card ───────────────────────────────────────────────────────

function SkillCard({
  skill,
  onSelect,
  onInstall,
  onUninstall,
}: {
  skill: Skill;
  onSelect: (s: Skill) => void;
  onInstall: (id: string) => void;
  onUninstall: (name: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleAction = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setBusy(true);
      try {
        if (skill.installed) {
          await onUninstall(skill.name);
        } else {
          await onInstall(skill.name);
        }
      } finally {
        setBusy(false);
      }
    },
    [skill, onInstall, onUninstall]
  );

  return (
    <Card
      className="cursor-pointer transition-colors hover:border-primary/50"
      onClick={() => onSelect(skill)}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold">
                {skill.display_name || skill.name}
              </h3>
              {skill.version && (
                <Badge variant="outline" className="shrink-0 text-xs">
                  v{skill.version}
                </Badge>
              )}
            </div>
            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {skill.description || "No description"}
            </p>
          </div>
          <Button
            variant={skill.installed ? "destructive" : "default"}
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={handleAction}
          >
            {busy ? (
              <Spinner className="h-4 w-4" />
            ) : skill.installed ? (
              <>
                <Trash2 className="mr-1 h-3 w-3" />
                Remove
              </>
            ) : (
              <>
                <Download className="mr-1 h-3 w-3" />
                Install
              </>
            )}
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap gap-1">
          {skill.category && (
            <Badge variant="secondary" className="text-xs">
              {skill.category}
            </Badge>
          )}
          {skill.tags.slice(0, 3).map((t) => (
            <Badge key={t} variant="outline" className="text-xs">
              {t}
            </Badge>
          ))}
          {skill.tags.length > 3 && (
            <Badge variant="outline" className="text-xs">
              +{skill.tags.length - 3}
            </Badge>
          )}
        </div>

        <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
          {skill.author && <span>{skill.author}</span>}
          {skill.license && <span>• {skill.license}</span>}
          {skill.installed && (
            <Badge variant="default" className="ml-auto text-xs">
              Installed
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Skill Detail Dialog ──────────────────────────────────────────────

function SkillDetailDialog({
  skill,
  open,
  onClose,
}: {
  skill: Skill | null;
  open: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const handleInstall = useCallback(async () => {
    if (!skill) return;
    setBusy(true);
    try {
      await installSkill(skill.name);
      toast({ title: `Installed ${skill.display_name || skill.name}` });
      onClose();
    } catch (err: any) {
      toast({ title: "Install failed", description: err.message });
    } finally {
      setBusy(false);
    }
  }, [skill, toast, onClose]);

  const handleUninstall = useCallback(async () => {
    if (!skill) return;
    setBusy(true);
    try {
      await uninstallSkill(skill.name);
      toast({ title: `Removed ${skill.display_name || skill.name}` });
      onClose();
    } catch (err: any) {
      toast({ title: "Remove failed", description: err.message });
    } finally {
      setBusy(false);
    }
  }, [skill, toast, onClose]);

  if (!skill) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            {skill.display_name || skill.name}
          </DialogTitle>
          <DialogDescription>
            {skill.description || "No description available"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap gap-2">
            {skill.version && <Badge variant="outline">v{skill.version}</Badge>}
            {skill.author && <Badge variant="secondary">{skill.author}</Badge>}
            {skill.license && <Badge variant="secondary">{skill.license}</Badge>}
          </div>

          {skill.tags.length > 0 && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">Tags</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {skill.tags.map((t) => (
                  <Badge key={t} variant="outline" className="text-xs">
                    {t}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {skill.platforms.length > 0 && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">Platforms</span>
              <p className="mt-0.5 text-xs">{skill.platforms.join(", ")}</p>
            </div>
          )}

          {skill.related_skills.length > 0 && (
            <div>
              <span className="text-xs font-medium text-muted-foreground">Related Skills</span>
              <p className="mt-0.5 text-xs">{skill.related_skills.join(", ")}</p>
            </div>
          )}

          {skill.homepage && (
            <a
              href={skill.homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Homepage
            </a>
          )}

          {skill.body && (
            <div className="max-h-60 overflow-y-auto rounded-md bg-muted/50 p-3">
              <pre className="whitespace-pre-wrap text-xs text-muted-foreground">
                {skill.body.slice(0, 3000)}
              </pre>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {skill.installed ? (
            <Button variant="destructive" disabled={busy} onClick={handleUninstall}>
              {busy ? <Spinner className="mr-2 h-4 w-4" /> : <Trash2 className="mr-2 h-4 w-3" />}
              Remove
            </Button>
          ) : (
            <Button disabled={busy} onClick={handleInstall}>
              {busy ? <Spinner className="mr-2 h-4 w-4" /> : <Download className="mr-2 h-4 w-3" />}
              Install
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── MCP Server Card ──────────────────────────────────────────────────

function McpCard({ server }: { server: McpServer }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">{server.name}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {server.description}
            </p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {server.package}
            </p>
          </div>
          {server.homepage && (
            <a
              href={server.homepage}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-muted-foreground hover:text-primary"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Tab Button ───────────────────────────────────────────────────────

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

type Tab = "skills" | "mcp";

export default function MarketplacePage() {
  const [tab, setTab] = useState<Tab>("skills");
  const [query, setQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [selectedTag, setSelectedTag] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [overview, setOverview] = useState<MarketplaceOverview | null>(null);
  const [categories, setCategories] = useState<Record<string, number>>({});
  const [tags, setTags] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const { toast } = useToast();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Load overview on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ov = await fetchOverview();
        if (!cancelled) {
          setOverview(ov);
          setCategories(ov.categories);
          setTags(ov.popular_tags);
        }
      } catch {
        // Non-fatal
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load skills when tab or filters change
  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetchSkills({
        q: query || undefined,
        category: selectedCategory || undefined,
        tags: selectedTag || undefined,
        limit: 100,
      });
      setSkills(resp.skills);
      if (resp.categories) setCategories(resp.categories);
      if (resp.popular_tags) setTags(resp.popular_tags);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [query, selectedCategory, selectedTag]);

  useEffect(() => {
    if (tab === "skills") loadSkills();
  }, [tab, loadSkills]);

  // Load MCP servers
  useEffect(() => {
    if (tab !== "mcp") return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const servers = await fetchMcpServers(query || undefined);
        if (!cancelled) setMcpServers(servers);
      } catch (err: any) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tab, query]);

  // Debounced search
  const handleSearch = useCallback((val: string) => {
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      // Trigger reload via state change
    }, 300);
  }, []);

  // Install/uninstall handlers
  const handleInstall = useCallback(
    async (identifier: string) => {
      try {
        await installSkill(identifier);
        toast({ title: `Installed ${identifier}` });
        loadSkills();
      } catch (err: any) {
        toast({ title: "Install failed", description: err.message });
      }
    },
    [toast, loadSkills]
  );

  const handleUninstall = useCallback(
    async (name: string) => {
      try {
        await uninstallSkill(name);
        toast({ title: `Removed ${name}` });
        loadSkills();
      } catch (err: any) {
        toast({ title: "Remove failed", description: err.message });
      }
    },
    [toast, loadSkills]
  );

  // Select skill for detail view
  const handleSelectSkill = useCallback(async (skill: Skill) => {
    try {
      const detail = await fetchSkillDetail(skill.id);
      setSelectedSkill(detail);
    } catch {
      setSelectedSkill(skill);
    }
    setDetailOpen(true);
  }, []);

  // Refresh index
  const handleRefresh = useCallback(async () => {
    try {
      const result = await refreshIndex();
      toast({ title: `Refreshed — ${result.indexed} skills indexed` });
      loadSkills();
    } catch (err: any) {
      toast({ title: "Refresh failed", description: err.message });
    }
  }, [toast, loadSkills]);

  const categoryList = useMemo(
    () => Object.entries(categories).sort((a, b) => b[1] - a[1]),
    [categories]
  );

  const tagList = useMemo(
    () => Object.entries(tags).slice(0, 30).sort((a, b) => b[1] - a[1]),
    [tags]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden p-4">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <H2>Marketplace</H2>
          {overview && (
            <span className="text-sm text-muted-foreground">
              {overview.total_skills} skills • {overview.mcp_servers} MCP servers
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="mr-1 h-3 w-3" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Tabs + Search */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1">
          <TabButton active={tab === "skills"} onClick={() => setTab("skills")}>
            <Package className="mr-1 inline h-4 w-4" />
            Skills
          </TabButton>
          <TabButton active={tab === "mcp"} onClick={() => setTab("mcp")}>
            <Puzzle className="mr-1 inline h-4 w-4" />
            MCP Servers
          </TabButton>
        </div>
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={tab === "skills" ? "Search skills..." : "Search MCP servers..."}
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-8"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* Sidebar: categories & tags (skills tab only) */}
        {tab === "skills" && (categoryList.length > 0 || tagList.length > 0) && (
          <div className="hidden w-56 shrink-0 overflow-y-auto md:block">
            {categoryList.length > 0 && (
              <div className="mb-4">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Categories
                </h4>
                <div className="space-y-0.5">
                  <button
                    onClick={() => setSelectedCategory("")}
                    className={`block w-full rounded px-2 py-1 text-left text-xs transition-colors ${
                      !selectedCategory
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    All ({overview?.total_skills ?? 0})
                  </button>
                  {categoryList.map(([cat, count]) => (
                    <button
                      key={cat}
                      onClick={() =>
                        setSelectedCategory(selectedCategory === cat ? "" : cat)
                      }
                      className={`block w-full rounded px-2 py-1 text-left text-xs transition-colors ${
                        selectedCategory === cat
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground"
                      }`}
                    >
                      {cat} ({count})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {tagList.length > 0 && (
              <div>
                <h4 className="mb-2 flex items-center gap-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Tag className="h-3 w-3" />
                  Tags
                </h4>
                <div className="flex flex-wrap gap-1">
                  {tagList.map(([tag, count]) => (
                    <button
                      key={tag}
                      onClick={() =>
                        setSelectedTag(selectedTag === tag ? "" : tag)
                      }
                    >
                      <Badge
                        variant={selectedTag === tag ? "default" : "outline"}
                        className="cursor-pointer text-xs"
                      >
                        {tag}
                        <span className="ml-1 text-muted-foreground">({count})</span>
                      </Badge>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Main content */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Spinner className="h-8 w-8" />
            </div>
          ) : error ? (
            <Card>
              <CardContent className="py-12 text-center">
                <p className="text-sm text-muted-foreground">{error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={tab === "skills" ? loadSkills : () => {}}
                >
                  Retry
                </Button>
              </CardContent>
            </Card>
          ) : tab === "skills" ? (
            skills.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Package className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    {query || selectedCategory || selectedTag
                      ? "No skills match your filters"
                      : "No skills found — try refreshing the index"}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {skills.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    onSelect={handleSelectSkill}
                    onInstall={handleInstall}
                    onUninstall={handleUninstall}
                  />
                ))}
              </div>
            )
          ) : (
            /* MCP tab */
            mcpServers.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Puzzle className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">
                    {query ? "No MCP servers match your search" : "No MCP servers found"}
                  </p>
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {mcpServers.map((server) => (
                  <McpCard key={server.name} server={server} />
                ))}
              </div>
            )
          )}
        </div>
      </div>

      {/* Skill detail dialog */}
      <SkillDetailDialog
        skill={selectedSkill}
        open={detailOpen}
        onClose={() => {
          setDetailOpen(false);
          setSelectedSkill(null);
          loadSkills();
        }}
      />
    </div>
  );
}
