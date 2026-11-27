import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import Markdown, { assetUrl } from "@/components/Markdown";
import { LANGS, getAllDocs, getDoc, sourceDir } from "@/lib/content";
import { SITE } from "@/lib/site";

export const dynamicParams = false;

export function generateStaticParams() {
  return getAllDocs().map((d) => ({ slug: d.slug.split("/") }));
}

type Props = { params: Promise<{ slug: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const doc = getDoc((await params).slug.join("/"));
  if (!doc) return {};
  const url = `/docs/${doc.slug}`;
  return {
    title: `${doc.title} — ${doc.category}`,
    description: doc.description,
    alternates: { canonical: url },
    openGraph: { type: "article", title: doc.title, description: doc.description, url, siteName: SITE.name },
  };
}

const caption = (rel: string) =>
  rel
    .split("/")
    .pop()!
    .replace(/\.[^.]+$/, "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s*\(\d+\)$/, "")
    .trim();

export default async function DocPage({ params }: Props) {
  const slug = (await params).slug.join("/");
  const doc = getDoc(slug);
  if (!doc) notFound();
  const all = getAllDocs();
  const i = all.indexOf(doc);
  const prev = all[i - 1];
  const next = all[i + 1];
  const dir = sourceDir(doc);
  const langs = LANGS.filter((l) => doc.variants.some((v) => v.lang === l.id));
  const empty = doc.variants.every((v) => !v.body.trim()) && !doc.images.length && !doc.visualizations.length;

  return (
    <article className="mx-auto max-w-5xl px-4 py-8 sm:px-8">
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-sm text-muted">
        <Link href="/" className="hover:text-foreground">
          {SITE.name}
        </Link>
        <ChevronRight className="size-3.5" />
        <span>{doc.category}</span>
        {doc.group && (
          <>
            <ChevronRight className="size-3.5" />
            <span>{doc.group}</span>
          </>
        )}
        <ChevronRight className="size-3.5" />
        <span className="text-foreground">{doc.title}</span>
      </nav>
      <h1 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">{doc.title}</h1>

      <div className="prose prose-neutral dark:prose-invert mt-6 max-w-none prose-pre:overflow-x-auto prose-table:text-sm">
        {empty && <p className="text-muted italic">This topic is still being written.</p>}
        <p className="lang-note not-prose rounded-lg border border-border bg-panel px-4 py-2 text-sm text-muted" data-missing={LANGS.filter((l) => !langs.includes(l)).map((l) => l.id).join(" ")}>
          This page is available in English only.
        </p>
        <div className="variants" data-langs={langs.map((l) => l.id).join(" ")}>
          {doc.variants.map((v) => (
            <div key={v.lang} className="variant" data-lang={v.lang} lang={v.lang === "hi" ? "hi" : "en"}>
              <Markdown body={v.body} fromDir={dir} />
            </div>
          ))}
        </div>

        {doc.images.map((img) => (
          <figure key={img}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={assetUrl(img)} alt={caption(img)} loading="lazy" />
            <figcaption>{caption(img)}</figcaption>
          </figure>
        ))}

        {doc.visualizations.map((v) => (
          <figure key={v} className="not-prose my-8">
            <iframe
              src={assetUrl(v)}
              sandbox="allow-scripts"
              title={caption(v)}
              className="h-[480px] w-full rounded-lg border border-border bg-white"
            />
            <figcaption className="mt-2 flex items-center justify-between text-sm text-muted">
              {caption(v)}
              <a href={assetUrl(v)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent">
                Open full screen <ExternalLink className="size-3.5" />
              </a>
            </figcaption>
          </figure>
        ))}
      </div>

      <div className="mt-12 grid gap-4 border-t border-border pt-6 sm:grid-cols-2">
        {prev ? (
          <Link href={`/docs/${prev.slug}`} className="rounded-xl border border-border p-4 hover:border-accent">
            <span className="flex items-center gap-1 text-xs text-muted">
              <ChevronLeft className="size-3.5" /> Previous
            </span>
            <span className="mt-1 block font-medium">{prev.title}</span>
          </Link>
        ) : (
          <span />
        )}
        {next && (
          <Link href={`/docs/${next.slug}`} className="rounded-xl border border-border p-4 text-right hover:border-accent">
            <span className="flex items-center justify-end gap-1 text-xs text-muted">
              Next <ChevronRight className="size-3.5" />
            </span>
            <span className="mt-1 block font-medium">{next.title}</span>
          </Link>
        )}
      </div>
    </article>
  );
}
