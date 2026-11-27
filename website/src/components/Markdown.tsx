import path from "node:path";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import Link from "next/link";
import { docUrlForSource, listAssets } from "@/lib/content";

export const assetUrl = (rel: string) => "/content/" + rel.split("/").map(encodeURIComponent).join("/");

/** Resolve a relative link/src written in a note (folder `fromDir`) to a repo-relative path. */
function resolveRel(raw: string, fromDir: string): { rel: string; hash: string } | null {
  const href = raw.trim().replace(/^<|>$/g, "");
  if (!href || /^[a-z][a-z0-9+.-]*:|^\/\/|^#/i.test(href)) return null;
  const [p, hash = ""] = href.split("#");
  let decoded = p.split("?")[0];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {}
  const rel = path.posix.normalize(path.posix.join(fromDir || ".", decoded)).replace(/^\.\//, "").replace(/\/$/, "");
  return { rel, hash: hash ? "#" + hash : "" };
}

export default function Markdown({ body, fromDir }: { body: string; fromDir: string }) {
  const assets = new Set(listAssets());
  const components: Components = {
    a({ href = "", children, node, ...rest }) {
      const r = resolveRel(href, fromDir);
      if (!r) {
        const external = /^https?:/i.test(href);
        return (
          <a href={href} {...rest} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
            {children}
          </a>
        );
      }
      if (assets.has(r.rel)) return <a href={assetUrl(r.rel)} target="_blank" rel="noreferrer">{children}</a>;
      const url = docUrlForSource(r.rel || "README.md");
      // a link to a note that doesn't exist renders as plain text, not a 404
      return url ? <Link href={url + r.hash}>{children}</Link> : <span>{children}</span>;
    },
    img({ src, alt, node, ...rest }) {
      const r = typeof src === "string" ? resolveRel(src, fromDir) : null;
      const url = r ? (assets.has(r.rel) ? assetUrl(r.rel) : undefined) : (src as string | undefined);
      if (!url) return null;
      // eslint-disable-next-line @next/next/no-img-element
      return <img {...rest} src={url} alt={alt ?? ""} loading="lazy" />;
    },
    table({ node, ...props }) {
      return (
        <div className="overflow-x-auto">
          <table {...props} />
        </div>
      );
    },
  };
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]} components={components}>
      {body}
    </ReactMarkdown>
  );
}
