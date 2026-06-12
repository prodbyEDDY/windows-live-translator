export interface Lang {
  code: string;
  autonym: string;
}

/** Uppercase ISO-ish short code for a language (e.g. "en" → "EN"). Falls back
 *  to the upper-cased code when unknown. */
export function langLabel(code: string): string {
  return code.toUpperCase();
}

/** Native name (autonym) for a language code, falling back to the code itself. */
export function langAutonym(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.autonym ?? code.toUpperCase();
}

export const LANGUAGES: Lang[] = [
  { code: "af", autonym: "Afrikaans" },
  { code: "ar", autonym: "العربية" },
  { code: "az", autonym: "Azərbaycan" },
  { code: "bn", autonym: "বাংলা" },
  { code: "bg", autonym: "Български" },
  { code: "cs", autonym: "Čeština" },
  { code: "da", autonym: "Dansk" },
  { code: "de", autonym: "Deutsch" },
  { code: "el", autonym: "Ελληνικά" },
  { code: "en", autonym: "English" },
  { code: "es", autonym: "Español" },
  { code: "et", autonym: "Eesti" },
  { code: "fa", autonym: "فارسی" },
  { code: "fi", autonym: "Suomi" },
  { code: "fil", autonym: "Filipino" },
  { code: "fr", autonym: "Français" },
  { code: "he", autonym: "עברית" },
  { code: "hi", autonym: "हिन्दी" },
  { code: "hr", autonym: "Hrvatski" },
  { code: "hu", autonym: "Magyar" },
  { code: "hy", autonym: "Հայերեն" },
  { code: "id", autonym: "Bahasa Indonesia" },
  { code: "it", autonym: "Italiano" },
  { code: "ja", autonym: "日本語" },
  { code: "ka", autonym: "ქართული" },
  { code: "kk", autonym: "Қазақша" },
  { code: "ko", autonym: "한국어" },
  { code: "lt", autonym: "Lietuvių" },
  { code: "lv", autonym: "Latviešu" },
  { code: "mr", autonym: "मराठी" },
  { code: "ms", autonym: "Bahasa Melayu" },
  { code: "nl", autonym: "Nederlands" },
  { code: "no", autonym: "Norsk" },
  { code: "pl", autonym: "Polski" },
  { code: "pt", autonym: "Português" },
  { code: "ro", autonym: "Română" },
  { code: "ru", autonym: "Русский" },
  { code: "sk", autonym: "Slovenčina" },
  { code: "sl", autonym: "Slovenščina" },
  { code: "sr", autonym: "Српски" },
  { code: "sv", autonym: "Svenska" },
  { code: "sw", autonym: "Kiswahili" },
  { code: "ta", autonym: "தமிழ்" },
  { code: "te", autonym: "తెలుగు" },
  { code: "th", autonym: "ไทย" },
  { code: "tr", autonym: "Türkçe" },
  { code: "uk", autonym: "Українська" },
  { code: "ur", autonym: "اردو" },
  { code: "uz", autonym: "Oʻzbekcha" },
  { code: "vi", autonym: "Tiếng Việt" },
  { code: "zh", autonym: "中文" },
];
