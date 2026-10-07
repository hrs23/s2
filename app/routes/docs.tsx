import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation } from "react-router";
import { DOCS_NAV } from "~/components/docs-pager";
import { LandingFooter, LandingHeader } from "~/components/landing-content";
import { pageTitle } from "~/i18n/meta";
import { cn } from "~/lib/utils/cn";

export function meta() {
  return [{ title: pageTitle("docs") }];
}

export default function DocsLayout() {
  const { t } = useTranslation("docs");
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const navItems = DOCS_NAV.map(({ to, labelKey }) => ({
    to,
    label: t(labelKey),
    end: to === "/docs",
  }));

  const currentLabel =
    navItems.find(
      (item) =>
        location.pathname === item.to ||
        (!item.end && location.pathname.startsWith(item.to)),
    )?.label ?? navItems[0].label;

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <LandingHeader
        maxWidth="max-w-6xl"
        className="border-b border-gray-200 bg-white sticky top-0 z-10"
      />

      {/* Mobile docs nav */}
      <div className="md:hidden border-b border-gray-200 px-6 py-2">
        <button
          type="button"
          className="flex items-center gap-1 text-sm font-medium text-gray-700 w-full py-1"
          onClick={() => setMobileNavOpen(!mobileNavOpen)}
        >
          {currentLabel}
          <ChevronDown
            className={cn(
              "w-4 h-4 transition-transform",
              mobileNavOpen && "rotate-180",
            )}
          />
        </button>
        {mobileNavOpen && (
          <nav className="py-2 space-y-1">
            {navItems.map(({ to, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => setMobileNavOpen(false)}
                className={({ isActive }) =>
                  cn(
                    "block px-3 py-2 rounded-md text-sm font-medium transition-colors",
                    isActive
                      ? "bg-gray-100 text-gray-900"
                      : "text-gray-600 hover:bg-gray-50 hover:text-gray-900",
                  )
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        )}
      </div>

      <div className="max-w-6xl mx-auto px-6 py-8 flex gap-8 flex-1 w-full">
        <aside className="hidden md:block w-48 flex-shrink-0 sticky top-20 self-start">
          <nav className="space-y-1">
            {navItems.map(({ to, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    "block px-3 py-2 rounded-md text-sm font-medium transition-colors",
                    isActive
                      ? "bg-gray-100 text-gray-900"
                      : "text-gray-600 hover:bg-gray-50 hover:text-gray-900",
                  )
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </aside>

        <div className="flex-1 min-w-0 max-w-3xl">
          <Outlet />
        </div>
      </div>

      <LandingFooter />
    </div>
  );
}
