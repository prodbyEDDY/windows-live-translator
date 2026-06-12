import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialogBackdrop,
  AlertDialogBody,
  AlertDialogContainer,
  AlertDialogDialog,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogHeading,
  AlertDialogRoot,
  AlertDialogTrigger,
  Button,
  Spinner,
  Tab,
  TabIndicator,
  TabList,
  TabPanel,
  TabsRoot,
} from "@heroui/react";
import { ipc, type CallRecord, type VoiceRecord } from "../lib/ipc";
import { TranscriptFeed } from "../components/TranscriptFeed";
import { VoiceCard } from "../components/VoiceCard";
import { Banner } from "../components/Banner";
import { LangPairPill } from "../components/LangPairPill";
import { IconSearch } from "../components/Icons";
import { previewText } from "../lib/history";
import { useAppStore } from "../stores/app";
import { formatDuration, localeFor } from "../lib/format";
import type { TranscriptLine } from "../lib/transcript";

function formatDate(iso: string, lang: string | undefined): string {
  const d = new Date(iso);
  return d.toLocaleString(localeFor(lang), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function HistoryScreen() {
  const { t, i18n } = useTranslation();

  const [tab, setTab] = useState<"calls" | "voice">("calls");
  const [clearedToast, setClearedToast] = useState(false);
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [callsLoading, setCallsLoading] = useState(false);
  const [voiceRecords, setVoiceRecords] = useState<VoiceRecord[]>([]);
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [expandedCallIds, setExpandedCallIds] = useState<Set<number>>(new Set());
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  // Cache of FULL call records fetched lazily on expand (list_calls truncates
  // transcript_json to ~4000 chars for previews, so we re-fetch on demand).
  const [fullCalls, setFullCalls] = useState<Map<number, CallRecord>>(new Map());
  const [loadingCallIds, setLoadingCallIds] = useState<Set<number>>(new Set());

  const clearStoreVoice = useCallback(() => {
    useAppStore.setState({ voiceMessages: [] });
  }, []);

  const loadCalls = useCallback(async (q?: string) => {
    setCallsLoading(true);
    try {
      const data = await ipc.historyListCalls(q);
      setCalls(data);
    } finally {
      setCallsLoading(false);
    }
  }, []);

  const loadVoice = useCallback(async (q?: string) => {
    setVoiceLoading(true);
    try {
      const data = await ipc.historyListVoice(q);
      setVoiceRecords(data);
    } finally {
      setVoiceLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCalls(search || undefined);
    void loadVoice(search || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === "calls") void loadCalls(search || undefined);
    else void loadVoice(search || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Clear the pending search debounce on unmount so it can't fire a setState
  // (loadCalls/loadVoice) on an unmounted component.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function handleSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void loadCalls(value || undefined);
      void loadVoice(value || undefined);
    }, 300);
  }

  const fetchFullCall = useCallback(
    async (id: number) => {
      setLoadingCallIds((prev) => new Set(prev).add(id));
      try {
        const rec = await ipc.historyGetCall(id);
        if (rec) {
          setFullCalls((prev) => new Map(prev).set(id, rec));
        }
      } catch {
        /* best-effort: fall back to the truncated preview record */
      } finally {
        setLoadingCallIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    []
  );

  function toggleCall(id: number) {
    setExpandedCallIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // Lazily fetch the full record (untruncated transcript) on first expand.
        if (!fullCalls.has(id) && !loadingCallIds.has(id)) {
          void fetchFullCall(id);
        }
      }
      return next;
    });
  }

  function parseTranscriptLines(json: string): TranscriptLine[] {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) return parsed as TranscriptLine[];
    } catch {
      /* fall through */
    }
    return [];
  }

  async function handleClearHistory() {
    setClearDialogOpen(false);
    try {
      await ipc.historyClear();
    } catch {
      /* best-effort */
    }
    clearStoreVoice();
    setCalls([]);
    setVoiceRecords([]);
    setExpandedCallIds(new Set());
    setFullCalls(new Map());
    setLoadingCallIds(new Set());
    // Inline success feedback (auto-hides) so the clear isn't silent.
    setClearedToast(true);
    setTimeout(() => setClearedToast(false), 2500);
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 w-full max-w-[920px] mx-auto px-6 py-6 flex flex-col gap-4 lt-screen-in">
        {/* ---- Title + search + clear ---- */}
        <div className="flex items-center gap-3 shrink-0 min-h-9">
          <h1 className="font-display text-[22px] font-semibold tracking-tight text-ink leading-none shrink-0">
            {t("screen.history")}
          </h1>
          <div className="flex-1" />
          {/* Search pill */}
          <div className="relative w-56">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">
              <IconSearch size={15} />
            </span>
            <input
              type="search"
              placeholder={t("history.searchPlaceholder")}
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full h-9 pl-9 pr-3 rounded-pill border border-hairline bg-surface text-[13px] text-ink placeholder:text-muted focus:border-cobalt/50 outline-none transition-colors"
            />
          </div>

          <AlertDialogRoot
            isOpen={clearDialogOpen}
            onOpenChange={(open) => {
              if (!open) setClearDialogOpen(false);
            }}
          >
            <AlertDialogTrigger>
              <button
                onClick={() => setClearDialogOpen(true)}
                className="lt-press shrink-0 px-3.5 h-9 rounded-pill border border-danger/40 text-[12px] text-danger hover:bg-danger/5"
              >
                {t("history.clearHistory")}
              </button>
            </AlertDialogTrigger>
            <AlertDialogBackdrop isDismissable>
              <AlertDialogContainer>
                <AlertDialogDialog>
                  <AlertDialogHeader>
                    <AlertDialogHeading>
                      {t("history.confirmClearTitle")}
                    </AlertDialogHeading>
                  </AlertDialogHeader>
                  <AlertDialogBody>
                    <p className="text-sm text-muted">{t("history.confirmClearBody")}</p>
                  </AlertDialogBody>
                  <AlertDialogFooter>
                    <Button
                      variant="outline"
                      size="sm"
                      onPress={() => setClearDialogOpen(false)}
                    >
                      {t("common.cancel")}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onPress={() => void handleClearHistory()}
                    >
                      {t("history.confirmClearOk")}
                    </Button>
                  </AlertDialogFooter>
                </AlertDialogDialog>
              </AlertDialogContainer>
            </AlertDialogBackdrop>
          </AlertDialogRoot>
        </div>

        {/* ---- Clear success feedback (auto-hides) ---- */}
        {clearedToast && (
          <div className="shrink-0">
            <Banner
              tone="ok"
              description={t("history.cleared")}
              onDismiss={() => setClearedToast(false)}
            />
          </div>
        )}

        {/* ---- Tabs ---- */}
        <TabsRoot
          selectedKey={tab}
          onSelectionChange={(key) => setTab(key as "calls" | "voice")}
          className="flex flex-col flex-1 min-h-0"
        >
          <TabList className="flex justify-start gap-6 p-0 bg-transparent border-b border-hairline rounded-none shrink-0">
            {/* TabIndicator MUST live INSIDE a Tab. */}
            <Tab
              id="calls"
              className="relative flex-none w-auto px-0 pb-2.5 bg-transparent text-[13px] font-medium text-muted data-[selected]:text-ink data-[selected]:bg-transparent cursor-pointer rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-cobalt focus-visible:outline-offset-2"
            >
              {t("history.tabCalls")}
              <TabIndicator className="absolute -bottom-px left-0 right-0 h-[2px] rounded-full bg-cobalt" />
            </Tab>
            <Tab
              id="voice"
              className="relative flex-none w-auto px-0 pb-2.5 bg-transparent text-[13px] font-medium text-muted data-[selected]:text-ink data-[selected]:bg-transparent cursor-pointer rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-cobalt focus-visible:outline-offset-2"
            >
              {t("history.tabVoice")}
              <TabIndicator className="absolute -bottom-px left-0 right-0 h-[2px] rounded-full bg-cobalt" />
            </Tab>
          </TabList>

          {/* ---- Calls ---- */}
          <TabPanel id="calls" className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 pt-3">
            {callsLoading ? (
              <Loading t={t} />
            ) : calls.length === 0 ? (
              <Empty>{t("history.emptyCalls")}</Empty>
            ) : (
              <div className="flex flex-col gap-2">
                {calls.map((call) => {
                  const expanded = expandedCallIds.has(call.id);
                  const preview = previewText(call.transcriptJson, 90);
                  const fullCall = fullCalls.get(call.id);
                  const isLoadingFull = loadingCallIds.has(call.id);
                  // Prefer the full (untruncated) record once fetched; the
                  // preview record's transcript_json is capped at ~4000 chars.
                  const lines =
                    expanded && fullCall
                      ? parseTranscriptLines(fullCall.transcriptJson)
                      : [];

                  return (
                    <div
                      key={call.id}
                      className="bg-surface border border-hairline rounded-card lt-card overflow-hidden"
                    >
                      <button
                        className="flex items-center gap-3 h-11 px-4 text-left hover:bg-stone-50 transition-colors w-full"
                        onClick={() => toggleCall(call.id)}
                        aria-expanded={expanded}
                      >
                        <span
                          aria-hidden="true"
                          className="text-[11px] text-stone-500 shrink-0 select-none w-3"
                        >
                          {expanded ? "▼" : "▶"}
                        </span>
                        <span className="font-mono text-[12px] text-muted shrink-0 tabular-nums">
                          {formatDate(call.startedAt, i18n.language)}
                        </span>
                        <LangPairPill from={call.myLang} to={call.peerLang} />
                        {preview && !expanded && (
                          <span className="text-[13px] text-muted truncate flex-1 min-w-0">
                            {preview}
                          </span>
                        )}
                        <span className="font-mono text-[12px] text-ink tabular-nums ml-auto shrink-0">
                          {formatDuration(call.durationSecs)}
                        </span>
                      </button>

                      {expanded && (
                        <div
                          className="border-t border-hairline bg-paper"
                          style={{ minHeight: 120, maxHeight: 380, display: "flex", flexDirection: "column" }}
                        >
                          {isLoadingFull && !fullCall ? (
                            <div className="flex items-center justify-center gap-2 p-4 text-muted text-xs">
                              <Spinner size="sm" />
                              <span>{t("history.loading")}</span>
                            </div>
                          ) : lines.length > 0 ? (
                            <TranscriptFeed lines={lines} />
                          ) : (
                            <div className="flex items-center justify-center p-4 text-muted text-xs">
                              —
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </TabPanel>

          {/* ---- Voice ---- */}
          <TabPanel id="voice" className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1 pt-3">
            {voiceLoading ? (
              <Loading t={t} />
            ) : voiceRecords.length === 0 ? (
              <Empty>{t("history.emptyVoice")}</Empty>
            ) : (
              <div className="flex flex-col gap-3">
                {voiceRecords.map((rec) => (
                  <VoiceCard key={rec.id} record={rec} />
                ))}
              </div>
            )}
          </TabPanel>
        </TabsRoot>
      </div>
    </div>
  );
}

function Loading({ t }: { t: (k: string) => string }) {
  return (
    <div className="flex items-center justify-center p-8">
      <Spinner size="sm" />
      <span className="ml-2 text-sm text-muted">{t("history.loading")}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 p-12 text-center">
      <span className="font-display text-[64px] leading-none text-stone-200">⌬</span>
      <p className="text-[13px] text-muted">{children}</p>
    </div>
  );
}
