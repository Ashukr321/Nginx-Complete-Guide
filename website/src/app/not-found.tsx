import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-8 text-center">
        <p className="text-sm font-semibold tracking-[0.2em] text-accent uppercase">404</p>
        <h1 className="mt-3 text-2xl font-bold">Page not found</h1>
        <p className="mt-2 text-sm text-muted">This topic doesn&apos;t exist (yet). Try the search on the home page.</p>
        <Link href="/" className="mt-5 inline-flex rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90">
          Go home
        </Link>
      </div>
    </main>
  );
}
