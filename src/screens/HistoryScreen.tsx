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
  Input,
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
import { previewText } from "../lib/history";
import { useAppStore } from "../stores/app";
import type { TranscriptLine } from "../lib/transcript";

// ---- helpers ----

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---- main component ----

export function HistoryScreen() {
  const { t } = useTranslation();

  // Tab state
  const [tab, setTab] = useState<"calls" | "voice">("calls");

  // Search
  const [search, setSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Call records
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [callsLoading, setCallsLoading] = useState(false);

  // Voice records
  const [voiceRecords, setVoiceRecords] = useState<VoiceRecord[]>([]);
  const [voiceLoading, setVoiceLoading] = useState(false);

  // Expanded call rows (accordion state)
  const [expandedCallIds, setExpandedCallIds] = useState<Set<number>>(new Set());

  // Confirm-clear dialog open state (controlled manually for AlertDialog)
  const [clearDialogOpen, setClearDialogOpen] = useState(false);

  // We need to clear the store's voiceMessages after historyClear
  const clearStoreVoice = useCallback(() => {
    useAppStore.setState({ voiceMessages: [] });
  }, []);

  // Load call list
  const loadCalls = useCallback(async (q?: string) => {
    setCallsLoading(true);
    try {
      const data = await ipc.historyListCalls(q);
      setCalls(data);
    } finally {
      setCallsLoading(false);
    }
  }, []);

  // Load voice list
  const loadVoice = useCallback(async (q?: string) => {
    setVoiceLoading(true);
    try {
      const data = await ipc.historyListVoice(q);
      setVoiceRecords(data);
    } finally {
      setVoiceLoading(false);
    }
  }, []);

  // Load on mount and on tab switch
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

  // Debounced search
  function handleSearchChange(value: string) {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void loadCalls(value || undefined);
      void loadVoice(value || undefined);
    }, 300);
  }

  // Toggle call row expansion
  function toggleCall(id: number) {
    setExpandedCallIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Parse transcript JSON for a call row
  function parseTranscriptLines(json: string): TranscriptLine[] {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) return parsed as TranscriptLine[];
    } catch {
      // fall through
    }
    return [];
  }

  // Handle clear history
  async function handleClearHistory() {
    setClearDialogOpen(false);
    try {
      await ipc.historyClear();
    } catch {
      // best-effort
    }
    clearStoreVoice();
    setCalls([]);
    setVoiceRecords([]);
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* ---- Top bar: search + clear ---- */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 bg-white">
        <Input
          type="search"
          placeholder={t("history.searchPlaceholder")}
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="flex-1"
        />

        {/* Clear history button + confirm dialog */}
        <AlertDialogRoot
          isOpen={clearDialogOpen}
          onOpenChange={(open) => {
            if (!open) setClearDialogOpen(false);
          }}
        >
          <AlertDialogTrigger>
            <Button
              variant="outline"
              size="sm"
              className="text-red-600 border-red-300 hover:border-red-400 flex-shrink-0"
              onPress={() => setClearDialogOpen(true)}
            >
              {t("history.clearHistory")}
            </Button>
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
                  <p className="text-sm text-gray-600">
                    {t("history.confirmClearBody")}
                  </p>
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

      {/* ---- Tabs ---- */}
      <TabsRoot
        selectedKey={tab}
        onSelectionChange={(key) => setTab(key as "calls" | "voice")}
        className="flex flex-col flex-1 overflow-hidden"
      >
        <TabList className="px-4 pt-2 border-b border-gray-200 bg-white flex gap-1">
          <Tab id="calls">{t("history.tabCalls")}</Tab>
          <Tab id="voice">{t("history.tabVoice")}</Tab>
          <TabIndicator />
        </TabList>

        {/* ---- Calls tab ---- */}
        <TabPanel id="calls" className="flex-1 overflow-y-auto">
          {callsLoading ? (
            <div className="flex items-center justify-center p-8">
              <Spinner size="sm" />
              <span className="ml-2 text-sm text-gray-400">{t("history.loading")}</span>
            </div>
          ) : calls.length === 0 ? (
            <div className="flex items-center justify-center p-8 text-gray-400 text-sm">
              {t("history.emptyCalls")}
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-gray-100">
              {calls.map((call) => {
                const expanded = expandedCallIds.has(call.id);
                const preview = previewText(call.transcriptJson, 80);
                const lines = expanded ? parseTranscriptLines(call.transcriptJson) : [];

                return (
                  <div key={call.id} className="flex flex-col">
                    {/* Row header — clickable to expand */}
                    <button
                      className="flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors w-full"
                      onClick={() => toggleCall(call.id)}
                    >
                      {/* Expand icon */}
                      <span className="mt-0.5 text-xs text-gray-400 flex-shrink-0 select-none">
                        {expanded ? "▼" : "▶"}
                      </span>

                      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                        {/* Date + lang pair + duration */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-gray-500">
                            {formatDate(call.startedAt)}
                          </span>
                          <span className="text-xs font-medium text-gray-700">
                            {call.myLang}
                            {" "}
                            {t("history.langPairSeparator")}
                            {" "}
                            {call.peerLang}
                          </span>
                          <span className="text-xs text-gray-400 tabular-nums ml-auto">
                            {formatDuration(call.durationSecs)}
                          </span>
                        </div>

                        {/* Preview text */}
                        {preview && !expanded && (
                          <p className="text-sm text-gray-500 truncate">{preview}</p>
                        )}
                      </div>
                    </button>

                    {/* Expanded transcript */}
                    {expanded && (
                      <div className="border-t border-gray-100 bg-gray-50" style={{ minHeight: 120, maxHeight: 400, display: "flex", flexDirection: "column" }}>
                        {lines.length > 0 ? (
                          <TranscriptFeed lines={lines} />
                        ) : (
                          <div className="flex items-center justify-center p-4 text-gray-400 text-xs">
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

        {/* ---- Voice tab ---- */}
        <TabPanel id="voice" className="flex-1 overflow-y-auto">
          {voiceLoading ? (
            <div className="flex items-center justify-center p-8">
              <Spinner size="sm" />
              <span className="ml-2 text-sm text-gray-400">{t("history.loading")}</span>
            </div>
          ) : voiceRecords.length === 0 ? (
            <div className="flex items-center justify-center p-8 text-gray-400 text-sm">
              {t("history.emptyVoice")}
            </div>
          ) : (
            <div className="flex flex-col gap-3 p-4">
              {voiceRecords.map((rec) => (
                <VoiceCard key={rec.id} record={rec} />
              ))}
            </div>
          )}
        </TabPanel>
      </TabsRoot>
    </div>
  );
}
