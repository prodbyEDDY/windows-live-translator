import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@heroui/react";
import {
  ipc,
  type ElevenSelfTest,
  type GeminiSelfTest,
  type ProbeResult,
} from "../lib/ipc";
import { filterLogs, LEVELS, type LogEntry } from "../lib/logs";
import { Banner } from "../components/Banner";

/** Cap the live-streamed entries kept in component state (the backend ring +
 *  .jsonl remain the full record; `logsGet` re-seeds on remount). */
const UI_CAP = 3000;

const LEVEL_COLOR: Record<string, string> = {
  ERROR: "text-danger",
  WARN: "text-amber-600",
  INFO: "text-cobalt",
  DEBUG: "text-muted",
  TRACE: "text-muted",
};

export function LogsScreen() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [minLevel, setMinLevel] = useState<string>("TRACE");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [eleven, setEleven] = useState<ElevenSelfTest | null>(null);
  const [gemini, setGemini] = useState<GeminiSelfTest | null>(null);
  const [testing, setTesting] = useState<"" | "eleven" | "gemini">("");
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Seed from the ring snapshot, then live-append from the event.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    void ipc.logsGet().then((seed) => {
      if (mounted) setEntries((seed ?? []).slice(-UI_CAP));
    });
    void ipc
      .onLogEntry((e) => {
        setEntries((prev) =>
          prev.length >= UI_CAP ? [...prev.slice(1), e] : [...prev, e]
        );
      })
      .then((un) => {
        unlisten = un;
      });
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  // Auto-scroll to bottom while "follow" is on.
  useEffect(() => {
    if (follow && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, follow]);

  const visible = filterLogs(entries, { minLevel, query });

  const runEleven = useCallback(async () => {
    setTesting("eleven");
    try {
      setEleven(await ipc.elevenlabsSelfTest());
    } catch {
      /* the verdict card just won't update; the failure is itself logged */
    } finally {
      setTesting("");
    }
  }, []);

  const runGemini = useCallback(async () => {
    setTesting("gemini");
    try {
      setGemini(await ipc.geminiSelfTest());
    } catch {
      /* best-effort */
    } finally {
      setTesting("");
    }
  }, []);

  async function handleExport(format: "txt" | "json") {
    const path = await save({
      defaultPath: `live-translator-logs.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;
    await ipc.logsExport(path, format);
    setToast(t("logs.exported"));
    setTimeout(() => setToast(null), 2500);
  }

  async function handleOpenFolder() {
    const dir = await ipc.logsDir();
    if (dir) await revealItemInDir(dir);
  }

  function handleClear() {
    void ipc.logsClear();
    setEntries([]);
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 w-full max-w-[1100px] mx-auto px-6 py-7 flex flex-col gap-5 lt-screen-in">
        <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink leading-none shrink-0">
          {t("screen.logs")}
        </h1>

        {/* ---- Diagnostics card ---- */}
        <div className="shrink-0 rounded-card border border-hairline bg-surface p-4 flex flex-col gap-3">
          <h2 className="text-label font-semibold text-ink-2">{t("logs.diagnostics")}</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              isDisabled={testing !== ""}
              onPress={() => void runEleven()}
            >
              {testing === "eleven" ? t("logs.testing") : t("logs.testEleven")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              isDisabled={testing !== ""}
              onPress={() => void runGemini()}
            >
              {testing === "gemini" ? t("logs.testing") : t("logs.testGemini")}
            </Button>
          </div>
          {eleven && (
            <div className="text-caption font-mono text-ink-2 flex flex-col gap-1">
              <ProbeRow label={t("logs.validate")} probe={eleven.validate} t={t} />
              <ProbeRow label={t("logs.synth")} probe={eleven.synth} t={t} />
            </div>
          )}
          {gemini && (
            <div className="text-caption font-mono text-ink-2 flex flex-col gap-1">
              <ProbeRow label={t("logs.validate")} probe={gemini.validate} t={t} />
              <ProbeRow label={t("logs.tts")} probe={gemini.tts} t={t} />
            </div>
          )}
        </div>

        {/* ---- Toolbar ---- */}
        <div className="shrink-0 flex flex-wrap items-center gap-3">
          <select
            aria-label={t("logs.filterLevel")}
            value={minLevel}
            onChange={(e) => setMinLevel(e.target.value)}
            className="h-9 px-2 rounded-input border border-hairline bg-surface text-caption text-ink"
          >
            {[...LEVELS].reverse().map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
          <input
            type="search"
            placeholder={t("logs.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 min-w-[160px] h-9 px-3 rounded-input border border-hairline bg-surface text-caption text-ink placeholder:text-muted outline-none focus:border-cobalt/50"
          />
          <label className="flex items-center gap-1.5 text-caption text-muted select-none">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
            />
            {t("logs.follow")}
          </label>
          <Button size="sm" variant="outline" onPress={() => void handleExport("txt")}>
            {t("logs.export")} .txt
          </Button>
          <Button size="sm" variant="outline" onPress={() => void handleExport("json")}>
            {t("logs.export")} .json
          </Button>
          <Button size="sm" variant="outline" onPress={() => void handleOpenFolder()}>
            {t("logs.openFolder")}
          </Button>
          <Button size="sm" variant="outline" onPress={handleClear}>
            {t("logs.clear")}
          </Button>
        </div>

        {toast && (
          <div className="shrink-0">
            <Banner tone="ok" description={toast} onDismiss={() => setToast(null)} />
          </div>
        )}

        {/* ---- Console list ---- */}
        <div
          ref={scrollRef}
          onWheel={() => setFollow(false)}
          className="flex-1 min-h-0 overflow-y-auto rounded-card border border-hairline bg-paper p-3 font-mono text-code leading-relaxed"
        >
          {visible.length === 0 ? (
            <p className="text-muted text-caption p-4">{t("logs.empty")}</p>
          ) : (
            visible.map((e) => (
              <div
                key={e.seq}
                className="whitespace-pre-wrap break-words py-0.5 border-b border-hairline/40"
              >
                <span className="text-muted">{e.ts}</span>
                {"  "}
                <span className={LEVEL_COLOR[e.level.toUpperCase()] ?? "text-ink"}>
                  {e.level.padEnd(5)}
                </span>
                {"  "}
                <span className="text-ink-2">{e.target}</span>
                {"  "}
                <span className="text-ink">{e.message}</span>
                {Object.keys(e.fields).length > 0 && (
                  <span className="text-muted">
                    {"  | " +
                      Object.entries(e.fields)
                        .map(([k, v]) => `${k}=${String(v)}`)
                        .join(" ")}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function probeText(p: ProbeResult): string {
  const status = p.httpStatus != null ? `HTTP ${p.httpStatus} ` : "";
  const code = p.code ? `[${p.code}] ` : "";
  return `${status}${code}${p.detail}`;
}

function ProbeRow({
  label,
  probe,
  t,
}: {
  label: string;
  probe: ProbeResult;
  t: (k: string) => string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className={probe.ok ? "text-ok-deep" : "text-danger"}>{probe.ok ? "✓" : "✗"}</span>
      <span className="text-ink shrink-0">{label}:</span>
      <span className="text-muted">
        {probe.ok ? t("logs.pass") : t("logs.fail")} — {probeText(probe)}
      </span>
    </div>
  );
}
