"use client";
import { cn } from "~/lib/utils/cn";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  size?: "md" | "lg";
}

const sizeClasses = {
  md: "max-w-md",
  lg: "max-w-lg",
};

export function Dialog({
  open,
  onOpenChange,
  children,
  size = "md",
}: DialogProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="fixed inset-0 bg-black/50"
        onClick={() => onOpenChange(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative z-50 w-full rounded-lg bg-white p-6 shadow-lg max-h-[90vh] overflow-y-auto",
          sizeClasses[size],
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2 className={cn("text-lg font-semibold mb-4", className)}>{children}</h2>
  );
}

export function DialogFooter({ children }: { children: React.ReactNode }) {
  return <div className="flex justify-end gap-2 mt-6">{children}</div>;
}
