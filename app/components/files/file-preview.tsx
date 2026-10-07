/**
 * In-browser file viewers.
 * image / pdf / video / audio / markdown / code (with syntax highlight).
 * No HTML rendering, no SVG rendering, no Office docs.
 */

import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  exceedsPreviewLimit,
  getPreviewType,
  type PreviewType,
} from "./file-utils";

// --- Markdown ---

// Minimal markdown styling without pulling in @tailwindcss/typography.
// Targets common markdown elements via Tailwind's arbitrary child selectors.
const MARKDOWN_STYLES = [
  "rounded-md border border-gray-200 bg-white p-4 overflow-auto max-h-[60vh]",
  "text-sm text-gray-800 leading-relaxed",
  "[&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mt-2 [&_h1]:mb-3",
  "[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2",
  "[&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-2",
  "[&_h4]:text-base [&_h4]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1",
  "[&_p]:my-2",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2",
  "[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2",
  "[&_li]:my-0.5",
  "[&_a]:text-blue-600 [&_a]:underline hover:[&_a]:text-blue-800",
  "[&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-gray-100 [&_code]:rounded [&_code]:text-xs [&_code]:font-mono",
  "[&_pre]:bg-gray-50 [&_pre]:border [&_pre]:border-gray-200 [&_pre]:rounded [&_pre]:p-3 [&_pre]:overflow-auto [&_pre]:my-2",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_blockquote]:border-l-4 [&_blockquote]:border-gray-300 [&_blockquote]:pl-3 [&_blockquote]:text-gray-600 [&_blockquote]:my-2",
  "[&_table]:border-collapse [&_table]:my-2 [&_table]:text-sm",
  "[&_th]:border [&_th]:border-gray-300 [&_th]:px-2 [&_th]:py-1 [&_th]:bg-gray-50 [&_th]:font-semibold",
  "[&_td]:border [&_td]:border-gray-300 [&_td]:px-2 [&_td]:py-1",
  "[&_hr]:my-4 [&_hr]:border-gray-200",
  "[&_img]:max-w-full [&_img]:h-auto",
].join(" ");

/**
 * Resolve a markdown image src against the directory of the file currently
 * being previewed and rewrite it to an authenticated `/api/v1/files/...` URL the
 * browser can fetch with the user's session cookie.
 *
 * - Absolute http(s)/data URLs pass through untouched.
 * - Site-absolute paths (`/foo/bar.png`) resolve relative to the user's root.
 * - Relative paths (`attachments/x.jpg`, `./img.png`, `../sibling/x.png`)
 *   resolve against the directory containing the current markdown file.
 *
 * `..` segments that escape the user's root are dropped — the API request
 * would 403 anyway, but we'd rather not fire it.
 */
export function resolveMarkdownImageSrc(src: string, filePath: string): string {
  if (!src) return src;
  if (/^(https?:|blob:)/i.test(src)) return src;
  // data: URLs are restricted to raster image MIME types — `data:image/svg+xml`
  // can carry inline `<script>` / `onload`, and `data:text/html` is dangerous
  // even inside an `<img>` tag in some renderers.
  if (/^data:image\/(png|jpe?g|gif|webp|avif);/i.test(src)) return src;

  const fileSegments = filePath.split("/").filter(Boolean);
  // Drop the filename, keep the directory.
  const dirSegments = fileSegments.slice(0, -1);

  let segments: string[];
  if (src.startsWith("/")) {
    segments = src.split("/").filter(Boolean);
  } else {
    const relSegments = src.split("/").filter((s) => s !== "" && s !== ".");
    segments = [...dirSegments];
    for (const seg of relSegments) {
      if (seg === "..") segments.pop();
      else segments.push(seg);
    }
  }

  if (segments.length === 0) return src;
  return `/api/v1/files/${segments.map(encodeURIComponent).join("/")}`;
}

/**
 * Build a markdown-it instance with image src rewriting bound to the given
 * `filePath`. Created per-render so the renderer override closes over the
 * current file's directory; the markdown-it instance itself is cheap.
 */
export function createMarkdownRenderer(filePath: string | undefined) {
  const renderer = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: false,
  });

  const defaultLinkOpen =
    renderer.renderer.rules.link_open ||
    ((tokens, idx, options, _env, self) =>
      self.renderToken(tokens, idx, options));
  renderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const hrefIdx = token.attrIndex("href");
    if (hrefIdx >= 0 && token.attrs) {
      const href = token.attrs[hrefIdx]?.[1] || "";
      if (!/^(https?:|mailto:)/i.test(href)) {
        const attr = token.attrs[hrefIdx];
        if (attr) attr[1] = "";
      }
    }
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  const defaultImage =
    renderer.renderer.rules.image ||
    ((tokens, idx, options, _env, self) =>
      self.renderToken(tokens, idx, options));
  renderer.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const srcIdx = token.attrIndex("src");
    if (srcIdx >= 0 && token.attrs && filePath) {
      const attr = token.attrs[srcIdx];
      if (attr) attr[1] = resolveMarkdownImageSrc(attr[1] || "", filePath);
    }
    return defaultImage(tokens, idx, options, env, self);
  };

  return renderer;
}

function MarkdownView({
  source,
  filePath,
}: {
  source: string;
  filePath?: string;
}) {
  const renderer = createMarkdownRenderer(filePath);
  const html = DOMPurify.sanitize(renderer.render(source), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["style", "onerror", "onload", "onclick"],
  });
  return (
    <div
      className={MARKDOWN_STYLES}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// --- Code (Shiki, lazy-loaded) ---

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".sh": "bash",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".lua": "lua",
  ".sql": "sql",
  ".css": "css",
  ".html": "html",
  ".htm": "html",
  ".svg": "xml",
  ".xml": "xml",
  ".vue": "vue",
  ".svelte": "svelte",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".dockerfile": "dockerfile",
};

function langFor(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot === -1 ? "" : name.slice(dot).toLowerCase();
  return EXT_TO_LANG[ext] ?? "text";
}

function CodeView({ source, name }: { source: string; name: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lang = langFor(name);
        const { codeToHtml } = await import("shiki");
        const out = await codeToHtml(source, {
          lang,
          theme: "github-light",
        });
        if (!cancelled) setHtml(out);
      } catch {
        if (!cancelled) setHtml(null); // fall back to plain pre
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, name]);

  if (html == null) {
    return (
      <pre className="text-xs font-mono bg-gray-50 rounded p-3 overflow-auto max-h-[60vh] whitespace-pre-wrap border border-gray-200">
        {source}
      </pre>
    );
  }
  return (
    <div
      className="text-xs rounded overflow-auto max-h-[60vh] border border-gray-200 [&_pre]:p-3 [&_pre]:m-0 [&_pre]:overflow-auto"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki returns escaped HTML
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// --- Media viewers ---

function ImageView({ url, alt }: { url: string; alt: string }) {
  return (
    <div className="flex items-center justify-center bg-gray-50 rounded border border-gray-200 max-h-[70vh] overflow-auto">
      <img
        src={url}
        alt={alt}
        className="max-w-full max-h-[70vh] object-contain"
      />
    </div>
  );
}

function VideoView({ url }: { url: string }) {
  return (
    <video
      controls
      src={url}
      className="w-full max-h-[70vh] rounded border border-gray-200 bg-black"
    >
      <track kind="captions" />
    </video>
  );
}

function AudioView({ url }: { url: string }) {
  return (
    <div className="flex items-center justify-center p-6 rounded border border-gray-200 bg-gray-50">
      <audio controls src={url} className="w-full">
        <track kind="captions" />
      </audio>
    </div>
  );
}

function PdfView({ url }: { url: string }) {
  // Browser's built-in PDF viewer. No sandbox attribute: Chrome refuses to
  // load its PDF plugin inside a sandboxed iframe. Chrome's PDF viewer
  // already runs PDFs in its own isolated process with PDF JavaScript
  // disabled, so an extra iframe sandbox adds no security and breaks display.
  return (
    <iframe
      src={url}
      title="PDF"
      className="w-full h-[70vh] rounded border border-gray-200 bg-white"
    />
  );
}

// --- Top-level dispatcher ---

interface FilePreviewProps {
  /** File name (used for type detection). */
  name: string;
  /** Raw file size from listing (used for size-limit check). */
  size: number | null | undefined;
  /** URL to the file content (e.g. /api/v1/files/<path>). */
  url: string;
  /**
   * Full path (relative to the user's root) of the file being previewed.
   * Used to resolve relative image references inside markdown previews
   * (`![](attachments/x.jpg)`) against the file's directory.
   */
  fullKey?: string;
  /** Eagerly-fetched text content for code/markdown viewers. */
  textContent: string | null;
  /** True while textContent is being fetched. */
  loading: boolean;
}

export function FilePreview({
  name,
  size,
  url,
  fullKey,
  textContent,
  loading,
}: FilePreviewProps): React.ReactNode {
  const { t } = useTranslation("files");
  const type: PreviewType = getPreviewType(name);
  const overLimit = exceedsPreviewLimit(name, size);

  if (overLimit != null) {
    return (
      <p className="text-sm text-gray-500">
        {t("viewFile.tooLargeForPreview", {
          defaultValue:
            "File is too large to preview ({{limit}}MB max). Download to view.",
          limit: Math.floor(overLimit / 1024 / 1024),
        })}
      </p>
    );
  }

  switch (type) {
    case "image":
      return <ImageView url={url} alt={name} />;
    case "video":
      return <VideoView url={url} />;
    case "audio":
      return <AudioView url={url} />;
    case "pdf":
      return <PdfView url={url} />;
    case "markdown":
      if (loading) {
        return <p className="text-sm text-gray-500">{t("viewFile.loading")}</p>;
      }
      return <MarkdownView source={textContent ?? ""} filePath={fullKey} />;
    case "code":
      if (loading) {
        return <p className="text-sm text-gray-500">{t("viewFile.loading")}</p>;
      }
      return <CodeView source={textContent ?? ""} name={name} />;
    case "none":
      return (
        <p className="text-sm text-gray-500">{t("viewFile.cannotPreview")}</p>
      );
  }
}
