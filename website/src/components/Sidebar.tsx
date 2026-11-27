"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { NavCategory } from "@/lib/nav";

function CategoryItem({ cat, current, onNavigate }: { cat: NavCategory; current: string; onNavigate?: () => void }) {
  const isActive = cat.docs.some((d) => d.slug === current);
  const [toggled, setToggled] = useState<boolean | undefined>(undefined);
  const open = toggled ?? isActive;

  return (
    <li>
      <button
        onClick={() => setToggled(!open)}
        aria-expanded={open}
        className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-foreground/5 ${
          isActive ? "text-foreground" : "text-foreground/80"
        }`}
      >
        <span>{cat.title}</span>
        <ChevronRight className={`size-4 shrink-0 text-muted transition-transform duration-300 ${open ? "rotate-90" : ""}`} />
      </button>
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-300 ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <ul className="overflow-hidden" inert={!open}>
          {cat.docs.map((d, i) => {
            const showGroup = d.group && d.group !== cat.docs[i - 1]?.group;
            const active = d.slug === current;
            return (
              <li key={d.slug}>
                {showGroup && (
                  <p className="mt-2 ml-3 px-2 text-[11px] font-semibold tracking-wider text-muted uppercase">{d.group}</p>
                )}
                <Link
                  href={`/docs/${d.slug}`}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={`ml-3 block border-l px-3 py-1 text-sm ${
                    active
                      ? "border-accent font-medium text-accent"
                      : "border-border text-muted hover:border-foreground/40 hover:text-foreground"
                  }`}
                >
                  {d.title}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </li>
  );
}

export default function Sidebar({ nav, onNavigate }: { nav: NavCategory[]; onNavigate?: () => void }) {
  const pathname = usePathname();
  const current = decodeURIComponent(pathname.replace(/^\/docs\//, "").replace(/\/$/, ""));
  return (
    <nav className="flex-1 overflow-y-auto p-3">
      <ul className="space-y-1">
        {nav.map((c) => (
          <CategoryItem key={c.slug} cat={c} current={current} onNavigate={onNavigate} />
        ))}
      </ul>
    </nav>
  );
}
