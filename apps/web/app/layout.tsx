import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Research Agent MAX",
  description: "Evidence-first research across the web.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
