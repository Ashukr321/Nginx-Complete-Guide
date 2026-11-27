"use client";

import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import type { NavCategory } from "@/lib/nav";

/** Every typed word must appear (cmdk's fuzzy default makes "cors" match unrelated titles). */
export function allWordsFilter(value: string, search: string, keywords?: string[]) {
  const hay = [value, ...(keywords ?? [])].join(" ").toLowerCase();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => hay.includes(w)) ? 1 : 0;
}

export default function SearchPalette({
  nav,
  open,
  onOpenChange,
}: {
  nav: NavCategory[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const router = useRouter();
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search topics"
      filter={allWordsFilter}
      overlayClassName="fixed inset-0 z-50 bg-black/60"
      contentClassName="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-panel text-foreground shadow-2xl"
    >
      <Command.Input
        placeholder="Search topics…"
        className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted"
      />
      <Command.List className="max-h-[60vh] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted">No topics found.</Command.Empty>
        {nav.map((c) => (
          <Command.Group
            key={c.slug}
            heading={c.title}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted"
          >
            {c.docs.map((d) => (
              <Command.Item
                key={d.slug}
                value={d.slug}
                keywords={[d.title, d.group ?? "", c.title]}
                onSelect={() => {
                  onOpenChange(false);
                  router.push(`/docs/${d.slug}`);
                }}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm"
              >
                <FileText className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{d.title}</span>
                {d.group && <span className="shrink-0 text-xs text-muted">{d.group}</span>}
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
