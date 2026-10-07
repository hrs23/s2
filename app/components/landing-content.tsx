import { Link } from "react-router";
import { cn } from "~/lib/utils/cn";

export function LandingHeader({
  maxWidth = "max-w-5xl",
  className,
}: {
  maxWidth?: string;
  className?: string;
}) {
  return (
    <header className={cn("border-b border-gray-200 bg-white", className)}>
      <div
        className={cn(
          "mx-auto flex h-14 items-center justify-between px-6",
          maxWidth,
        )}
      >
        <Link to="/" className="text-lg font-bold text-gray-900">
          S2
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link to="/docs" className="text-gray-600 hover:text-gray-900">
            Docs
          </Link>
          <Link to="/login" className="text-gray-600 hover:text-gray-900">
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function LandingFooter() {
  return (
    <footer className="border-t border-gray-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5 text-sm text-gray-500">
        <span>S2</span>
        <Link to="/docs" className="hover:text-gray-900">
          Docs
        </Link>
      </div>
    </footer>
  );
}
