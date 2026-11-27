import Shell from "@/components/Shell";
import { getCategories } from "@/lib/content";
import type { NavCategory } from "@/lib/nav";
import { SITE } from "@/lib/site";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const nav: NavCategory[] = getCategories().map((c) => ({
    slug: c.slug,
    title: c.title,
    docs: c.docs.map((d) => ({ slug: d.slug, title: d.title, group: d.group })),
  }));
  return (
    <Shell nav={nav} siteName={SITE.name}>
      {children}
    </Shell>
  );
}
