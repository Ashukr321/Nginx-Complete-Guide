"use client";

import { useSyncExternalStore } from "react";

const LANGS = [
  { id: "en", label: "EN", full: "English" },
  { id: "hinglish", label: "Hinglish", full: "Hinglish" },
  { id: "hi", label: "हिन्दी", full: "Hindi" },
];

const EVENT = "langchange";
const subscribe = (cb: () => void) => {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
};
const read = () => document.documentElement.dataset.lang || "en";
function setLang(id: string) {
  document.documentElement.dataset.lang = id;
  try {
    localStorage.setItem("lang", id);
  } catch {}
  window.dispatchEvent(new Event(EVENT));
}

/** Global reading language (html[data-lang], remembered). CSS shows the matching variant; pages without it stay English. */
export default function LangTabs() {
  const current = useSyncExternalStore(subscribe, read, () => "en");
  return (
    <div role="tablist" aria-label="Explanation language" className="flex shrink-0 items-center rounded-lg border border-border bg-panel p-0.5 text-xs">
      {LANGS.map((l) => (
        <button
          key={l.id}
          role="tab"
          title={l.full}
          aria-selected={current === l.id}
          onClick={() => setLang(l.id)}
          className={`rounded-md px-2 py-1 whitespace-nowrap ${
            current === l.id ? "bg-accent font-medium text-white dark:text-black" : "text-muted hover:text-foreground"
          }`}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
