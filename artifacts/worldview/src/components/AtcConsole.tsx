import { useEffect, useRef, useState, type CSSProperties } from "react";
import type maplibregl from "maplibre-gl";
import { ExternalLink, Mic, MicOff, Pin, PinOff, Square, Volume2 } from "lucide-react";
import { AIRPORTS } from "../lib/airports";
import { ATC_QUICK_PICKS, atcFeeds, atcRelayUrl, atcStreamUrl, captureAndTranscribe, liveAtcPlayerUrl, liveAtcSearchUrl, nearestAirport, type AtcTranscript } from "../lib/signals";

type AudioRoute = "direct" | "relay";

const FONT = "'Share Tech Mono','Courier New',monospace";
const ACCENT = "#a3e635";
const DIM = "rgba(217,249,157,0.55)";
const CLIP_SECONDS = 25;
const MAX_TRANSCRIPTS = 40;

type PlayState = "stopped" | "connecting" | "live" | "offline";

interface Props {
  map: maplibregl.Map | null;
  /** Airport the user is currently viewing in 3D, if any — takes priority over the map center. */
  focusIcao?: string | null;
  onFlagged: (t: AtcTranscript) => void;
}

const SEV_COLOR = ["#94a3b8", "#facc15", "#fb923c", "#ef4444"];

export function AtcConsole({ map, focusIcao, onFlagged }: Props) {
  const [autoIcao, setAutoIcao] = useState<{ icao: string; km: number } | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [mount, setMount] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [play, setPlay] = useState<PlayState>("stopped");
  const [volume, setVolume] = useState(0.8);
  const [capturing, setCapturing] = useState(false);
  const [pending, setPending] = useState(0);
  const [capError, setCapError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<AtcTranscript[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const captureRun = useRef(0);
  const [route, setRoute] = useState<AudioRoute>("direct");
  const routeRef = useRef<AudioRoute>("direct");
  const mountRef = useRef<string | null>(null);
  const connectTimer = useRef<number | undefined>(undefined);

  // Follow the airport nearest the map center.
  useEffect(() => {
    if (!map) return;
    const update = () => {
      const c = map.getCenter();
      const n = nearestAirport(c.lat, c.lng);
      setAutoIcao({ icao: n.airport.icao, km: n.km });
    };
    update();
    map.on("moveend", update);
    return () => { map.off("moveend", update); };
  }, [map]);

  const icao = pinned ?? focusIcao ?? autoIcao?.icao ?? "KJFK";
  const airport = AIRPORTS.find((a) => a.icao === icao);
  const feeds = atcFeeds(icao);
  const quickPicks = ATC_QUICK_PICKS;
  const activeFeed = feeds.find((f) => f.mount === mount) ?? (mount ? { mount, label: mount.toUpperCase(), url: atcStreamUrl(mount) } : null);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  // Switching airports stops a stream that belongs to the previous one.
  useEffect(() => {
    if (mount && !mount.startsWith(icao.toLowerCase()) && !custom) stopAudio();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [icao]);

  useEffect(() => () => { captureRun.current++; mountRef.current = null; window.clearTimeout(connectTimer.current); audioRef.current?.pause(); }, []);

  function stopCapture() {
    captureRun.current++;
    setCapturing(false);
  }

  function stopAudio() {
    mountRef.current = null;
    window.clearTimeout(connectTimer.current);
    const a = audioRef.current;
    if (a) { a.pause(); a.removeAttribute("src"); a.load(); }
    setPlay("stopped");
    setMount(null);
    stopCapture();
  }

  /** Direct from LiveATC first (listener's own IP); if that fails, retry through our API relay. */
  function attach(m: string, r: AudioRoute) {
    const a = audioRef.current;
    if (!a) return;
    window.clearTimeout(connectTimer.current);
    routeRef.current = r;
    setRoute(r);
    setPlay("connecting");
    a.src = r === "direct" ? atcStreamUrl(m) : atcRelayUrl(m);
    a.volume = volume;
    connectTimer.current = window.setTimeout(() => streamFailed(m, r), r === "direct" ? 9000 : 15000);
    a.play().catch((e: DOMException) => {
      if (e.name === "AbortError") return;
      if (e.name === "NotAllowedError") { window.clearTimeout(connectTimer.current); setPlay("offline"); return; }
      streamFailed(m, r);
    });
  }

  function streamFailed(m: string, r: AudioRoute) {
    if (mountRef.current !== m || routeRef.current !== r) return;
    if (r === "direct") { attach(m, "relay"); return; }
    window.clearTimeout(connectTimer.current);
    setPlay("offline");
  }

  function playFeed(m: string) {
    if (mount === m && play !== "offline") { stopAudio(); return; }
    if (mount !== m) stopCapture();
    mountRef.current = m;
    setMount(m);
    attach(m, "direct");
  }

  function openLiveAtcPlayer(m: string) {
    window.open(liveAtcPlayerUrl(m, icao), "liveatc-player", "popup,width=460,height=680");
  }

  async function toggleCapture() {
    if (capturing) { stopCapture(); return; }
    if (!activeFeed || play !== "live") { setCapError("Start a live feed first, then transcribe."); return; }
    setCapError(null);
    setCapturing(true);
    const run = ++captureRun.current;
    const { mount: m, label } = activeFeed;
    const icaoAtStart = icao;
    let failures = 0;
    while (captureRun.current === run) {
      setPending((p) => p + 1);
      try {
        const t = await captureAndTranscribe(m, icaoAtStart, label, CLIP_SECONDS);
        failures = 0;
        if (captureRun.current !== run || !t.lines.length) continue;
        const entry = { ...t, id: `${t.at}-${Math.random().toString(36).slice(2, 7)}` };
        setTranscripts((prev) => [entry, ...prev].slice(0, MAX_TRANSCRIPTS));
        if (entry.flags.some((f) => f.severity >= 2)) onFlagged(entry);
      } catch (e) {
        if (captureRun.current !== run) break;
        setCapError((e as Error).message);
        if (++failures >= 3) { stopCapture(); break; }
        await new Promise((r) => setTimeout(r, 5000));
      } finally {
        setPending((p) => p - 1);
      }
    }
  }

  const flaggedCount = transcripts.reduce((n, t) => n + t.flags.filter((f) => f.severity >= 2).length, 0);

  return (
    <section aria-label="Live ATC" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <audio
        ref={audioRef}
        preload="none"
        onPlaying={() => { window.clearTimeout(connectTimer.current); setPlay("live"); }}
        onWaiting={() => setPlay((p) => (p === "live" ? "connecting" : p))}
        onError={() => { const m = mountRef.current; if (m) streamFailed(m, routeRef.current); }}
        onEnded={() => { const m = mountRef.current; if (m) attach(m, routeRef.current); }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, letterSpacing: "0.12em", color: "#ecfccb" }}>
            {icao} <span style={{ color: DIM, fontSize: 10.5, letterSpacing: "0.1em" }}>{airport?.iata ?? ""}</span>
          </div>
          <div style={{ fontSize: 9.5, color: DIM, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {airport ? `${airport.name} · ${airport.city}` : "Custom airport"}
            {!pinned && !focusIcao && autoIcao ? ` · ${Math.round(autoIcao.km)} KM FROM VIEW` : ""}
            {focusIcao && !pinned ? " · AIRPORT VIEW" : ""}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setPinned((p) => (p ? null : icao))}
          aria-pressed={!!pinned}
          title={pinned ? "Unpin — follow the map again" : "Pin this airport"}
          style={iconBtn(!!pinned)}
        >
          {pinned ? <PinOff size={13} aria-hidden /> : <Pin size={13} aria-hidden />}
          <span className="sr-only">{pinned ? "Unpin airport" : "Pin airport"}</span>
        </button>
        <select
          aria-label="Choose airport"
          value={AIRPORTS.some((a) => a.icao === icao) ? icao : ""}
          onChange={(e) => { setPinned(e.target.value); }}
          style={{ fontFamily: FONT, fontSize: 10, background: "#05090a", color: "#ecfccb", border: `1px solid ${ACCENT}44`, padding: "4px 2px", maxWidth: 82 }}
        >
          <option value="" disabled>ICAO</option>
          {AIRPORTS.map((a) => <option key={a.icao} value={a.icao}>{a.icao}</option>)}
        </select>
      </div>

      {feeds.length === 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px", border: `1px solid ${ACCENT}22`, background: "rgba(5,9,10,0.5)" }}>
          <div style={{ fontSize: 9.5, lineHeight: 1.5, color: "#fcd34d" }}>
            No known LiveATC feed for {icao}. Public ATC streaming is unavailable at many airports (it is restricted in Germany, France and the UK). Try a live feed below, or paste a mount from LiveATC search:
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 4 }}>
            {quickPicks.map((q) => (
              <button
                key={q.mount}
                type="button"
                onClick={() => { setPinned(q.icao); playFeed(q.mount); }}
                style={{ fontFamily: FONT, fontSize: 9, letterSpacing: "0.1em", padding: "6px 0", cursor: "pointer", color: "#ecfccb", background: "rgba(163,230,53,0.06)", border: `1px solid ${ACCENT}33` }}
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: feeds.length ? "grid" : "none", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
        {feeds.map((f) => {
          const on = mount === f.mount;
          const state = on ? play : "stopped";
          return (
            <button
              key={f.mount}
              type="button"
              onClick={() => playFeed(f.mount)}
              aria-pressed={on}
              title={`LiveATC mount ${f.mount}`}
              style={{
                fontFamily: FONT, fontSize: 9, letterSpacing: "0.12em", padding: "6px 0", cursor: "pointer",
                color: on ? "#05090a" : state === "offline" ? "#fca5a5" : "#ecfccb",
                background: on ? (state === "offline" ? "#f87171" : ACCENT) : "rgba(163,230,53,0.06)",
                border: `1px solid ${on ? "transparent" : `${ACCENT}33`}`,
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const m = custom.trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
          if (m) playFeed(m);
        }}
        style={{ display: "flex", gap: 4 }}
      >
        <label htmlFor="atc-mount" className="sr-only">LiveATC mount name</label>
        <input
          id="atc-mount"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="custom mount e.g. kjfk_twr"
          style={{ flex: 1, minWidth: 0, fontFamily: FONT, fontSize: 10, background: "#05090a", color: "#ecfccb", border: `1px solid ${ACCENT}33`, padding: "5px 6px" }}
        />
        <button type="submit" style={{ ...iconBtn(false), width: "auto", padding: "0 8px", fontSize: 9, letterSpacing: "0.14em" }}>TUNE</button>
        <a href={liveAtcSearchUrl(icao)} target="_blank" rel="noreferrer" title="Find this airport's feeds on LiveATC" style={{ ...iconBtn(false), textDecoration: "none" }}>
          <ExternalLink size={12} aria-hidden />
          <span className="sr-only">Search LiveATC for {icao}</span>
        </a>
      </form>

      {activeFeed && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", border: `1px solid ${play === "offline" ? "#f8717155" : `${ACCENT}44`}`, background: "rgba(5,9,10,0.6)" }}>
          <span aria-hidden style={{ width: 7, height: 7, borderRadius: 99, background: play === "live" ? ACCENT : play === "offline" ? "#f87171" : "#facc15", boxShadow: play === "live" ? `0 0 8px ${ACCENT}` : "none", animation: play === "live" ? "sig-blink 1.4s infinite" : "none" }} />
          <div style={{ flex: 1, minWidth: 0, fontSize: 9.5, letterSpacing: "0.1em" }}>
            <div style={{ color: "#ecfccb" }}>
              {activeFeed.mount.toUpperCase()} · {play === "live" ? "LIVE" : play === "offline" ? "NO STREAM" : "CONNECTING"}
              {play !== "offline" && <span style={{ color: DIM }}> · {route === "direct" ? "DIRECT" : "VIA SERVER"}</span>}
            </div>
            {play === "offline" && (
              <div style={{ color: "#fca5a5", lineHeight: 1.5 }}>
                {"Couldn't play this feed directly or via the server. "}
                <button
                  type="button"
                  onClick={() => openLiveAtcPlayer(activeFeed.mount)}
                  style={{ fontFamily: FONT, fontSize: 9.5, letterSpacing: "0.1em", padding: 0, cursor: "pointer", color: ACCENT, background: "none", border: "none", textDecoration: "underline" }}
                >
                  Open in LiveATC player
                </button>
              </div>
            )}
          </div>
          {play === "live" && <EqBars />}
          <button type="button" onClick={() => openLiveAtcPlayer(activeFeed.mount)} style={iconBtn(false)} title="Open in LiveATC player (popup)">
            <ExternalLink size={11} aria-hidden /><span className="sr-only">Open {activeFeed.mount} in the LiveATC player</span>
          </button>
          <button type="button" onClick={stopAudio} style={iconBtn(false)} title="Stop">
            <Square size={11} aria-hidden /><span className="sr-only">Stop audio</span>
          </button>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Volume2 size={13} color={DIM} aria-hidden />
        <label htmlFor="atc-vol" className="sr-only">Volume</label>
        <input id="atc-vol" type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} style={{ flex: 1, accentColor: ACCENT }} />
      </div>

      <button
        type="button"
        onClick={() => void toggleCapture()}
        aria-pressed={capturing}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          fontFamily: FONT, fontSize: 10, letterSpacing: "0.22em", padding: "8px 0", cursor: "pointer",
          color: capturing ? "#05090a" : ACCENT, background: capturing ? ACCENT : "transparent",
          border: `1px solid ${ACCENT}`, boxShadow: capturing ? `0 0 16px ${ACCENT}66` : "none",
        }}
      >
        {capturing ? <MicOff size={13} aria-hidden /> : <Mic size={13} aria-hidden />}
        {capturing ? `TRANSCRIBING${pending ? " ···" : ""}` : "GEMINI TRANSCRIBE"}
      </button>
      <p style={{ margin: 0, fontSize: 9, lineHeight: 1.5, color: DIM }}>
        {capturing
          ? `Recording ${CLIP_SECONDS}s clips of ${activeFeed?.mount.toUpperCase() ?? "the feed"} on the server and sending them to Gemini. Keywords like MAYDAY, 7700 or DIVERSION raise an alert.`
          : "Play a live feed, then press transcribe. The server records the feed directly, so no tab sharing is needed."}
      </p>
      {capError && <p role="alert" style={{ margin: 0, fontSize: 9.5, color: "#fca5a5" }}>{capError}</p>}

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 9, letterSpacing: "0.18em", color: DIM, paddingTop: 2 }}>
        <span>TRANSCRIPT LOG · {transcripts.length}</span>
        {flaggedCount > 0 && <span style={{ color: "#fb923c" }}>{flaggedCount} FLAGGED</span>}
      </div>
      <ol aria-live="polite" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
        {transcripts.length === 0 && (
          <li style={{ fontSize: 9.5, color: DIM, padding: "8px 0", textAlign: "center", border: `1px dashed ${ACCENT}22` }}>
            {capturing ? "Listening for transmissions…" : "No transmissions transcribed yet."}
          </li>
        )}
        {transcripts.map((t) => {
          const top = Math.max(0, ...t.flags.map((f) => f.severity));
          return (
            <li key={t.id} style={{ borderLeft: `2px solid ${top ? SEV_COLOR[top] : `${ACCENT}55`}`, padding: "4px 0 4px 8px", background: top >= 2 ? "rgba(239,68,68,0.06)" : "transparent" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 8.5, color: DIM, letterSpacing: "0.12em" }}>
                <span>{t.icao} · {t.feed}</span>
                <time dateTime={new Date(t.at).toISOString()}>{new Date(t.at).toISOString().slice(11, 19)}Z</time>
              </div>
              {t.flags.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 3, margin: "3px 0" }}>
                  {t.flags.map((f) => (
                    <span key={f.tag} style={{ fontSize: 8.5, letterSpacing: "0.1em", padding: "1px 5px", color: "#05090a", background: SEV_COLOR[f.severity] }}>{f.tag}</span>
                  ))}
                </div>
              )}
              {t.lines.map((l, i) => (
                <div key={i} style={{ fontSize: 10, lineHeight: 1.45, color: "#ecfccb" }}>
                  <span style={{ color: l.speaker === "ATC" ? "#67e8f9" : ACCENT }}>{l.speaker}: </span>{l.text}
                </div>
              ))}
              {t.summary && <div style={{ fontSize: 9, color: DIM, marginTop: 2 }}>{t.summary}</div>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function EqBars() {
  return (
    <span aria-hidden style={{ display: "inline-flex", alignItems: "flex-end", gap: 2, height: 12 }}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} style={{ width: 2, height: 12, background: ACCENT, transformOrigin: "bottom", animation: `sig-eq 0.${6 + i}s ease-in-out ${i * 0.1}s infinite alternate` }} />
      ))}
    </span>
  );
}

function iconBtn(active: boolean): CSSProperties {
  return {
    display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, cursor: "pointer",
    fontFamily: FONT, color: active ? "#05090a" : ACCENT, background: active ? ACCENT : "transparent", border: `1px solid ${ACCENT}55`,
  };
}

