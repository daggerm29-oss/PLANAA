import { useCallback, useEffect, useRef, useState } from "react";
import { apiBase } from "./cctv";
import { AIRPORTS, type Airport } from "./airports";

export interface SquawkAlert {
  hex: string;
  flight: string;
  reg: string;
  type: string;
  desc: string;
  lat: number;
  lon: number;
  alt: number | string | null;
  gs: number | null;
  track: number | null;
  squawk: "7500" | "7600" | "7700" | string;
  meaning: string;
  emergency: string | null;
}

export interface JamPayload {
  date: string;
  dates: string[];
  cells: number;
  high: number;
  medium: number;
  geojson: GeoJSON.FeatureCollection;
}

export interface RadarFrame { time: number; tiles: string }
export interface Strike { lat: number; lon: number; t: number }

export interface AtcFeed { mount: string; label: string; url: string }
export interface AtcFlag { tag: string; severity: number; excerpt: string }
export interface AtcTranscript {
  id: string;
  at: number;
  icao: string;
  feed: string;
  lines: { speaker: string; text: string }[];
  summary: string;
  flags: AtcFlag[];
}

export interface SignalLayers { jam: boolean; radar: boolean; lightning: boolean }
export const DEFAULT_SIGNAL_LAYERS: SignalLayers = { jam: true, radar: false, lightning: true };

export const SQUAWK_COLOR: Record<string, string> = { "7500": "#f43f5e", "7600": "#f59e0b", "7700": "#ef4444" };

type Status = "idle" | "loading" | "ready" | "error";

/** Polls a JSON endpoint while `active`; keeps the last good payload on transient failures. */
function usePolled<T>(path: string | null, intervalMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (!path || busy.current) return;
    busy.current = true;
    setStatus((s) => (s === "ready" ? s : "loading"));
    try {
      const r = await fetch(`${apiBase()}${path}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
      setData(j as T);
      setError(null);
      setStatus("ready");
    } catch (e) {
      setError((e as Error).message);
      setStatus((s) => (s === "ready" ? s : "error"));
    } finally {
      busy.current = false;
    }
  }, [path]);

  useEffect(() => {
    if (!path) return;
    void load();
    if (!intervalMs) return;
    const id = setInterval(() => void load(), intervalMs);
    return () => clearInterval(id);
  }, [path, intervalMs, load]);

  return { data, status, error, reload: load };
}

/** Emergency squawks are global alerts, so this always polls regardless of open panels. */
export function useSquawkAlerts() {
  const q = usePolled<{ alerts: SquawkAlert[]; now: number }>("/api/signals/squawks", 15_000);
  return { alerts: q.data?.alerts ?? [], status: q.status, updatedAt: q.data?.now ?? null };
}

export function useGpsJam(active: boolean, date: string | null) {
  return usePolled<JamPayload>(active ? `/api/signals/gpsjam${date ? `?date=${date}` : ""}` : null, 60 * 60 * 1000);
}

export function useRadar(active: boolean) {
  return usePolled<{ frames: RadarFrame[] }>(active ? "/api/signals/radar" : null, 5 * 60 * 1000);
}

export function useLightning(active: boolean) {
  return usePolled<{ strikes: Strike[]; windowMin: number; connected: boolean; now: number }>(active ? "/api/signals/lightning" : null, 20_000);
}

export function nearestAirport(lat: number, lon: number): { airport: Airport; km: number } {
  let best = AIRPORTS[0];
  let bestKm = Infinity;
  for (const a of AIRPORTS) {
    const km = haversineKm(lat, lon, a.lat, a.lon);
    if (km < bestKm) { best = a; bestKm = km; }
  }
  return { airport: best, km: bestKm };
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function formatAlt(alt: number | string | null) {
  if (alt === "ground") return "GROUND";
  if (typeof alt !== "number") return "—";
  return alt >= 18000 ? `FL${Math.round(alt / 100)}` : `${alt.toLocaleString()} FT`;
}

// ─── Audio capture → 16 kHz mono WAV (a format Gemini always accepts) ───────

const TARGET_RATE = 16_000;

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

async function blobToWavDataUrl(blob: Blob): Promise<{ url: string; rms: number }> {
  const ctx = new OfflineAudioContext(1, 1, TARGET_RATE);
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  const frames = Math.ceil(decoded.duration * TARGET_RATE);
  const off = new OfflineAudioContext(1, Math.max(1, frames), TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = (await off.startRendering()).getChannelData(0);
  let sum = 0;
  for (let i = 0; i < rendered.length; i += 8) sum += rendered[i] * rendered[i];
  const rms = Math.sqrt(sum / Math.max(1, rendered.length / 8));
  const wav = encodeWav(rendered, TARGET_RATE);
  const url = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(wav);
  });
  return { url, rms };
}

/**
 * Captures this tab's audio output (the LiveATC stream is cross-origin, so it can't be tapped
 * directly) and emits fixed-length WAV clips. The browser asks the user to share the tab with audio.
 */
export class TabAudioClipper {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private clipMs: number, private onClip: (wavDataUrl: string) => void, private onEnd: (reason: string) => void) {}

  async start() {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser can't capture tab audio. Use desktop Chrome or Edge.");
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      // Chrome-only hints: preselect this tab and its audio.
      ...({ preferCurrentTab: true, selfBrowserSurface: "include", systemAudio: "include" } as object),
    } as DisplayMediaStreamOptions);
    const audio = stream.getAudioTracks();
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!audio.length) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('No audio was shared. Pick "This tab" and keep "Share tab audio" switched on.');
    }
    this.stream = new MediaStream(audio);
    audio[0].addEventListener("ended", () => this.stop("Tab audio sharing stopped."));
    this.cycle();
    this.timer = setInterval(() => this.cycle(), this.clipMs);
  }

  /** A fresh recorder per clip gives each blob its own container header, so it decodes standalone. */
  private cycle() {
    if (!this.stream) return;
    this.recorder?.stop();
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      if (!chunks.length) return;
      try {
        const { url, rms } = await blobToWavDataUrl(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
        // Skip near-silent clips so quiet frequencies don't burn Gemini quota.
        if (rms > 0.004) this.onClip(url);
      } catch { /* undecodable fragment */ }
    };
    rec.start();
    this.recorder = rec;
  }

  stop(reason = "Stopped.") {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.recorder?.state === "recording") this.recorder.stop();
    this.recorder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    const had = !!this.stream;
    this.stream = null;
    if (had) this.onEnd(reason);
  }
}

export async function transcribeClip(audio: string, icao: string, feed: string): Promise<Omit<AtcTranscript, "id">> {
  const r = await fetch(`${apiBase()}/api/signals/atc/transcribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audio, icao, feed }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return { at: j.at, icao, feed, lines: j.lines, summary: j.summary, flags: j.flags };
}

/** Server-side capture of a live mount → Gemini transcript (no tab sharing needed). */
export async function captureAndTranscribe(mount: string, icao: string, feed: string, seconds: number): Promise<Omit<AtcTranscript, "id">> {
  const r = await fetch(`${apiBase()}/api/signals/atc/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mount, icao, feed, seconds }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return { at: j.at, icao, feed, lines: j.lines, summary: j.summary, flags: j.flags };
}

/** Played straight from LiveATC in the browser, so each listener uses their own connection. */
export const atcStreamUrl = (mount: string) => `https://d.liveatc.net/${encodeURIComponent(mount)}`;

/** Same feed piped through our API, used when the browser can't reach LiveATC directly. */
export const atcRelayUrl = (mount: string) => `${apiBase()}/api/signals/atc/relay/${encodeURIComponent(mount)}`;

/** LiveATC's own web player; it always works because the listener passes LiveATC's Cloudflare check. */
export const liveAtcPlayerUrl = (mount: string, icao: string) =>
  `https://www.liveatc.net/hlisten.php?mount=${encodeURIComponent(mount)}&icao=${encodeURIComponent(icao.toLowerCase())}`;

/**
 * LiveATC mounts verified live (2026-10-26). LiveATC has no public directory API and bans servers
 * that scan for mounts, so new airports are added here by hand (find mounts on liveatc.net search).
 */
const ATC_DIRECTORY: Record<string, [mount: string, label: string][]> = {
  KJFK: [["kjfk_twr", "TOWER"], ["kjfk_gnd", "GROUND"], ["kjfk_dep", "DEPARTURE"], ["kjfk_atis", "ATIS"]],
  KATL: [["katl_twr", "TOWER"], ["katl_gnd", "GROUND"]],
  KSFO: [["ksfo_twr", "TOWER"], ["ksfo_twr2", "TOWER 2"], ["ksfo_gnd", "GROUND"], ["ksfo_gnd2", "GROUND 2"], ["ksfo_app2", "APPROACH"], ["ksfo_gnd_twr", "GND/TWR"]],
  RJTT: [["rjtt_twr", "TOWER"], ["rjtt_gnd", "GROUND"], ["rjtt_app", "APPROACH"], ["rjtt_dep", "DEPARTURE"], ["rjtt_app_dep", "APP/DEP"], ["rjtt_atis", "ATIS"]],
};

export interface AtcQuickPick { icao: string; mount: string; label: string }
export const ATC_QUICK_PICKS: AtcQuickPick[] = [
  { icao: "KJFK", mount: "kjfk_twr", label: "JFK TOWER" },
  { icao: "KJFK", mount: "kjfk_gnd", label: "JFK GROUND" },
  { icao: "KATL", mount: "katl_twr", label: "ATL TOWER" },
  { icao: "KSFO", mount: "ksfo_gnd", label: "SFO GROUND" },
  { icao: "RJTT", mount: "rjtt_app", label: "HANEDA APP" },
  { icao: "RJTT", mount: "rjtt_twr", label: "HANEDA TWR" },
];

export function atcFeeds(icao: string): AtcFeed[] {
  return (ATC_DIRECTORY[icao.toUpperCase()] ?? []).map(([mount, label]) => ({ mount, label, url: atcStreamUrl(mount) }));
}

export const liveAtcSearchUrl = (icao: string) => `https://www.liveatc.net/search/?icao=${encodeURIComponent(icao)}`;
