import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../stores/app";
import { IconExternalLink, IconWaveform, IconMicMessage } from "../components/Icons";

const VB_CABLE_URL = "https://vb-audio.com/Cable/";

/** A help section: surface card with a quiet sentence-case heading. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bg-surface border border-hairline rounded-card lt-card p-6 flex flex-col gap-3">
      <h2 className="font-display text-emphasis font-semibold tracking-tight text-ink leading-snug">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** One step in a numbered flow: cobalt index chip + text. */
function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 inline-flex items-center justify-center w-6 h-6 shrink-0 rounded-full bg-cobalt-tint text-cobalt-deep font-mono text-label font-semibold tabular-nums">
        {n}
      </span>
      <span className="text-body text-ink-2 leading-relaxed">{children}</span>
    </li>
  );
}

export function HelpScreen() {
  const { t } = useTranslation();
  const setScreen = useAppStore((s) => s.setScreen);

  const quickSteps = t("help.quickStart.steps", { returnObjects: true }) as string[];
  const troubleItems = t("help.trouble.items", { returnObjects: true }) as Array<{
    q: string;
    a: string;
  }>;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="w-full max-w-[760px] mx-auto px-6 py-8 flex flex-col gap-6 lt-screen-in">
        <header className="flex flex-col gap-2">
          <h1 className="font-display text-h1 font-semibold tracking-tight text-ink leading-none">
            {t("help.title")}
          </h1>
          <p className="text-body text-muted leading-relaxed max-w-prose">
            {t("help.intro")}
          </p>
        </header>

        {/* How it works — the routing model */}
        <Section title={t("help.howItWorks.heading")}>
          <p className="text-body text-ink-2 leading-relaxed">
            {t("help.howItWorks.body")}
          </p>
          <div className="flex flex-col gap-2.5 mt-1">
            <div className="flex items-start gap-3 rounded-input bg-cobalt-tint/60 p-3.5">
              <IconWaveform size={18} className="mt-0.5 shrink-0 text-cobalt" />
              <p className="text-caption text-ink-2 leading-relaxed">
                {t("help.howItWorks.out")}
              </p>
            </div>
            <div className="flex items-start gap-3 rounded-input bg-surface-2 p-3.5">
              <IconMicMessage size={18} className="mt-0.5 shrink-0 text-ink-2" />
              <p className="text-caption text-ink-2 leading-relaxed">
                {t("help.howItWorks.in")}
              </p>
            </div>
          </div>
        </Section>

        {/* Quick start */}
        <Section title={t("help.quickStart.heading")}>
          <ol className="flex flex-col gap-3">
            {quickSteps.map((step, i) => (
              <Step key={i} n={i + 1}>
                {step}
              </Step>
            ))}
          </ol>
        </Section>

        {/* The critical Zoom/Meet mic step */}
        <Section title={t("help.micSetup.heading")}>
          <p className="text-body text-ink-2 leading-relaxed">
            {t("help.micSetup.body")}
          </p>
          <p className="text-caption text-muted leading-relaxed">
            {t("help.micSetup.note")}
          </p>
        </Section>

        {/* VB-CABLE */}
        <Section title={t("help.cable.heading")}>
          <p className="text-body text-ink-2 leading-relaxed">{t("help.cable.body")}</p>
          <div className="flex flex-wrap items-center gap-2.5 mt-1">
            <button
              onClick={() => void openUrl(VB_CABLE_URL)}
              className="lt-press inline-flex items-center gap-2 h-10 px-4 rounded-input bg-cobalt text-white text-body font-medium hover:bg-cobalt-deep"
            >
              <IconExternalLink size={16} />
              {t("help.cable.button")}
            </button>
            <button
              onClick={() => setScreen("wizard")}
              className="lt-press inline-flex items-center h-10 px-4 rounded-input border border-hairline text-body text-ink hover:border-hairline-strong"
            >
              {t("help.cable.wizard")}
            </button>
          </div>
        </Section>

        {/* Voice messages */}
        <Section title={t("help.voice.heading")}>
          <p className="text-body text-ink-2 leading-relaxed">{t("help.voice.body")}</p>
        </Section>

        {/* Troubleshooting */}
        <Section title={t("help.trouble.heading")}>
          <dl className="flex flex-col divide-y divide-hairline">
            {troubleItems.map((item, i) => (
              <div key={i} className="py-3 first:pt-0 last:pb-0 flex flex-col gap-1">
                <dt className="text-body font-medium text-ink">{item.q}</dt>
                <dd className="text-caption text-ink-2 leading-relaxed">{item.a}</dd>
              </div>
            ))}
          </dl>
        </Section>
      </div>
    </div>
  );
}
