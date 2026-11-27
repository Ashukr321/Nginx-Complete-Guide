"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-8 text-center">
        <p className="text-sm font-semibold tracking-[0.2em] text-red-500 uppercase">Error</p>
        <h1 className="mt-3 text-2xl font-bold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">Please try again or return to the home page.</p>
        <div className="mt-5 flex justify-center gap-2">
          <button onClick={reset} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-foreground/5">
            Try again
          </button>
          <Link href="/" className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90">
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}
