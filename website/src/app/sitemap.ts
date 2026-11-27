import type { MetadataRoute } from "next";
import { getAllDocs } from "@/lib/content";
import { SITE } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = SITE.url.replace(/\/$/, "");
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    ...getAllDocs().map((d) => ({ url: `${base}/docs/${d.slug}`, changeFrequency: "monthly" as const, priority: 0.7 })),
  ];
}
