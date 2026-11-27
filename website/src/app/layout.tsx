import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import SwRegister from "@/components/SwRegister";
import { SITE } from "@/lib/site";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: { default: SITE.name, template: `%s | ${SITE.name}` },
  description: SITE.description,
  applicationName: SITE.name,
  keywords: [
    "nginx", "reverse proxy", "forward proxy", "load balancing", "ssl termination", "nginx tutorial",
    "nginx interview questions", "devops", "nginx hindi", "nginx hinglish",
  ],
  openGraph: { type: "website", siteName: SITE.name, title: SITE.name, description: SITE.description, url: "/" },
  twitter: { card: "summary", title: SITE.name, description: SITE.description },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: SITE.shortName },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

// Runs before paint: dark by default, plus the saved reading language.
const bootScript = `try{var t=localStorage.getItem("theme");document.documentElement.classList.toggle("dark",t!=="light");var l=localStorage.getItem("lang");if(l)document.documentElement.dataset.lang=l}catch(e){document.documentElement.classList.add("dark")}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}>
      <body className="min-h-full font-sans">
        <Script id="boot" strategy="beforeInteractive">
          {bootScript}
        </Script>
        {children}
        <SwRegister />
      </body>
    </html>
  );
}
