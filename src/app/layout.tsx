import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Analytics } from "@vercel/analytics/next"
import "./globals.scss";

export const metadata: Metadata = {
  title: "Fireplace — Ambient Fireplace",
  description:
    "A realistic virtual fireplace to leave on in the background: real-time simulated fire and the crackling of logs.",
  applicationName: "Fireplace",
  appleWebApp: {
    capable: true,
    title: "Fireplace",
    statusBarStyle: "black-translucent",
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
      <Analytics/>
    </html>
  );
}
