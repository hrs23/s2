import {
  AppWindow,
  ExternalLink,
  File,
  KeyRound,
  Menu,
  Settings,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink, Outlet, redirect } from "react-router";
import { getAppContext, getRuntimeEnv } from "~/lib/app-load-context.server";
import { getUser } from "~/lib/auth/auth.server";
import { cn } from "~/lib/utils/cn";
import {
  formatBytes,
  formatStorageLimit,
  formatStorageSize,
} from "~/lib/utils/format";
import type { Route } from "./+types/_dashboard";

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getRuntimeEnv(context);
  const user = await getUser(request, env);
  if (!user) return redirect("/login");

  const storageLimit = user.storage_limit_bytes;
  const storageAvailableBytes =
    storageLimit === 0
      ? await getStorageAvailableBytes(getAppContext(context).storage)
      : null;

  return { user, storageLimit, storageAvailableBytes, appUrl: env.APP_URL };
}

async function getStorageAvailableBytes(
  storage: ReturnType<typeof getAppContext>["storage"],
): Promise<number | null> {
  try {
    return await storage.availableBytes();
  } catch {
    return null;
  }
}

const navItems = [
  { to: "/files", key: "dashboard.myFiles", Icon: File },
  { to: "/tokens", key: "dashboard.apiTokens", Icon: KeyRound },
  { to: "/connections", key: "dashboard.connections", Icon: AppWindow },
  { to: "/settings", key: "dashboard.settings", Icon: Settings },
] as const;

function SidebarContent({
  user,
  storageLimit,
  storageAvailableBytes,
  onNavigate,
}: {
  user: { email: string; bytes_used: number };
  storageLimit: number;
  storageAvailableBytes: number | null;
  onNavigate?: () => void;
}) {
  const { t } = useTranslation("common");

  return (
    <>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map(({ to, key, Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                isActive
                  ? "bg-gray-700 text-white"
                  : "text-gray-300 hover:bg-gray-700 hover:text-white",
              )
            }
          >
            <Icon className="w-4 h-4" />
            {t(key)}
          </NavLink>
        ))}
        <a
          href="/docs"
          target="_blank"
          rel="noreferrer"
          onClick={onNavigate}
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors text-gray-300 hover:bg-gray-700 hover:text-white"
        >
          <ExternalLink className="w-4 h-4" />
          {t("dashboard.docs")}
        </a>
      </nav>
      <div className="px-4 py-4 border-t border-gray-700 space-y-3">
        <StorageUsage
          bytesUsed={user.bytes_used}
          storageLimit={storageLimit}
          storageAvailableBytes={storageAvailableBytes}
        />
        <p className="text-sm text-gray-200 truncate">{user.email}</p>
        <a
          href="/logout"
          className="text-xs text-gray-400 hover:text-white transition-colors"
        >
          {t("dashboard.logOut")}
        </a>
      </div>
    </>
  );
}

export function StorageUsage({
  bytesUsed,
  storageLimit,
  storageAvailableBytes,
}: {
  bytesUsed: number;
  storageLimit: number;
  storageAvailableBytes: number | null;
}) {
  const { t } = useTranslation("common");
  const usagePercent =
    storageLimit === 0 ? null : Math.min(100, (bytesUsed / storageLimit) * 100);

  return (
    <div>
      {usagePercent !== null && (
        <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              usagePercent > 90
                ? "bg-red-400"
                : usagePercent > 70
                  ? "bg-yellow-400"
                  : "bg-blue-400",
            )}
            style={{ width: `${usagePercent}%` }}
          />
        </div>
      )}
      <p className="text-xs text-gray-400 mt-1">
        {storageLimit === 0
          ? storageAvailableBytes === null
            ? t("dashboard.storageUsed", {
                used: formatStorageSize(bytesUsed),
              })
            : t("dashboard.storageUsageAvailable", {
                used: formatStorageSize(bytesUsed),
                available: formatBytes(storageAvailableBytes),
              })
          : t("dashboard.storageUsage", {
              used: formatStorageSize(bytesUsed),
              limit: formatStorageLimit(storageLimit),
            })}
      </p>
    </div>
  );
}

export default function DashboardLayout({ loaderData }: Route.ComponentProps) {
  const { user, storageLimit, storageAvailableBytes } = loaderData;
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Lock body scroll + Escape key when drawer is open
  useEffect(() => {
    if (!sidebarOpen) return;
    document.body.style.overflow = "hidden";
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setSidebarOpen(false);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = "";
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [sidebarOpen]);

  // Close drawer when resizing past md breakpoint
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    function handleChange(e: MediaQueryListEvent) {
      if (e.matches) setSidebarOpen(false);
    }
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, []);

  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Mobile header */}
      <div className="fixed top-0 left-0 right-0 z-30 flex items-center bg-gray-900 text-white px-4 py-3 md:hidden">
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className="p-1 -ml-1 mr-3"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <Link to="/files" className="font-bold text-lg tracking-tight">
          S2
        </Link>
      </div>

      {/* Mobile drawer overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-56 bg-gray-900 text-white flex flex-col transition-transform duration-200 md:hidden",
          sidebarOpen ? "translate-x-0" : "-translate-x-full",
        )}
        aria-label="Navigation"
        role="dialog"
        aria-modal="true"
      >
        <div className="px-6 py-5 border-b border-gray-700 flex items-center justify-between">
          <Link
            to="/files"
            className="font-bold text-lg tracking-tight hover:opacity-80 transition-opacity"
          >
            S2
          </Link>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="p-1 -mr-1"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <SidebarContent
          user={user}
          storageLimit={storageLimit}
          storageAvailableBytes={storageAvailableBytes}
          onNavigate={() => setSidebarOpen(false)}
        />
      </aside>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex sticky top-0 h-screen w-56 bg-gray-900 text-white flex-col shrink-0 overflow-y-auto">
        <div className="px-6 py-5 border-b border-gray-700">
          <Link
            to="/files"
            className="font-bold text-lg tracking-tight hover:opacity-80 transition-opacity"
          >
            S2
          </Link>
        </div>
        <SidebarContent
          user={user}
          storageLimit={storageLimit}
          storageAvailableBytes={storageAvailableBytes}
        />
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col overflow-auto">
        <main className="flex-1 p-4 pt-16 md:p-8 md:pt-8">
          <div className="max-w-5xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
