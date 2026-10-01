import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Fireplace — Ambient Fireplace",
    short_name: "Fireplace",
    description: "Realistic virtual fireplace with ambient sound to leave on in the background.",
    start_url: "/",
    display: "fullscreen",
    orientation: "any",
    background_color: "#000000",
    theme_color: "#000000",
    lang: "es",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
