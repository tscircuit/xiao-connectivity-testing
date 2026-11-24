"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseDataRecord } from "./serial-parser";

type Sample = {
  value: number;
  time: number;
};

type SerialPortLike = {
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
};

type SerialNavigator = Navigator & {
  serial?: {
    requestPort(): Promise<SerialPortLike>;
  };
};

const DUTS = [
  { id: "DUT1", label: "DUT 1", source: "D4 / GPIO6", input: "D0 / GPIO26" },
  { id: "DUT2", label: "DUT 2", source: "D5 / GPIO7", input: "D1 / GPIO27" },
  { id: "DUT3", label: "DUT 3", source: "D6 / GPIO0", input: "D2 / GPIO28" },
  { id: "DUT4", label: "DUT 4", source: "D7 / GPIO1", input: "D3 / GPIO29" },
] as const;

type DutId = (typeof DUTS)[number]["id"];
type DutDefinition = (typeof DUTS)[number];

const TIME_WINDOWS = {
  "15s": 15_000,
  "1m": 60_000,
  "5m": 300_000,
  All: Number.POSITIVE_INFINITY,
} as const;

type WindowKey = keyof typeof TIME_WINDOWS;
type SamplesByDut = Record<DutId, Sample[]>;
type RangesByDut = Record<DutId, WindowKey>;

const MAX_SAMPLES_PER_DUT = 57_600;
const MAX_DRAW_POINTS = 1_000;
const ADC_Y_MIN = 0;
const ADC_Y_MAX = 65_535;
const ADC_Y_TICKS = [65_535, 49_152, 32_768, 16_384, 0];

const DEFAULT_CODE = `from machine import Pin, ADC
from time import sleep_ms

# Four source pins: D4, D5, D6, D7.
# They begin in high-impedance mode so no DUT is energized.
sources = (
    Pin(6, Pin.IN),
    Pin(7, Pin.IN),
    Pin(0, Pin.IN),
    Pin(1, Pin.IN),
)

# Four ADC inputs: D0, D1, D2, D3.
# Their internal pull-downs can remain enabled at the same time.
adc_pins = (
    Pin(26, Pin.IN, Pin.PULL_DOWN),
    Pin(27, Pin.IN, Pin.PULL_DOWN),
    Pin(28, Pin.IN, Pin.PULL_DOWN),
    Pin(29, Pin.IN, Pin.PULL_DOWN),
)

# Use channel numbers so ADC() does not replace the pin configuration.
adcs = (
    ADC(0),
    ADC(1),
    ADC(2),
    ADC(3),
)

monitoring = True

try:
    # Stop monitor sends Ctrl-C to interrupt this loop.
    while monitoring:
        values = []

        # Energize and read only one DUT at a time.
        for source, adc in zip(sources, adcs):
            source.init(Pin.OUT, value=1)
            sleep_ms(5)

            # Average 10 hardware readings into one plotted value.
            total = 0
            for _ in range(10):
                total += adc.read_u16()

            values.append(total // 10)
            source.init(Pin.IN)

        print("DATA,{},{},{},{}".format(
            values[0],
            values[1],
            values[2],
            values[3],
        ))

        sleep_ms(500)
finally:
    # Always release every source after Stop or an error.
    for source in sources:
        source.init(Pin.IN)`;

function emptySamples(): SamplesByDut {
  return { DUT1: [], DUT2: [], DUT3: [], DUT4: [] };
}

function initialRanges(): RangesByDut {
  return { DUT1: "1m", DUT2: "1m", DUT3: "1m", DUT4: "1m" };
}

function formatReading(value: number | null) {
  return value === null ? "—" : Math.round(value).toLocaleString();
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    minute: "2-digit",
    second: "2-digit",
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downsample(samples: Sample[], limit: number) {
  if (samples.length <= limit) return samples;
  const step = (samples.length - 1) / (limit - 1);
  return Array.from(
    { length: limit },
    (_, index) => samples[Math.round(index * step)],
  );
}

function GraphCard({
  dut,
  samples,
  range,
  clockTime,
  connected,
  running,
  onRangeChange,
  onDownload,
  onClear,
}: {
  dut: DutDefinition;
  samples: Sample[];
  range: WindowKey;
  clockTime: number;
  connected: boolean;
  running: boolean;
  onRangeChange: (range: WindowKey) => void;
  onDownload: () => void;
  onClear: () => void;
}) {
  const visibleSamples = useMemo(() => {
    const duration = TIME_WINDOWS[range];
    if (!Number.isFinite(duration)) return samples;
    const cutoff = clockTime - duration;
    return samples.filter((sample) => sample.time >= cutoff);
  }, [clockTime, range, samples]);

  const stats = useMemo(() => {
    if (!visibleSamples.length) {
      return { current: null, average: null, min: null, max: null, rate: 0 };
    }
    const values = visibleSamples.map((sample) => sample.value);
    const elapsed =
      visibleSamples.length > 1
        ? visibleSamples[visibleSamples.length - 1].time -
          visibleSamples[0].time
        : 0;
    return {
      current: values[values.length - 1],
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      rate: elapsed > 0 ? ((values.length - 1) * 1000) / elapsed : 0,
    };
  }, [visibleSamples]);

  const chart = useMemo(() => {
    const width = 1_000;
    const height = 330;
    const padding = { top: 20, right: 18, bottom: 34, left: 64 };

    if (!visibleSamples.length) {
      return {
        line: "",
        area: "",
        latest: null as { x: number; y: number } | null,
        yTicks: ADC_Y_TICKS,
        xLabels: [] as { x: number; label: string }[],
      };
    }

    const duration = TIME_WINDOWS[range];
    const firstTime = Number.isFinite(duration)
      ? clockTime - duration
      : visibleSamples[0].time;
    const lastTime = Number.isFinite(duration)
      ? clockTime
      : visibleSamples[visibleSamples.length - 1].time;
    const timeSpan = Math.max(lastTime - firstTime, 1);
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const drawableSamples = downsample(visibleSamples, MAX_DRAW_POINTS);

    const points = drawableSamples.map((sample) => ({
      x: padding.left + ((sample.time - firstTime) / timeSpan) * innerWidth,
      y:
        padding.top +
        (1 - (sample.value - ADC_Y_MIN) / (ADC_Y_MAX - ADC_Y_MIN)) *
          innerHeight,
    }));
    const line = points
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`,
      )
      .join(" ");
    const bottom = height - padding.bottom;
    const area = `${line} L${points[points.length - 1].x.toFixed(2)},${bottom} L${points[0].x.toFixed(2)},${bottom} Z`;
    const xLabels = Array.from({ length: 4 }, (_, index) => {
      const ratio = index / 3;
      return {
        x: padding.left + ratio * innerWidth,
        label: formatTime(firstTime + ratio * timeSpan),
      };
    });

    return {
      line,
      area,
      latest: points[points.length - 1],
      yTicks: ADC_Y_TICKS,
      xLabels,
    };
  }, [clockTime, range, visibleSamples]);

  return (
    <article className="chart-card dut-chart-card">
      <div className="card-header">
        <div>
          <div className="card-title-row">
            <span className="dut-number">{dut.label.slice(-1)}</span>
            <h2>{dut.label} signal</h2>
            <span className={`live-badge ${running ? "on" : ""}`}>
              <i />
              {running ? "LIVE" : connected ? "READY" : "IDLE"}
            </span>
          </div>
          <p>
            10-read average · fixed 0–65,535 scale · {dut.input} · source{" "}
            {dut.source}
          </p>
        </div>
        <div className="chart-tools">
          <div className="range-picker" aria-label={`${dut.label} graph time range`}>
            {(Object.keys(TIME_WINDOWS) as WindowKey[]).map((key) => (
              <button
                key={key}
                className={range === key ? "selected" : ""}
                onClick={() => onRangeChange(key)}
              >
                {key}
              </button>
            ))}
          </div>
          <button
            className="icon-button"
            onClick={onDownload}
            aria-label="Download all DUT readings as CSV"
            title="Download CSV"
          >
            ⇩
          </button>
          <button
            className="icon-button"
            onClick={onClear}
            aria-label="Clear all graphs"
            title="Clear all graphs"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="chart-wrap">
        {!visibleSamples.length && (
          <div className="empty-chart">
            <div className="empty-pulse">⌁</div>
            <strong>
              {connected
                ? running
                  ? `Waiting for ${dut.label} values`
                  : "XIAO connected and ready"
                : "Waiting for a signal"}
            </strong>
            <p>
              {connected
                ? running
                  ? "Watch the debug console for the four-channel DATA record."
                  : "Click Run monitor to start all four DUTs."
                : "Connect your XIAO to begin."}
            </p>
          </div>
        )}
        <svg
          className="signal-chart"
          viewBox="0 0 1000 330"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${dut.label} ADC chart with ${visibleSamples.length} readings`}
        >
          <defs>
            <linearGradient
              id={`signalArea-${dut.id}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor="#10a37f" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#10a37f" stopOpacity="0" />
            </linearGradient>
          </defs>
          {chart.yTicks.map((tick, index) => {
            const y = 20 + (index / 4) * 276;
            return (
              <g key={`${tick}-${index}`}>
                <line className="grid-line" x1="64" x2="982" y1={y} y2={y} />
                <text className="axis-label" x="53" y={y + 4}>
                  {Math.round(tick).toLocaleString()}
                </text>
              </g>
            );
          })}
          {chart.xLabels.map((label) => (
            <text
              className="x-label"
              key={`${label.x}-${label.label}`}
              x={label.x}
              y="322"
            >
              {label.label}
            </text>
          ))}
          {chart.area && (
            <path
              className="signal-area"
              style={{ fill: `url(#signalArea-${dut.id})` }}
              d={chart.area}
            />
          )}
          {chart.line && <path className="signal-line" d={chart.line} />}
          {chart.latest && (
            <circle
              className="signal-point"
              cx={chart.latest.x}
              cy={chart.latest.y}
              r="4"
            />
          )}
        </svg>
      </div>

      <div className="stat-grid">
        <div className="stat primary-stat">
          <span>Current</span>
          <strong>{formatReading(stats.current)}</strong>
          <small>ADC units</small>
        </div>
        <div className="stat">
          <span>Average</span>
          <strong>{formatReading(stats.average)}</strong>
          <small>visible range</small>
        </div>
        <div className="stat">
          <span>Minimum</span>
          <strong>{formatReading(stats.min)}</strong>
          <small>visible range</small>
        </div>
        <div className="stat">
          <span>Maximum</span>
          <strong>{formatReading(stats.max)}</strong>
          <small>visible range</small>
        </div>
        <div className="stat">
          <span>Sample rate</span>
          <strong>{stats.rate ? stats.rate.toFixed(1) : "—"}</strong>
          <small>samples/sec</small>
        </div>
      </div>
    </article>
  );
}

export default function Home() {
  const [samplesByDut, setSamplesByDut] =
    useState<SamplesByDut>(emptySamples);
  const [rangesByDut, setRangesByDut] =
    useState<RangesByDut>(initialRanges);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [clockTime, setClockTime] = useState(Date.now());
  const [serialLog, setSerialLog] = useState<string[]>([
    "[system] Four-DUT debug console ready. Connect a XIAO to begin.",
  ]);
  const [showGuide, setShowGuide] = useState(false);

  const portRef = useRef<SerialPortLike | null>(null);
  const readerRef =
    useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const runningRef = useRef(false);
  const readBufferRef = useRef("");
  const sessionStartRef = useRef(Date.now());
  const debugEndRef = useRef<HTMLDivElement | null>(null);

  const serialSupported =
    typeof navigator !== "undefined" &&
    Boolean((navigator as SerialNavigator).serial);

  const totalSamples = DUTS.reduce(
    (total, dut) => total + samplesByDut[dut.id].length,
    0,
  );

  useEffect(() => {
    debugEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [serialLog]);

  useEffect(() => {
    if (!running) return;
    const clockTimer = setInterval(() => setClockTime(Date.now()), 500);
    return () => clearInterval(clockTimer);
  }, [running]);

  useEffect(() => {
    return () => {
      runningRef.current = false;
      readerRef.current?.cancel().catch(() => undefined);
      portRef.current?.close().catch(() => undefined);
    };
  }, []);

  function appendLog(message: string) {
    const now = new Date();
    const clock = now.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const milliseconds = now.getMilliseconds().toString().padStart(3, "0");
    setSerialLog((current) => [
      ...current.slice(-119),
      `[${clock}.${milliseconds}] ${message}`,
    ]);
  }

  function addScan(values: number[]) {
    if (
      values.length !== DUTS.length ||
      values.some(
        (value) => !Number.isFinite(value) || value < 0 || value > 65_535,
      )
    ) {
      appendLog("ERROR  Rejected malformed four-DUT DATA record.");
      return;
    }
    const time = Date.now();
    setSamplesByDut((current) => {
      const next = { ...current };
      DUTS.forEach((dut, index) => {
        next[dut.id] = [
          ...current[dut.id].slice(-(MAX_SAMPLES_PER_DUT - 1)),
          { value: values[index], time },
        ];
      });
      return next;
    });
  }

  async function readSerial(port: SerialPortLike) {
    const decoder = new TextDecoder();
    while (port.readable && portRef.current === port) {
      const reader = port.readable.getReader();
      readerRef.current = reader;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          readBufferRef.current += decoder.decode(value, { stream: true });
          const lines = readBufferRef.current.split(/\r?\n/);
          readBufferRef.current = lines.pop() ?? "";
          for (const rawLine of lines) {
            const line = rawLine.replace(/[\x00-\x1f>]/g, "").trim();
            if (!line) continue;
            const parsed = parseDataRecord(line);
            if (parsed.kind === "valid") {
              if (runningRef.current) addScan(parsed.values);
              appendLog(`RX  ${parsed.record}`);
            } else if (parsed.kind === "invalid") {
              appendLog(`ERROR  Malformed record: ${parsed.record.slice(0, 160)}`);
            } else if (!line.includes("raw REPL")) {
              appendLog(`RX  ${line.slice(0, 160)}`);
            }
          }
        }
      } catch {
        if (portRef.current === port) {
          appendLog("ERROR  Serial stream paused.");
        }
      } finally {
        reader.releaseLock();
        readerRef.current = null;
      }
    }
  }

  async function writeSerial(data: string) {
    const port = portRef.current;
    if (!port?.writable) throw new Error("Connect your XIAO first.");
    const writer = port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(data));
    } finally {
      writer.releaseLock();
    }
  }

  async function connectDevice() {
    if (connected) {
      await stopProgram();
      const port = portRef.current;
      portRef.current = null;
      await readerRef.current?.cancel().catch(() => undefined);
      await port?.close().catch(() => undefined);
      setConnected(false);
      appendLog("PORT  XIAO disconnected.");
      return;
    }

    if (!serialSupported) {
      appendLog("ERROR  Web Serial needs Chrome or Edge.");
      setShowGuide(true);
      return;
    }

    setConnecting(true);
    try {
      const serial = (navigator as SerialNavigator).serial;
      if (!serial) throw new Error("Web Serial is unavailable.");
      const port = await serial.requestPort();
      await port.open({ baudRate: 115_200 });
      portRef.current = port;
      sessionStartRef.current = Date.now();
      setConnected(true);
      appendLog("PORT  Connected at 115200 baud.");
      void readSerial(port);
    } catch (error) {
      appendLog(
        `ERROR  ${error instanceof Error ? error.message : "Could not connect to XIAO."}`,
      );
    } finally {
      setConnecting(false);
    }
  }

  async function runCode() {
    if (!portRef.current) {
      appendLog("ERROR  Connect your XIAO before running the monitor.");
      return;
    }

    setClockTime(Date.now());
    runningRef.current = true;
    setRunning(true);
    appendLog("TX  Interrupting the current MicroPython program.");
    try {
      await writeSerial("\r\u0003\u0003");
      await delay(120);
      appendLog("TX  Entering raw REPL.");
      await writeSerial("\u0001");
      await delay(120);
      await writeSerial(`${DEFAULT_CODE.replace(/\r\n/g, "\n")}\u0004`);
      appendLog("TX  Four-DUT monitor sent. Waiting for DATA records.");
    } catch (error) {
      runningRef.current = false;
      setRunning(false);
      appendLog(
        `ERROR  ${error instanceof Error ? error.message : "Could not run code."}`,
      );
    }
  }

  async function stopProgram() {
    runningRef.current = false;
    setClockTime(Date.now());
    setRunning(false);
    if (!portRef.current) return;
    try {
      await writeSerial("\u0003");
      await delay(80);
      await writeSerial("\u0002");
      appendLog("TX  Program stopped; all source pins released.");
    } catch {
      appendLog("ERROR  Could not stop the program.");
    }
  }

  function clearSamples() {
    setSamplesByDut(emptySamples());
    sessionStartRef.current = Date.now();
    appendLog("SYSTEM  All four graphs cleared.");
  }

  function changeRange(dut: DutId, range: WindowKey) {
    setRangesByDut((current) => ({ ...current, [dut]: range }));
  }

  function downloadCsv() {
    if (!totalSamples) {
      appendLog("SYSTEM  No samples to export yet.");
      return;
    }
    const rows = ["timestamp_iso,elapsed_ms,dut,adc_value"];
    const longest = Math.max(
      ...DUTS.map((dut) => samplesByDut[dut.id].length),
    );
    for (let index = 0; index < longest; index += 1) {
      for (const dut of DUTS) {
        const sample = samplesByDut[dut.id][index];
        if (!sample) continue;
        rows.push(
          `${new Date(sample.time).toISOString()},${sample.time - sessionStartRef.current},${dut.id},${sample.value}`,
        );
      }
    }
    const blob = new Blob([rows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `xiao-four-dut-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/:/g, "-")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    appendLog(`SYSTEM  Exported ${totalSamples.toLocaleString()} samples.`);
  }

  async function copyDebugLog() {
    try {
      await navigator.clipboard.writeText(serialLog.join("\n"));
      appendLog("SYSTEM  Debug log copied to clipboard.");
    } catch {
      appendLog("ERROR  Clipboard access was denied.");
    }
  }

  const statusText = connected
    ? running
      ? "Streaming 4 DUTs"
      : "Connected"
    : "No device";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">X</span>
          <span>XIAO Lab</span>
        </div>

        <button className="new-session" onClick={clearSamples}>
          <span>＋</span>
          New session
        </button>

        <nav className="side-nav" aria-label="Lab navigation">
          <button className="nav-item active">
            <span className="nav-icon">⌁</span>
            Four-DUT monitor
          </button>
          <button className="nav-item" onClick={() => setShowGuide(true)}>
            <span className="nav-icon">⌘</span>
            Wiring guide
          </button>
          <button
            className="nav-item"
            onClick={() =>
              document.querySelector(".debug-console")?.scrollIntoView({
                behavior: "smooth",
              })
            }
          >
            <span className="nav-icon">›_</span>
            Debug console
          </button>
        </nav>

        <div className="history">
          <p className="eyebrow">This session</p>
          <div className="history-item">
            <span className="history-dot" />
            <div>
              <strong>Four-DUT ADC test</strong>
              <small>{totalSamples.toLocaleString()} readings</small>
            </div>
          </div>
        </div>

        <div className="local-note">
          <span className="shield">✓</span>
          <div>
            <strong>Local by design</strong>
            <p>Your serial data stays in this browser.</p>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="mobile-brand">
            <span className="brand-mark">X</span>
            XIAO Lab
          </div>
          <div className="breadcrumb">
            <span>Devices</span>
            <b>/</b>
            <strong>Four-DUT ADC</strong>
          </div>
          <div className={`connection-pill ${connected ? "online" : ""}`}>
            <span />
            {statusText}
          </div>
        </header>

        <div className="workspace-scroll">
          <section className="hero-row">
            <div>
              <p className="overline">SEEED STUDIO XIAO RP2040 · 4 CHANNELS</p>
              <h1>Four-DUT ADC monitor</h1>
              <p className="subtitle">
                Scan four independent DUTs and compare their raw signals in real time.
              </p>
            </div>
            <div className="hero-actions">
              <button
                className={`button run-monitor ${running ? "stop-monitor" : ""}`}
                onClick={running ? stopProgram : runCode}
                disabled={!connected}
              >
                <span className="button-icon">{running ? "■" : "▶"}</span>
                {running ? "Stop monitor" : "Run all four"}
              </button>
              <button
                className={`button primary ${connected ? "connected" : ""}`}
                onClick={connectDevice}
                disabled={connecting}
              >
                <span className="button-icon">{connected ? "✓" : "⌁"}</span>
                {connecting
                  ? "Connecting…"
                  : connected
                    ? "Disconnect"
                    : "Connect XIAO"}
              </button>
            </div>
          </section>

          {!serialSupported && (
            <div className="browser-notice">
              <span>i</span>
              <p>
                Web Serial is unavailable in this browser. Open the site in
                Chrome or Edge to connect your XIAO.
              </p>
              <button onClick={() => setShowGuide(true)}>View wiring</button>
            </div>
          )}

          <div className="content-grid">
            <section className="monitor-column">
              <div className="graph-grid">
                {DUTS.map((dut) => (
                  <GraphCard
                    key={dut.id}
                    dut={dut}
                    samples={samplesByDut[dut.id]}
                    range={rangesByDut[dut.id]}
                    clockTime={clockTime}
                    connected={connected}
                    running={running}
                    onRangeChange={(range) => changeRange(dut.id, range)}
                    onDownload={downloadCsv}
                    onClear={clearSamples}
                  />
                ))}
              </div>

              <article
                className={`serial-card debug-console ${debugOpen ? "" : "collapsed"}`}
              >
                <div className="serial-head">
                  <div>
                    <span className="terminal-icon">›_</span>
                    <strong>Debug console</strong>
                    <small>115200 baud</small>
                  </div>
                  <div className="debug-actions">
                    <span>{totalSamples.toLocaleString()} samples captured</span>
                    <button onClick={copyDebugLog}>Copy</button>
                    <button onClick={() => setSerialLog([])}>Clear</button>
                    <button
                      className="collapse-debug"
                      onClick={() => setDebugOpen((current) => !current)}
                      aria-expanded={debugOpen}
                    >
                      {debugOpen ? "Hide" : "Show"}
                      <span>{debugOpen ? "⌃" : "⌄"}</span>
                    </button>
                  </div>
                </div>
                {debugOpen && (
                  <>
                    <div className="debug-status">
                      <span>
                        <b className={connected ? "status-on" : ""} />
                        Port: {connected ? "open" : "closed"}
                      </span>
                      <span>Mode: {running ? "four-channel scan" : "idle"}</span>
                      <span>Parser: DATA,dut1,dut2,dut3,dut4</span>
                      <span>Retention: 8 hours / DUT</span>
                    </div>
                    <div className="terminal-lines">
                      {serialLog.map((line, index) => (
                        <p
                          className={
                            line.includes("ERROR")
                              ? "log-error"
                              : line.includes(" RX ")
                                ? "log-rx"
                                : line.includes(" TX ")
                                  ? "log-tx"
                                  : ""
                          }
                          key={`${line}-${index}`}
                        >
                          <span>{index === serialLog.length - 1 ? "›" : "·"}</span>
                          {line}
                        </p>
                      ))}
                      {!serialLog.length && (
                        <p className="log-empty">Debug log cleared.</p>
                      )}
                      <div ref={debugEndRef} />
                    </div>
                  </>
                )}
              </article>
            </section>
          </div>
        </div>
      </main>

      {showGuide && (
        <div className="modal-backdrop" onMouseDown={() => setShowGuide(false)}>
          <section
            className="guide-modal wiring-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="guide-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close"
              onClick={() => setShowGuide(false)}
              aria-label="Close wiring guide"
            >
              ×
            </button>
            <p className="overline">XIAO RP2040 WIRING</p>
            <h2 id="guide-title">Connect four DUTs</h2>
            <p className="wiring-intro">
              Use one 1 kΩ series resistor per passive, isolated DUT. No
              external pull-down is needed: the scanner enables the XIAO
              RP2040&apos;s internal pull-down on D0–D3.
            </p>

            <div className="wiring-table" role="table" aria-label="Four-DUT wiring">
              <div className="wiring-row wiring-header" role="row">
                <span>DUT</span>
                <span>Source path</span>
                <span>ADC node</span>
              </div>
              {DUTS.map((dut) => (
                <div className="wiring-row" role="row" key={dut.id}>
                  <strong>{dut.label}</strong>
                  <span>{dut.source} → 1 kΩ → DUT</span>
                  <span>{dut.input} · internal pull-down</span>
                </div>
              ))}
            </div>

            <div className="wiring-diagram">
              <code>source GPIO ── 1 kΩ ── DUT ── ADC input</code>
              <code>ADC input: Pin.IN + Pin.PULL_DOWN (inside RP2040)</code>
            </div>

            <div className="wiring-warning">
              <strong>3.3 V passive DUTs only</strong>
              <p>
                DUTs must be passive and isolated. Never connect an externally
                powered signal or more than 3.3 V to D0–D3. The internal
                pull-down is not a precision resistor, so the graphs show raw
                comparative ADC readings.
              </p>
            </div>

            <ol className="compact-steps">
              <li>
                <span>1</span>
                <div>
                  <strong>Flash MicroPython</strong>
                  <p>Install a compatible XIAO RP2040 MicroPython build.</p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <strong>Connect in Chrome or Edge</strong>
                  <p>Select the XIAO USB serial port, then run all four DUTs.</p>
                </div>
              </li>
            </ol>

            <button
              className="button primary modal-action"
              onClick={() => {
                setShowGuide(false);
                void connectDevice();
              }}
            >
              Connect XIAO
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
