export function Pre({ children }: { children: string }) {
  return (
    <pre className="bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-sm font-mono leading-relaxed">
      {children}
    </pre>
  );
}
