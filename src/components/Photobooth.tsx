import { useEffect, useRef, useState, useCallback } from "react";
import html2canvas from "html2canvas";

type Template = "strawberry" | "cyberpunk" | "polaroid";

type Phase = "idle" | "detecting" | "ready" | "session" | "review";

interface Landmark {
  x: number;
  y: number;
  z: number;
}

function isOpenPalm(landmarks: Landmark[]): boolean {
  // landmark 9 = middle finger MCP (palm center-ish)
  // fingertips: 4 (thumb), 8, 12, 16, 20
  const palm = landmarks[9];
  const tips = [4, 8, 12, 16, 20];
  const dists = tips.map((i) => {
    const dx = landmarks[i].x - palm.x;
    const dy = landmarks[i].y - palm.y;
    return Math.hypot(dx, dy);
  });
  // reference distance: wrist(0) to palm(9)
  const ref = Math.hypot(landmarks[0].x - palm.x, landmarks[0].y - palm.y);
  // all fingertips should be far enough (relative)
  return dists.every((d) => d > ref * 0.7);
}

function beep(freq = 880, duration = 120) {
  try {
    const AC =
      (window as unknown as { AudioContext: typeof AudioContext }).AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = "sine";
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration / 1000);
    osc.start();
    osc.stop(ctx.currentTime + duration / 1000);
  } catch {
    /* ignore */
  }
}

export default function Photobooth() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef<{ stop: () => void } | null>(null);
  const handsRef = useRef<{ close?: () => void } | null>(null);

  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState("Menginisialisasi kamera...");
  const [handDetected, setHandDetected] = useState(false);
  const [palmProgress, setPalmProgress] = useState(0); // 0..1
  const [photos, setPhotos] = useState<string[]>([]);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [template, setTemplate] = useState<Template>("strawberry");
  const [cameraReady, setCameraReady] = useState(false);

  const phaseRef = useRef(phase);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const palmStartRef = useRef<number | null>(null);

  const capturePhoto = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video) return null;
    const c = document.createElement("canvas");
    // 4:3 aspect
    const w = 640;
    const h = 480;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    // mirror
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    // cover fit
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const targetRatio = w / h;
    const srcRatio = vw / vh;
    let sx = 0,
      sy = 0,
      sw = vw,
      sh = vh;
    if (srcRatio > targetRatio) {
      sw = vh * targetRatio;
      sx = (vw - sw) / 2;
    } else {
      sh = vw / targetRatio;
      sy = (vh - sh) / 2;
    }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    return c.toDataURL("image/jpeg", 0.92);
  }, []);

  const runSession = useCallback(async () => {
    setPhase("session");
    setPhotos([]);
    const taken: string[] = [];
    for (let i = 0; i < 3; i++) {
      for (let n = 3; n >= 1; n--) {
        setCountdown(n);
        beep(660, 100);
        await new Promise((r) => setTimeout(r, 1000));
      }
      setCountdown(null);
      // flash
      setFlash(true);
      beep(1200, 200);
      const shot = capturePhoto();
      await new Promise((r) => setTimeout(r, 150));
      setFlash(false);
      if (shot) {
        taken.push(shot);
        setPhotos([...taken]);
      }
      if (i < 2) {
        // 2s gap between poses
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    setPhase("review");
    setStatus("Selesai! Pilih template & download 🎉");
  }, [capturePhoto]);

  // MediaPipe setup — load via CDN to avoid ESM bundling issues
  useEffect(() => {
    let cancelled = false;
    let rafActive = true;

    const loadScript = (src: string) =>
      new Promise<void>((resolve, reject) => {
        if (document.querySelector(`script[src="${src}"]`)) return resolve();
        const s = document.createElement("script");
        s.src = src;
        s.crossOrigin = "anonymous";
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(s);
      });

    (async () => {
      try {
        await loadScript(
          "https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/hands.js",
        );
        await loadScript(
          "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils@0.3.1675466862/camera_utils.js",
        );
      } catch (e) {
        console.error(e);
        setStatus("Gagal memuat model AI. Cek koneksi internet.");
        return;
      }
      if (cancelled) return;

      const w = window as unknown as {
        Hands: new (opts: { locateFile: (f: string) => string }) => {
          setOptions: (o: Record<string, unknown>) => void;
          onResults: (cb: (r: { multiHandLandmarks?: Landmark[][] }) => void) => void;
          send: (i: { image: HTMLVideoElement }) => Promise<void>;
          close?: () => void;
        };
        Camera: new (
          video: HTMLVideoElement,
          opts: { onFrame: () => Promise<void>; width: number; height: number },
        ) => { start: () => Promise<void>; stop: () => void };
      };

      if (!w.Hands || !w.Camera) {
        setStatus("Model AI gagal diinisialisasi.");
        return;
      }

      const hands = new w.Hands({
        locateFile: (file: string) =>
          `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
      });

      handsRef.current = hands;

      hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.7,
        minTrackingConfidence: 0.6,
      });

      hands.onResults((results) => {
        if (!rafActive) return;
        const canvas = overlayRef.current;
        const video = videoRef.current;
        if (!canvas || !video) return;
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 480;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const lms = results.multiHandLandmarks?.[0];
        setHandDetected(!!lms);

        if (lms && (phaseRef.current === "idle" || phaseRef.current === "detecting")) {
          // draw dots (mirrored)
          ctx.save();
          ctx.translate(canvas.width, 0);
          ctx.scale(-1, 1);
          const palm = lms[9];
          const open = isOpenPalm(lms);

          // draw finger tips
          ctx.fillStyle = open ? "#ec4899" : "#38bdf8";
          for (const idx of [4, 8, 12, 16, 20]) {
            const p = lms[idx];
            ctx.beginPath();
            ctx.arc(p.x * canvas.width, p.y * canvas.height, 8, 0, Math.PI * 2);
            ctx.fill();
          }
          // palm marker
          if (open) {
            const px = palm.x * canvas.width;
            const py = palm.y * canvas.height;
            ctx.font = "60px serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("🌸", px, py);
          }
          ctx.restore();

          if (open) {
            if (palmStartRef.current == null) {
              palmStartRef.current = performance.now();
              setPhase("detecting");
              beep(880, 80);
            }
            const held = (performance.now() - palmStartRef.current) / 1500;
            setPalmProgress(Math.min(1, held));
            if (held >= 1 && (phaseRef.current as Phase) !== "ready") {
              setPhase("ready");
              beep(1500, 250);
              palmStartRef.current = null;
              setPalmProgress(0);
              setTimeout(() => runSession(), 400);
            }
          } else {
            palmStartRef.current = null;
            setPalmProgress(0);
            if (phaseRef.current === "detecting") setPhase("idle");
          }
        } else if (!lms && phaseRef.current === "detecting") {
          palmStartRef.current = null;
          setPalmProgress(0);
          setPhase("idle");
        }
      });

      const video = videoRef.current;
      if (!video) return;

      const camera = new w.Camera(video, {
        onFrame: async () => {
          if (!videoRef.current) return;
          await hands.send({ image: videoRef.current });
        },
        width: 640,
        height: 480,
      });
      cameraRef.current = camera;
      try {
        await camera.start();
        setCameraReady(true);
        setStatus("Buka telapak tanganmu ke kamera ✋");
      } catch (e) {
        console.error(e);
        setStatus("Gagal mengakses kamera. Izinkan akses kamera & refresh.");
      }
    })();

    return () => {
      cancelled = true;
      rafActive = false;
      cameraRef.current?.stop?.();
      handsRef.current?.close?.();
    };
  }, [runSession]);

  const reset = () => {
    setPhotos([]);
    setPhase("idle");
    setStatus("Buka telapak tanganmu ke kamera ✋");
    palmStartRef.current = null;
  };

  const download = async () => {
    if (!stripRef.current) return;
    const canvas = await html2canvas(stripRef.current, {
      backgroundColor: null,
      scale: 2,
      useCORS: true,
    });
    const link = document.createElement("a");
    link.download = `photobooth-${template}-${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-rose-50 via-white to-sky-50 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 text-foreground">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              ✋ AI Gestured Photobooth
            </h1>
            <p className="text-sm text-muted-foreground">
              Buka telapak tanganmu ke kamera untuk mulai memotret otomatis.
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 ${
                cameraReady
                  ? "bg-emerald-100 text-emerald-700"
                  : "bg-amber-100 text-amber-700"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  cameraReady ? "bg-emerald-500 animate-pulse" : "bg-amber-500"
                }`}
              />
              {cameraReady ? "Kamera Aktif" : "Menyiapkan Kamera"}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 ${
                handDetected
                  ? "bg-pink-100 text-pink-700"
                  : "bg-slate-100 text-slate-500"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  handDetected ? "bg-pink-500 animate-pulse" : "bg-slate-400"
                }`}
              />
              AI: {handDetected ? "Tangan Terdeteksi" : "Menunggu Tangan"}
            </span>
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          {/* Camera area */}
          <div className="relative overflow-hidden rounded-3xl bg-black shadow-2xl aspect-[4/3]">
            <video
              ref={videoRef}
              playsInline
              muted
              className="absolute inset-0 h-full w-full object-cover [transform:scaleX(-1)]"
            />
            <canvas
              ref={overlayRef}
              className="absolute inset-0 h-full w-full pointer-events-none"
            />

            {/* Instruction overlay */}
            {phase === "idle" && cameraReady && (
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-6 text-center text-white">
                <p className="text-lg font-semibold">
                  Buka Telapak Tanganmu ke Kamera ✋
                </p>
                <p className="text-sm text-white/80">
                  Tahan 1-2 detik untuk mulai sesi foto
                </p>
              </div>
            )}

            {/* Palm hold progress */}
            {(phase === "detecting" || phase === "ready") && (
              <div className="absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-black/60 px-4 py-2 text-white backdrop-blur">
                <div className="mb-1 text-xs font-medium">
                  {phase === "ready" ? "Siap!" : "Menahan telapak..."}
                </div>
                <div className="h-2 w-40 overflow-hidden rounded-full bg-white/20">
                  <div
                    className="h-full bg-pink-400 transition-all"
                    style={{ width: `${palmProgress * 100}%` }}
                  />
                </div>
              </div>
            )}

            {/* Countdown */}
            {countdown !== null && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="text-[180px] font-black text-white drop-shadow-[0_8px_30px_rgba(0,0,0,0.6)] animate-scale-in">
                  {countdown}
                </div>
              </div>
            )}

            {/* Flash */}
            {flash && (
              <div className="absolute inset-0 bg-white animate-fade-in" />
            )}

            {/* Session photo indicator */}
            {phase === "session" && (
              <div className="absolute right-4 top-4 rounded-full bg-black/60 px-3 py-1 text-sm text-white backdrop-blur">
                Foto {photos.length + 1} / 3
              </div>
            )}

            {!cameraReady && (
              <div className="absolute inset-0 flex items-center justify-center text-white/80">
                <p>{status}</p>
              </div>
            )}
          </div>

          {/* Side panel */}
          <aside className="flex flex-col gap-4">
            <div className="rounded-2xl border bg-card p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold">Thumbnails</h2>
              <div className="grid grid-cols-3 gap-2">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="aspect-[4/3] overflow-hidden rounded-lg border bg-muted"
                  >
                    {photos[i] ? (
                      <img
                        src={photos[i]}
                        alt={`shot ${i + 1}`}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        {i + 1}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border bg-card p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold">Template Frame</h2>
              <div className="flex flex-col gap-2">
                {(
                  [
                    { id: "strawberry", label: "🍓 Indragiri Strawberry" },
                    { id: "cyberpunk", label: "🌐 Cyberpunk Techy" },
                    { id: "polaroid", label: "📷 Classic Polaroid" },
                  ] as { id: Template; label: string }[]
                ).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTemplate(t.id)}
                    className={`rounded-lg border px-3 py-2 text-left text-sm transition ${
                      template === t.id
                        ? "border-pink-500 bg-pink-50 text-pink-700"
                        : "hover:bg-muted"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            {phase === "review" && (
              <div className="flex flex-col gap-2">
                <button
                  onClick={download}
                  className="rounded-xl bg-pink-500 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-pink-500/30 transition hover:bg-pink-600"
                >
                  ⬇ Download Strip PNG
                </button>
                <button
                  onClick={reset}
                  className="rounded-xl border px-4 py-3 text-sm font-semibold transition hover:bg-muted"
                >
                  🔄 Foto Ulang
                </button>
              </div>
            )}
          </aside>
        </div>

        {/* Photo Strip preview */}
        {photos.length === 3 && (
          <div className="mt-10 flex justify-center">
            <PhotoStrip ref={stripRef} photos={photos} template={template} />
          </div>
        )}
      </div>
    </div>
  );
}

// ============ Photo Strip ============
import { forwardRef } from "react";

const PhotoStrip = forwardRef<
  HTMLDivElement,
  { photos: string[]; template: Template }
>(({ photos, template }, ref) => {
  const date = new Date().toLocaleDateString("id-ID", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // ---- STRAWBERRY: soft pink scrapbook, strawberries + bows + hearts ----
  if (template === "strawberry") {
    const tilt = ["-rotate-2", "rotate-1", "-rotate-1"];
    return (
      <div
        ref={ref}
        className="relative w-[360px] p-5 shadow-2xl"
        style={{
          borderRadius: "14px",
          background:
            "radial-gradient(circle at 20% 15%, #ffd3e0 0 2px, transparent 3px)," +
            "radial-gradient(circle at 70% 40%, #ffe4ec 0 2px, transparent 3px)," +
            "linear-gradient(180deg,#ffe9f0 0%,#fff6ec 45%,#ffe4ec 100%)",
          backgroundSize: "36px 36px, 48px 48px, 100% 100%",
          border: "6px double #f5a3bb",
          boxShadow:
            "0 0 0 3px #fff inset, 0 0 0 9px #ffd3e0 inset, 0 20px 40px -12px rgba(219,80,120,.35)",
        }}
      >
        {/* corner decorations */}
        <div className="absolute -top-3 -left-2 text-2xl rotate-[-20deg]">🎀</div>
        <div className="absolute -top-3 -right-2 text-2xl rotate-[15deg]">🍓</div>
        <div className="absolute -bottom-3 -left-2 text-2xl">🌸</div>
        <div className="absolute -bottom-3 -right-2 text-2xl">🐰</div>

        <div className="mb-3 text-center">
          <div
            className="text-3xl leading-none text-rose-600"
            style={{
              fontFamily: "'Brush Script MT','Segoe Script',cursive",
            }}
          >
            Strawberry Memories
          </div>
          <div className="mt-1 text-[10px] font-bold tracking-[0.25em] text-rose-500">
            ✦ INDRAGIRI STRAWBERRY ZONE ✦
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {photos.map((p, i) => (
            <div key={i} className={`relative ${tilt[i]}`}>
              <div
                className="bg-white p-2 pb-3 shadow-md"
                style={{
                  border: "2px solid #ffb3c8",
                  borderRadius: "8px",
                  backgroundImage:
                    "radial-gradient(circle at 8% 8%, #ffe4ec 0 3px, transparent 4px), radial-gradient(circle at 92% 92%, #ffe4ec 0 3px, transparent 4px)",
                }}
              >
                <img
                  src={p}
                  alt=""
                  className="aspect-[4/3] w-full object-cover"
                  style={{ borderRadius: "4px" }}
                />
              </div>
              {/* tiny sticker per frame */}
              <div className="absolute -left-2 -top-2 text-lg">
                {["🍓", "💗", "🌷"][i]}
              </div>
              <div className="absolute -right-2 -bottom-2 text-lg">
                {["🎀", "✨", "🐰"][i]}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 text-center">
          <div
            className="text-xl text-rose-600"
            style={{ fontFamily: "'Brush Script MT','Segoe Script',cursive" }}
          >
            my sweetest dream 🍓
          </div>
          <div className="mt-1 text-[10px] font-semibold tracking-wider text-rose-500">
            P2M INFORMATIKA · DESA INDRAGIRI
          </div>
          <div className="text-[9px] italic text-rose-400">{date}</div>
        </div>
      </div>
    );
  }

  // ---- CYBERPUNK: dark neon scrapbook with the same ornate feel ----
  if (template === "cyberpunk") {
    const tilt = ["-rotate-2", "rotate-1", "-rotate-1"];
    return (
      <div
        ref={ref}
        className="relative w-[360px] p-5 shadow-2xl"
        style={{
          borderRadius: "14px",
          background:
            "repeating-linear-gradient(0deg, rgba(0,255,255,.06) 0 1px, transparent 1px 22px)," +
            "repeating-linear-gradient(90deg, rgba(255,0,200,.06) 0 1px, transparent 1px 22px)," +
            "linear-gradient(180deg,#0a0018 0%,#160034 50%,#0a0018 100%)",
          border: "3px solid #ff2bd6",
          boxShadow:
            "0 0 0 3px #0a0018 inset, 0 0 0 6px #00e5ff inset, 0 0 40px rgba(255,43,214,.5), 0 20px 40px -10px rgba(0,229,255,.4)",
        }}
      >
        <div
          className="absolute -top-3 -left-2 rounded px-1 text-[10px] font-mono"
          style={{
            background: "#00e5ff",
            color: "#0a0018",
          }}
        >
          ◆ SYS.OK
        </div>
        <div
          className="absolute -top-3 -right-2 rounded px-1 text-[10px] font-mono"
          style={{ background: "#ff2bd6", color: "#0a0018" }}
        >
          v2.077 ◆
        </div>
        <div className="absolute -bottom-3 -left-2 text-lg">⚡</div>
        <div className="absolute -bottom-3 -right-2 text-lg">🤖</div>

        <div className="mb-3 text-center">
          <div
            className="text-2xl font-black leading-none"
            style={{
              color: "#00e5ff",
              fontFamily: "'Brush Script MT','Segoe Script',cursive",
              textShadow: "0 0 8px #00e5ff, 0 0 16px #ff2bd6",
            }}
          >
            Neon Memories
          </div>
          <div
            className="mt-1 text-[10px] font-mono tracking-[0.25em]"
            style={{ color: "#ff2bd6" }}
          >
            ▚ FUTURE.TECH.AI.PHOTOBOOTH ▞
          </div>
        </div>

        <div className="flex flex-col gap-3">
          {photos.map((p, i) => (
            <div key={i} className={`relative ${tilt[i]}`}>
              <div
                className="p-2"
                style={{
                  borderRadius: "6px",
                  background:
                    "linear-gradient(135deg,#ff2bd6 0%,#00e5ff 100%)",
                  boxShadow: "0 0 14px rgba(0,229,255,.6)",
                }}
              >
                <div
                  className="p-1"
                  style={{
                    background: "#0a0018",
                    borderRadius: "4px",
                  }}
                >
                  <img
                    src={p}
                    alt=""
                    className="aspect-[4/3] w-full object-cover"
                    style={{
                      borderRadius: "2px",
                      filter: "saturate(1.1) contrast(1.05)",
                    }}
                  />
                </div>
              </div>
              <div
                className="absolute -left-2 -top-2 rounded px-1 text-[9px] font-mono"
                style={{ background: "#00e5ff", color: "#0a0018" }}
              >
                #{String(i + 1).padStart(2, "0")}
              </div>
              <div className="absolute -right-2 -bottom-2 text-sm">
                {["✦", "▲", "◆"][i]}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 text-center">
          <div
            className="text-lg"
            style={{
              color: "#00e5ff",
              fontFamily: "'Brush Script MT','Segoe Script',cursive",
              textShadow: "0 0 6px #ff2bd6",
            }}
          >
            digital dreams ⚡
          </div>
          <div
            className="mt-1 text-[10px] font-mono tracking-widest"
            style={{ color: "#ff2bd6" }}
          >
            [ {date.toUpperCase()} ]
          </div>
        </div>
      </div>
    );
  }

  // ---- CLASSIC POLAROID: vintage cream, pressed flowers, handwriting ----
  const tilt = ["-rotate-2", "rotate-1", "-rotate-1"];
  return (
    <div
      ref={ref}
      className="relative w-[360px] p-5 shadow-2xl"
      style={{
        borderRadius: "6px",
        background:
          "radial-gradient(circle at 20% 30%, rgba(120,90,60,.05) 0 1.5px, transparent 2.5px)," +
          "radial-gradient(circle at 70% 60%, rgba(120,90,60,.05) 0 1.5px, transparent 2.5px)," +
          "linear-gradient(180deg,#faf5ea 0%,#efe6d2 100%)",
        backgroundSize: "22px 22px, 30px 30px, 100% 100%",
        border: "1px solid #d9cdb3",
        boxShadow:
          "0 0 0 6px #faf5ea inset, 0 0 0 7px #c9b891 inset, 0 20px 40px -12px rgba(90,70,40,.35)",
      }}
    >
      <div className="absolute -top-3 -left-2 text-xl rotate-[-15deg]">🌿</div>
      <div className="absolute -top-3 -right-2 text-xl rotate-[15deg]">🌼</div>
      <div className="absolute -bottom-3 -left-2 text-xl">🕊️</div>
      <div className="absolute -bottom-3 -right-2 text-xl">🍃</div>

      <div className="mb-3 text-center">
        <div
          className="text-3xl leading-none"
          style={{
            fontFamily: "'Brush Script MT','Segoe Script',cursive",
            color: "#3a2e1f",
          }}
        >
          Our Memories
        </div>
        <div className="mt-1 text-[10px] tracking-[0.35em] text-neutral-500">
          — A E S T H E T I C · P O L A R O I D —
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {photos.map((p, i) => (
          <div key={i} className={`relative ${tilt[i]}`}>
            <div
              className="bg-white p-2 pb-8 shadow-md"
              style={{ borderRadius: "2px" }}
            >
              <img
                src={p}
                alt=""
                className="aspect-[4/3] w-full object-cover"
                style={{ filter: "sepia(.06) saturate(.95)" }}
              />
              <div
                className="mt-1 text-center text-xs"
                style={{
                  fontFamily: "'Brush Script MT','Segoe Script',cursive",
                  color: "#5a4a35",
                }}
              >
                {["morning", "smile", "forever"][i]} · {date}
              </div>
            </div>
            <div className="absolute -left-2 -top-2 text-base">
              {["🌸", "🌾", "🌻"][i]}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 text-center">
        <div
          className="text-xl"
          style={{
            fontFamily: "'Brush Script MT','Segoe Script',cursive",
            color: "#3a2e1f",
          }}
        >
          my beautiful dream
        </div>
        <div className="mt-1 text-[9px] tracking-[0.3em] text-neutral-500">
          KEEP · THIS · MOMENT
        </div>
      </div>
    </div>
  );
});
PhotoStrip.displayName = "PhotoStrip";

