import fs from "node:fs";
import path from "node:path";

/** Notes live one level above `website/`. Every page is prerendered, so this only runs at build time. */
export const CONTENT_ROOT = path.resolve(
  /*turbopackIgnore: true*/ process.env.CONTENT_DIR ??
    path.join(/*turbopackIgnore: true*/ process.cwd(), ".."),
);

export const SKIP_DIRS = new Set(["website", "node_modules", ".git", ".claude", ".next", ".vercel"]);
export const ASSET_EXT = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".html", ".pdf"]);
const IMAGE_EXT = new Set([".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** Folders scanned for numbered category folders (`01_Intro`, `02-intermediate`). */
const CATEGORY_ROOTS: { dir: string; prefix: string }[] = [
  { dir: "", prefix: "" },
  { dir: "interview-questions", prefix: "Interview: " },
];

/** Unrelated images that should never be auto-placed on a page. */
export const IGNORED_IMAGES: string[] = [];

export const LANGS = [
  { id: "en", label: "English", suffix: "" },
  { id: "hinglish", label: "Hinglish", suffix: ".hinglish" },
  { id: "hi", label: "हिन्दी", suffix: ".hi" },
] as const;
export type LangId = (typeof LANGS)[number]["id"];

const ACRONYMS = [
  "API", "APIs", "SSL", "TLS", "HTTP", "HTTPS", "CDN", "SPA", "MERN", "URL", "DNS",
  "IP", "L4", "L7", "C10K", "TCP", "JS", "CSS", "HTML", "PDF", "SEO", "HA",
];
const ACRONYM_MAP = new Map<string, string>([...ACRONYMS.map((a) => [a.toLowerCase(), a] as [string, string]), ["nodejs", "Node.js"]]);
const MINOR = new Set(["vs", "and", "of", "in", "on", "the", "a", "to", "for", "with", "or"]);

export type Variant = { lang: LangId; body: string };
export type Doc = {
  slug: string;
  title: string;
  description: string;
  category: string;
  categorySlug: string;
  group?: string;
  /** repo-relative path of the source file (or folder for image-only pages) */
  source: string;
  /** English first; extra languages only when a variant file exists */
  variants: Variant[];
  /** repo-relative image paths placed on the page (not linked in the body) */
  images: string[];
  /** repo-relative .html visualizations */
  visualizations: string[];
};
export type Category = { slug: string; title: string; docs: Doc[] };

const toPosix = (p: string) => p.split(path.sep).join("/");
const stripNum = (name: string) => name.replace(/^\d+[_\-. ]+/, "");
const slugify = (s: string) =>
  stripNum(s)
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function humanize(name: string): string {
  return stripNum(name.replace(/\.md$/i, ""))
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((w, i) =>
      ACRONYM_MAP.get(w.toLowerCase()) ?? (i > 0 && MINOR.has(w.toLowerCase()) ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1)),
    )
    .join(" ");
}

const abs = (rel: string) => path.join(/*turbopackIgnore: true*/ CONTENT_ROOT, rel);
const readDir = (rel: string) =>
  fs
    .readdirSync(/*turbopackIgnore: true*/ abs(rel), { withFileTypes: true })
    .filter((d) => !d.name.startsWith(".") && !SKIP_DIRS.has(d.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));

const isVariantFile = (name: string) => /\.(hinglish|hi)\.md$/i.test(name);
const isReadme = (name: string) => name.toLowerCase() === "readme.md";

function splitTitle(md: string): { h1?: string; body: string } {
  const m = md.match(/^\s*# +(.+?)\s*#*\s*$/m);
  if (!m || m.index === undefined) return { body: md };
  // only treat it as the title if nothing but blank lines / images / front-matter-ish noise precedes it
  // "Q: …" interview headings and leading emoji are noise in a sidebar title
  const h1 = m[1].trim().replace(/^Q:\s*/, "").replace(/^\p{Extended_Pictographic}️?\s*/u, "");
  return { h1, body: md.slice(0, m.index) + md.slice(m.index + m[0].length) };
}

function describe(md: string): string {
  const withoutCode = md.replace(/```[\s\S]*?```/g, "");
  for (const block of withoutCode.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || /^(#|!\[|<|>|\||-{3}|[-*+] |\d+\. |title:|subtitle:)/.test(t)) continue;
    const plain = t
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain.length < 20) continue;
    return plain.length <= 160 ? plain : plain.slice(0, 157).replace(/\s+\S*$/, "") + "…";
  }
  return "";
}

/** Images referenced from a markdown body, as repo-relative paths. */
export function linkedImages(md: string, fromDir: string): string[] {
  const out: string[] = [];
  const add = (raw: string) => {
    let p = raw.trim().replace(/^<|>$/g, "");
    if (/^[a-z]+:|^\/\//i.test(p) || p.startsWith("#")) return;
    p = p.split(/[?#]/)[0];
    try {
      p = decodeURIComponent(p);
    } catch {}
    const rel = toPosix(path.posix.normalize(path.posix.join(fromDir, p)));
    if (IMAGE_EXT.has(path.extname(rel).toLowerCase())) out.push(rel);
  };
  for (const m of md.matchAll(/!\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g)) add(m[1]);
  for (const m of md.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  return out;
}

type RawDoc = Omit<Doc, "description" | "images" | "visualizations"> & { dir: string };

function loadVariants(relFile: string): { title?: string; variants: Variant[] } {
  const base = relFile.replace(/\.md$/i, "");
  let title: string | undefined;
  const variants: Variant[] = [];
  for (const l of LANGS) {
    const file = base + l.suffix + ".md";
    if (!fs.existsSync(/*turbopackIgnore: true*/ abs(file))) continue;
    const raw = fs.readFileSync(/*turbopackIgnore: true*/ abs(file), "utf8");
    const { h1, body } = splitTitle(raw);
    if (l.id === "en") {
      if (h1 && h1.length <= 60) {
        title = h1;
        variants.push({ lang: l.id, body });
      } else variants.push({ lang: l.id, body: raw });
    } else variants.push({ lang: l.id, body: h1 && h1.length <= 60 ? body : raw });
  }
  return { title, variants };
}

function walkCategory(
  relDir: string,
  categorySlug: string,
  category: string,
  out: RawDoc[],
  group?: string,
  groupSlugPath = "",
) {
  const entries = readDir(relDir);
  const files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md") && !isVariantFile(e.name));
  const readme = files.find((f) => isReadme(f.name));
  const ordered = [...(readme ? [readme] : []), ...files.filter((f) => f !== readme)];
  for (const f of ordered) {
    const rel = toPosix(path.posix.join(relDir, f.name));
    const folderName = path.posix.basename(relDir);
    const name = f.name.toLowerCase();
    const slug = [categorySlug, groupSlugPath, isReadme(f.name) ? "" : slugify(f.name)].filter(Boolean).join("/");
    const { title, variants } = loadVariants(rel);
    const folderTitle = groupSlugPath ? humanize(folderName) : category;
    out.push({
      slug: isReadme(f.name) && !groupSlugPath ? `${categorySlug}/overview` : slug,
      title: isReadme(f.name) || name === "concept.md" ? folderTitle : (title ?? humanize(f.name)),
      category,
      categorySlug,
      group,
      source: rel,
      dir: relDir,
      variants,
    });
  }
  for (const d of entries.filter((e) => e.isDirectory())) {
    const sub = toPosix(path.posix.join(relDir, d.name));
    const before = out.length;
    walkCategory(sub, categorySlug, category, out, humanize(d.name), [groupSlugPath, slugify(d.name)].filter(Boolean).join("/"));
    // folder with images but no markdown → its own page so its diagrams still show
    if (out.length === before && hasOwnImages(sub)) {
      out.push({
        slug: [categorySlug, groupSlugPath, slugify(d.name)].filter(Boolean).join("/"),
        title: humanize(d.name),
        category,
        categorySlug,
        group: group ?? humanize(d.name),
        source: sub,
        dir: sub,
        variants: [{ lang: "en", body: "" }],
      });
    }
  }
}

const hasOwnImages = (relDir: string) =>
  readDir(relDir).some((e) => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()));

/** Every servable asset in the repo, repo-relative. */
export function listAssets(relDir = ""): string[] {
  const out: string[] = [];
  for (const e of readDir(relDir)) {
    const rel = toPosix(path.posix.join(relDir, e.name));
    if (e.isDirectory()) out.push(...listAssets(rel));
    else if (ASSET_EXT.has(path.extname(e.name).toLowerCase())) out.push(rel);
  }
  return out;
}

const words = (name: string) =>
  path
    .basename(name, path.extname(name))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !/^\d+$/.test(w));

function build(): Category[] {
  const categories: Category[] = [];
  const raw: RawDoc[] = [];
  const looseByRoot = new Map<string, string[]>();

  for (const root of CATEGORY_ROOTS) {
    if (!fs.existsSync(/*turbopackIgnore: true*/ abs(root.dir || "."))) continue;
    const entries = readDir(root.dir);
    looseByRoot.set(
      root.dir,
      entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md") && !isVariantFile(e.name)).map((e) => e.name),
    );
    for (const d of entries.filter((e) => e.isDirectory() && /^\d+[_\-.]/.test(e.name))) {
      const title = root.prefix + humanize(d.name);
      const slug = slugify(root.prefix + stripNum(d.name));
      const cat: Category = { slug, title, docs: [] };
      const rel = toPosix(path.posix.join(root.dir, d.name));
      const docs: RawDoc[] = [];
      walkCategory(rel, slug, title, docs);
      if (!docs.length) continue;
      // README / loose .md files of the category root go into its first category
      const loose = looseByRoot.get(root.dir) ?? [];
      looseByRoot.delete(root.dir); // only the root's first category takes them
      if (loose.length) {
        const extra: RawDoc[] = [];
        for (const name of loose) {
          const relFile = root.dir ? `${root.dir}/${name}` : name;
          const { title: h1, variants } = loadVariants(relFile);
          const readme = isReadme(name);
          extra.push({
            slug: `${slug}/${readme ? (root.dir ? "overview-" + slugify(root.dir) : "overview") : slugify(name)}`,
            title: readme ? (root.dir ? humanize(root.dir) : "Overview") : (h1 ?? humanize(name)),
            category: title,
            categorySlug: slug,
            source: relFile,
            dir: root.dir,
            variants,
          });
        }
        const readmes = extra.filter((e) => isReadme(path.posix.basename(e.source)));
        const rest = extra.filter((e) => !readmes.includes(e));
        // root README first, other loose files after the category's own docs
        docs.unshift(...readmes);
        docs.push(...rest);
      }
      raw.push(...docs);
      cat.docs = docs as unknown as Doc[];
      categories.push(cat);
    }
  }

  // ---- images ----
  const allImages = listAssets().filter((a) => IMAGE_EXT.has(path.extname(a).toLowerCase()) && !IGNORED_IMAGES.includes(a));
  const linked = new Map<RawDoc, Set<string>>();
  const everLinked = new Set<string>();
  for (const d of raw) {
    const s = new Set(d.variants.flatMap((v) => linkedImages(v.body, d.dir)));
    linked.set(d, s);
    s.forEach((i) => everLinked.add(i));
  }
  const placed = new Map<RawDoc, string[]>(raw.map((d) => [d, []]));
  for (const img of allImages) {
    const iw = words(img);
    // file-name match: every word of the image name is in the doc's file name
    for (const d of raw) {
      const dw = new Set(words(d.source));
      if (iw.length && iw.every((w) => dw.has(w)) && !linked.get(d)!.has(img)) placed.get(d)!.push(img);
    }
    if (everLinked.has(img) || [...placed.values()].some((l) => l.includes(img))) continue;
    // unlinked: nearest doc in its folder, else nearest parent (README preferred)
    let dir = path.posix.dirname(img);
    for (;;) {
      const here = raw.filter((d) => d.dir === (dir === "." ? "" : dir));
      if (here.length) {
        const target = here.find((d) => isReadme(path.posix.basename(d.source))) ?? here[0];
        placed.get(target)!.push(img);
        break;
      }
      if (dir === "." || dir === "") break;
      dir = path.posix.dirname(dir);
    }
  }

  const htmlFiles = listAssets().filter((a) => a.endsWith(".html"));
  for (const d of raw) {
    const doc = d as unknown as Doc;
    doc.images = placed.get(d)!;
    doc.visualizations = isReadme(path.posix.basename(d.source))
      ? htmlFiles.filter((h) => path.posix.dirname(h) === (d.dir || "."))
      : [];
    doc.description = describe(d.variants[0]?.body ?? "") || `${d.title} — ${d.category}`;
    delete (doc as Partial<RawDoc>).dir;
  }
  return categories;
}

let cache: Category[] | undefined;
export function getCategories(): Category[] {
  return (cache ??= build());
}
export function getAllDocs(): Doc[] {
  return getCategories().flatMap((c) => c.docs);
}
export function getDoc(slug: string): Doc | undefined {
  return getAllDocs().find((d) => d.slug === slug);
}

/** Map a repo-relative .md path (any language variant) to its doc URL. */
export function docUrlForSource(rel: string): string | undefined {
  const base = rel.replace(/\.(hinglish|hi)\.md$/i, ".md");
  const doc = getAllDocs().find((d) => d.source === base);
  if (doc) return `/docs/${doc.slug}`;
  // a link to a folder → its README page
  const asDir = getAllDocs().find((d) => d.source === `${rel.replace(/\/$/, "")}/README.md`);
  return asDir ? `/docs/${asDir.slug}` : undefined;
}

export function sourceDir(doc: Doc): string {
  return doc.source.endsWith(".md") ? path.posix.dirname(doc.source).replace(/^\.$/, "") : doc.source;
}
