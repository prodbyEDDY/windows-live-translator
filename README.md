# Live Translator

Live Translator — приложение для Windows, переводящее голос в реальном времени
во время звонков (Zoom, Meet, Teams и др.). Оно работает в двух направлениях
одновременно:

- **Исходящий канал (OUT):** ваш микрофон → Gemini → виртуальный аудиокабель
  (VB-CABLE). Собеседник слышит ваш перевод вместо оригинальной речи.
- **Входящий канал (IN):** звук приложения собеседника → Gemini → ваши наушники.
  Вы слышите перевод его речи, а оригинал приглушается (ducking) на время
  перевода и восстанавливается после.

Есть мастер первого запуска (ввод ключа, установка VB-CABLE, выбор устройств,
тест), экран настроек и живой экран звонка с уровнями и транскриптами.
Интерфейс на русском и английском.

## Архитектура

Весь аудиоввод/вывод (WASAPI через крейт `wasapi`) и обе WebSocket-сессии
Gemini Live живут в Rust-бэкенде (Tauri 2). Фронтенд (React + HeroUI) — это
чистый UI, общающийся с бэкендом по типизированным IPC-командам и событиям.

Подробности:

- Дизайн / спецификация: [`docs/superpowers/specs/2026-06-12-live-translator-design.md`](docs/superpowers/specs/2026-06-12-live-translator-design.md)
- План реализации Stage 1: [`docs/superpowers/plans/2026-06-12-live-translator-stage1.md`](docs/superpowers/plans/2026-06-12-live-translator-stage1.md)
- Ручной E2E-чеклист: [`docs/testing/stage1-e2e-checklist.md`](docs/testing/stage1-e2e-checklist.md)

## Предварительные требования

- **Windows 10/11.**
- **VB-CABLE** (VB-Audio Virtual Cable) — виртуальный аудиокабель. Мастер может
  установить его автоматически; иногда нужна перезагрузка, чтобы появились
  устройства `CABLE Input` / `CABLE Output`.
- **API-ключ Gemini** — действующий ключ Google Gemini (его можно получить в
  Google AI Studio). Ключ хранится в Windows Credential Manager, а не в файле.
- **Наушники** — чтобы переведённая речь собеседника не попадала обратно в
  микрофон (без эха).
- Для разработки: Rust ≥ 1.77, Node ≥ 20.

## Команды разработки

```powershell
npm install              # установить зависимости фронтенда (один раз)

npm run tauri dev        # собрать и запустить приложение (Rust + Vite + окно)
npm run build            # собрать фронтенд для продакшена (tsc + vite build)
npm test                 # тесты фронтенда (vitest)
```

Тесты Rust запускаются из каталога `src-tauri/`:

```powershell
cd src-tauri
cargo test                                  # юнит/интеграционные тесты (аппаратные помечены #[ignore])
cargo clippy --all-targets -- -D warnings   # линтер без предупреждений
```

Аппаратные тесты (микрофон, воспроизведение, перечисление устройств) помечены
`#[ignore]`. Тест проверки реального ключа требует переменную окружения
`GEMINI_API_KEY`. Запускать явно, например:

```powershell
cargo test mic_capture_3s -- --ignored --nocapture
```
