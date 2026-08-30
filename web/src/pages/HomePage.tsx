import { useNavigate } from "react-router";
import {
  Monitor,
  Smartphone,
  Globe,
  Rocket,
  Shield,
  Package,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * SanRemes Agent — Home / Landing Page
 *
 * Shows the agent branding + platform menu so the user can jump to
 * Web Dashboard, Desktop App, or Mobile App.
 */

const PLATFORMS = [
  {
    id: "web",
    title: "Web Dashboard",
    description:
      "Full agent dashboard — sessions, files, analytics, missions, marketplace, and settings. Open right here.",
    icon: Globe,
    color: "#C4A265",
    action: "dashboard",
    route: "/sessions",
  },
  {
    id: "desktop",
    title: "Desktop App",
    description:
      "Native desktop experience with terminal, file browser, and real-time agent interaction.",
    icon: Monitor,
    color: "#3B82F6",
    action: "info",
    route: null,
  },
  {
    id: "mobile",
    title: "Mobile App",
    description:
      "Mission control on the go — approve tasks, monitor agents, and chat from your phone.",
    icon: Smartphone,
    color: "#10B981",
    action: "info",
    route: null,
  },
] as const;

const QUICK_ACTIONS = [
  {
    icon: Rocket,
    label: "New Mission",
    description: "Create an agent mission",
    route: "/autopilot",
    color: "#C4A265",
  },
  {
    icon: Shield,
    label: "Approvals",
    description: "Review pending requests",
    route: "/system",
    color: "#F59E0B",
  },
  {
    icon: Package,
    label: "Marketplace",
    description: "Browse skills & plugins",
    route: "/marketplace",
    color: "#3B82F6",
  },
];

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* Hero */}
      <div className="flex flex-col items-center gap-6 px-6 pt-12 pb-8 text-center">
        {/* Logo mark */}
        <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl bg-[#1B2A4A] shadow-lg">
          <span className="font-['Georgia',serif] text-3xl font-bold text-[#C4A265] leading-none">
            SR
          </span>
          <div className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-2 border-background bg-success" />
        </div>

        <div>
          <h1 className="font-['Georgia',serif] text-3xl font-bold tracking-[0.04em] text-midground uppercase">
            SanRemes
          </h1>
          <p className="mt-1 text-sm font-semibold tracking-[0.2em] text-[#C4A265] uppercase">
            Agent
          </p>
        </div>

        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
          The autonomous AI agent that grows with you. Choose your platform to
          get started.
        </p>
      </div>

      {/* Platform cards */}
      <div className="mx-auto w-full max-w-2xl px-6 pb-8">
        <h2 className="mb-4 font-sans text-xs font-semibold tracking-[0.15em] text-muted-foreground uppercase">
          Platforms
        </h2>
        <div className="flex flex-col gap-3">
          {PLATFORMS.map((p) => {
            const Icon = p.icon;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  if (p.route) navigate(p.route);
                }}
                className={cn(
                  "group flex items-center gap-4 rounded-xl border border-current/10 p-4",
                  "bg-background-base transition-all duration-200",
                  "hover:border-current/20 hover:shadow-md",
                  "cursor-pointer text-left",
                  p.route && "hover:translate-y-[-1px]",
                )}
              >
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg"
                  style={{ backgroundColor: p.color + "15" }}
                >
                  <Icon className="h-5 w-5" style={{ color: p.color }} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-midground">
                      {p.title}
                    </span>
                    {p.id === "web" && (
                      <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success uppercase">
                        Active
                      </span>
                    )}
                    {p.id === "desktop" && (
                      <span className="rounded-full bg-info/10 px-2 py-0.5 text-[10px] font-semibold text-info uppercase">
                        Download
                      </span>
                    )}
                    {p.id === "mobile" && (
                      <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold text-success uppercase">
                        Coming Soon
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                    {p.description}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
              </button>
            );
          })}
        </div>
      </div>

      {/* Quick actions */}
      <div className="mx-auto w-full max-w-2xl px-6 pb-12">
        <h2 className="mb-4 font-sans text-xs font-semibold tracking-[0.15em] text-muted-foreground uppercase">
          Quick Actions
        </h2>
        <div className="grid grid-cols-3 gap-3">
          {QUICK_ACTIONS.map((a) => {
            const Icon = a.icon;
            return (
              <button
                key={a.label}
                type="button"
                onClick={() => navigate(a.route)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-xl border border-current/10 p-4",
                  "bg-background-base transition-all duration-200",
                  "hover:border-current/20 hover:shadow-md hover:translate-y-[-1px]",
                  "cursor-pointer text-center",
                )}
              >
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-lg"
                  style={{ backgroundColor: a.color + "15" }}
                >
                  <Icon className="h-5 w-5" style={{ color: a.color }} />
                </div>
                <div>
                  <span className="block text-xs font-semibold text-midground">
                    {a.label}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {a.description}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-current/10 px-6 py-4 text-center">
        <p className="text-[10px] tracking-[0.1em] text-muted-foreground/60 uppercase">
          SanRemes Agent v1.0 &middot; The agent that grows with you
        </p>
      </div>
    </div>
  );
}
