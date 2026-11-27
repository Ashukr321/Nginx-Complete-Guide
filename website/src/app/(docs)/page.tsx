import Link from "next/link";
import { ArrowRight, Languages } from "lucide-react";
import { getAllDocs, getCategories } from "@/lib/content";
import { SITE } from "@/lib/site";

export default function Home() {
  const categories = getCategories();
  const docs = getAllDocs();
  const first = docs.find((d) => d.slug === "fundamentals/introduction") ?? docs[0];
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-8 sm:py-16">
      <span className="inline-flex rounded-full border border-border bg-panel px-3 py-1 text-xs text-muted">
        {docs.length} topics · {categories.length} categories
      </span>
      <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-6xl">{SITE.name}</h1>
      <p className="mt-5 max-w-2xl text-lg text-muted">{SITE.description}</p>
      <p className="mt-3 inline-flex items-center gap-2 text-sm text-muted">
        <Languages className="size-4 text-accent" /> Fundamentals, scenarios and deployment: English · Hinglish · हिन्दी (switch in the top bar)
      </p>
      <div className="mt-8">
        <Link
          href={`/docs/${first.slug}`}
          className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
        >
          Start reading <ArrowRight className="size-4" />
        </Link>
      </div>

      <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((c) => (
          <section key={c.slug} className="rounded-xl border border-border bg-panel p-5">
            <h2 className="font-semibold">
              <Link href={`/docs/${c.docs[0].slug}`} className="hover:text-accent">
                {c.title}
              </Link>
            </h2>
            <ul className="mt-3 space-y-1.5 text-sm">
              {c.docs.slice(0, 6).map((d) => (
                <li key={d.slug}>
                  <Link href={`/docs/${d.slug}`} className="text-muted hover:text-foreground">
                    {d.title}
                  </Link>
                </li>
              ))}
              {c.docs.length > 6 && <li className="text-xs text-muted">+{c.docs.length - 6} more</li>}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
