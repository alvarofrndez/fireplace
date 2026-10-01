import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.scss";

export const metadata: Metadata = {
  title: "Fireplace — Ambient Fireplace",
  description:
    "Una chimenea virtual realista para dejar encendida de fondo: fuego simulado en tiempo real y el crepitar de la leña.",
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
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
