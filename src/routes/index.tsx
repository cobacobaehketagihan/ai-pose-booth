import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";

const Photobooth = lazy(() => import("@/components/Photobooth"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AI Gestured Photobooth ✋📸" },
      {
        name: "description",
        content:
          "Photobooth interaktif berbasis AI: buka telapak tanganmu ke kamera untuk memicu sesi 3 foto otomatis dengan template estetik.",
      },
      { property: "og:title", content: "AI Gestured Photobooth" },
      {
        property: "og:description",
        content:
          "Sesi 3 foto otomatis dipicu oleh gestur telapak tangan terbuka menggunakan MediaPipe Hands.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-rose-50">
        <p className="text-sm text-muted-foreground">Loading Photobooth...</p>
      </div>
    );
  }
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-rose-50">
          <p className="text-sm text-muted-foreground">Loading AI model...</p>
        </div>
      }
    >
      <Photobooth />
    </Suspense>
  );
}
