"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Menu, Moon, PanelLeft, Search, Sun, X } from "lucide-react";
import Sidebar from "./Sidebar";
import SearchPalette from "./SearchPalette";
import LangTabs from "./LangTabs";
import type { NavCategory } from "@/lib/nav";

const noop = () => () => {};
const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

export default function Shell({
  nav,
  siteName,
  children,
}: {
  nav: NavCategory[];
  siteName: string;
  children: React.ReactNode;
}) {
  const [desktopOpen, setDesktopOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const mod = useSyncExternalStore(noop, () => (isMac() ? "⌘" : "Ctrl"), () => "Ctrl");

  const toggleSidebar = useCallback(() => {
    if (window.matchMedia("(min-width: 1024px)").matches) setDesktopOpen((o) => !o);
    else setMobileOpen((o) => !o);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.code === "KeyK") {
        e.preventDefault();
        setSearchOpen(true);
      } else if (mod && e.code === "KeyB") {
        e.preventDefault();
        toggleSidebar();
      } else if (!mod && !e.altKey && e.code === "Slash" && !isTyping(e.target)) {
        e.preventDefault();
        if (e.shiftKey) toggleSidebar();
        else setSearchOpen(true);
      } else if (e.key === "Escape") {
        setMobileOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  const toggleTheme = () => {
    const dark = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch {}
  };

  const brand = (
    <Link href="/" className="flex items-center gap-2 font-semibold" onClick={() => setMobileOpen(false)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icon.svg" alt="" className="size-7" />
      <span className="truncate">{siteName}</span>
    </Link>
  );

  return (
    <div className="flex min-h-screen">
      {/* desktop sidebar: width animates, inner wrapper keeps a fixed width so content doesn't reflow */}
      <aside
        aria-label="Topics"
        className={`sticky top-0 hidden h-screen shrink-0 overflow-hidden border-r border-border bg-panel transition-[width,visibility] duration-300 lg:block ${
          desktopOpen ? "visible w-64" : "invisible w-0"
        }`}
      >
        <div className="flex h-full w-64 flex-col">
          <div className="flex h-14 items-center border-b border-border px-4">{brand}</div>
          <Sidebar nav={nav} />
        </div>
      </aside>

      {/* mobile drawer */}
      <div
        className={`fixed inset-0 z-40 bg-black/60 transition-opacity duration-300 lg:hidden ${
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setMobileOpen(false)}
        aria-hidden
      />
      <aside
        aria-label="Topics"
        inert={!mobileOpen}
        className={`fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-panel transition-transform duration-300 lg:hidden ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-14 items-center justify-between border-b border-border px-4">
          {brand}
          <button aria-label="Close menu" className="rounded-md p-1.5 hover:bg-foreground/10" onClick={() => setMobileOpen(false)}>
            <X className="size-5" />
          </button>
        </div>
        <Sidebar nav={nav} onNavigate={() => setMobileOpen(false)} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 sm:gap-3 border-b border-border bg-background/80 px-4 backdrop-blur">
          <button
            aria-label="Toggle sidebar"
            title={`Toggle sidebar (${mod} B)`}
            className="rounded-md p-1.5 text-muted hover:bg-foreground/10 hover:text-foreground"
            onClick={toggleSidebar}
          >
            <PanelLeft className="hidden size-5 lg:block" />
            <Menu className="size-5 lg:hidden" />
          </button>
          <button
            onClick={() => setSearchOpen(true)}
            className="flex min-w-0 flex-1 items-center gap-2 sm:max-w-xs rounded-lg border border-border bg-panel px-3 py-1.5 text-sm text-muted hover:border-foreground/30"
          >
            <Search className="size-4" />
            <span className="flex-1 truncate text-left">Search<span className="hidden sm:inline"> topics…</span></span>
            <kbd className="hidden rounded border border-border px-1.5 font-mono text-[11px] sm:inline">{mod} K</kbd>
          </button>
          <div className="hidden flex-1 sm:block" />
          <LangTabs />
          <button aria-label="Toggle theme" onClick={toggleTheme} className="rounded-md p-1.5 text-muted hover:bg-foreground/10 hover:text-foreground">
            <Sun className="hidden size-5 dark:block" />
            <Moon className="size-5 dark:hidden" />
          </button>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      <SearchPalette nav={nav} open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}
