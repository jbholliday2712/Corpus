import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Corpus Review",
  description: "Local review UI for the Corpus manual ingestion pipeline",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-50 text-gray-900 antialiased">
        <header className="border-b border-gray-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-8 py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight text-gray-900">
              Corpus
            </Link>
            <nav className="flex gap-4 text-sm">
              <Link href="/" className="text-gray-600 transition-colors hover:text-gray-900">
                Queue
              </Link>
              <Link href="/graph" className="text-gray-600 transition-colors hover:text-gray-900">
                Graph
              </Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
