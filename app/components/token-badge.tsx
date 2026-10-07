import { Link } from "react-router";

export function TokenBadge({ id, name }: { id: string; name: string }) {
  return (
    <Link
      to={`/tokens#${id}`}
      className="inline-block bg-violet-100 text-violet-700 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight hover:bg-violet-200 transition-colors"
      title={name}
    >
      {name}
    </Link>
  );
}
