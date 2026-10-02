import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "./auth-provider";
export const metadata: Metadata = {
  title: "Research Agent MAX",
  description: "Evidence-first research across the web.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
