import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getAllDocs, getDoc, listAssets, docUrlForSource, linkedImages, sourceDir, IGNORED_IMAGES } from "@/lib/content";

const IMG = /\.(svg|png|jpe?g|webp|gif)$/i;

describe("content loader (real notes)", () => {
  const docs = getAllDocs();

  it("has unique, URL-safe slugs and a title for every doc", () => {
    const slugs = docs.map((d) => d.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const d of docs) {
      expect(d.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/);
      expect(d.title.trim()).not.toBe("");
    }
  });

  it("puts Fundamentals first with intro, what/why and proxy docs in 3 languages", () => {
    expect(docs[0].categorySlug).toBe("fundamentals");
    for (const s of ["introduction", "what-is-nginx-and-why", "forward-proxy-vs-reverse-proxy"]) {
      const d = getDoc(`fundamentals/${s}`);
      expect(d?.variants.map((v) => v.lang)).toEqual(["en", "hinglish", "hi"]);
    }
  });

  it("has the real-project deployment track (AWS EC2 + Node.js) in 3 languages", () => {
    const track = docs.filter((d) => d.categorySlug === "real-project-deployment");
    expect(track.length).toBeGreaterThanOrEqual(7);
    for (const d of track) expect(d.variants.map((v) => v.lang)).toEqual(["en", "hinglish", "hi"]);
  });

  it("maps a README to its folder URL and returns undefined for a missing file", () => {
    expect(docUrlForSource("interview-questions/README.md")).toBeDefined();
    expect(docUrlForSource("interview-questions")).toBe(docUrlForSource("interview-questions/README.md"));
    expect(docUrlForSource("README.md")).toBe("/docs/fundamentals/overview");
    expect(getDoc("no/such/doc")).toBeUndefined();
    expect(docUrlForSource("nope/missing.md")).toBeUndefined();
  });

  it("titles no doc 'Concept'", () => {
    expect(docs.some((d) => d.title === "Concept")).toBe(false);
  });

  it("shows every repo image on at least one page", () => {
    const shown = new Set<string>();
    for (const d of docs) {
      d.images.forEach((i) => shown.add(i));
      d.variants.forEach((v) => linkedImages(v.body, sourceDir(d)).forEach((i) => shown.add(i)));
    }
    const missing = listAssets().filter((a) => IMG.test(a) && !IGNORED_IMAGES.includes(a) && !shown.has(a));
    expect(missing).toEqual([]);
  });

  it("gives an image-only folder its own page", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-"));
    fs.mkdirSync(path.join(root, "01_Intro", "diagrams"), { recursive: true });
    fs.writeFileSync(path.join(root, "01_Intro", "a.md"), "# A\n\nHello there, this is a note.");
    fs.writeFileSync(path.join(root, "01_Intro", "diagrams", "flow.svg"), "<svg/>");
    const prev = process.env.CONTENT_DIR;
    process.env.CONTENT_DIR = root;
    const { vi } = await import("vitest");
    vi.resetModules();
    const fresh = await import("@/lib/content");
    const page = fresh.getDoc("intro/diagrams");
    expect(page?.images).toEqual(["01_Intro/diagrams/flow.svg"]);
    process.env.CONTENT_DIR = prev;
    vi.resetModules();
  });

  it("never serves files from website/, .git or .claude", () => {
    expect(listAssets().filter((a) => /^(website|\.git|\.claude)\//.test(a))).toEqual([]);
  });
});
