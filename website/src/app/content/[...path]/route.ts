import fs from "node:fs";
import path from "node:path";
import { CONTENT_ROOT, listAssets } from "@/lib/content";

export const dynamicParams = false;

export function generateStaticParams() {
  return listAssets().map((a) => ({ path: a.split("/") }));
}

const TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
};

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const segs = (await ctx.params).path.map((s) => decodeURIComponent(s));
  const rel = segs.join("/");
  // dynamicParams=false already limits this to listed files; keep the check as a second guard
  if (!listAssets().includes(rel)) return new Response("Not found", { status: 404 });
  const file = fs.readFileSync(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ CONTENT_ROOT, rel));
  return new Response(new Uint8Array(file), {
    headers: {
      "Content-Type": TYPES[path.extname(rel).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
