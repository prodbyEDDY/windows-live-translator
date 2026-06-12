# Stage 1 & 2 E2E checklist

Manual end-to-end verification of the live-translation MVP (Stage 1: live
calls; Stage 2: voice messages + history). Each line is a checkbox to be
executed by the user/dev on a real machine — these cases require audio
hardware, a virtual cable, a remote peer, and the WhatsApp desktop app, so they
cannot be automated in CI.

## Prerequisites

- [ ] **GEMINI API key** — a valid Google Gemini API key entered through the
  wizard (or Settings). Set `GEMINI_API_KEY` in the environment if you also want
  to run the `#[ignore]`d live integration tests.
- [ ] **VB-CABLE installed** — the VB-Audio Virtual Cable driver
  (`CABLE Input` render endpoint + `CABLE Output` capture endpoint). The wizard
  can install it; a reboot may be required before the endpoints appear.
- [ ] **Headphones** — wired or Bluetooth headphones for the user's own output,
  so the translated peer audio is not picked up again by the mic (avoids an echo
  loop).
- [ ] **Zoom test meeting or a second device** — either the Zoom test meeting
  (`zoom.us/test`) or a second device / second account to act as the remote peer
  on a real call.
- [ ] **WhatsApp desktop** (Stage 2) — the WhatsApp desktop app signed in, plus
  a real `.opus`/`.ogg` voice note in a chat to drop into the app, and a chat to
  drag translated audio back into.

## Stage 1 checklist

- [ ] Wizard from clean state (no key, no cable) completes; Zoom shows "CABLE Output" as mic
- [ ] Zoom test call (zoom.us test meeting or second device): peer hears translated speech, not original
- [ ] YouTube video in browser: IN translation audible in headphones, original ducks to set level, restores on stop
- [ ] Both directions simultaneously on a real call for 12+ minutes (survives at least one GoAway/reconnect: status chip flashes yellow, audio resumes, no app restart)
- [ ] Unplug headphones mid-call: app pauses gracefully, no crash; replug + reselect device works
- [ ] Close captured app mid-call: in_session shows source_lost toast; can pick new source. NOTE: process loopback may deliver silence (not an error) when the target pid dies — if the toast never fires, add a pid-liveness watchdog (OpenProcess poll ~2s) to the IN capture that exits the loop when the target is gone.
- [ ] Kill app (taskkill) while ducking active; relaunch: ducked app volume restored on startup
- [ ] Invalid API key: clear error, Start disabled; fixing key in Settings re-enables without restart
- [ ] All UI strings render in both ru and en

## Stage 2 checklist — voice messages

- [ ] Drop a WhatsApp `.opus` voice note onto the Voice screen drop-zone → card appears; transcript **and** translation populate; stage chip ends on "done"
- [ ] Drop a non-audio file (e.g. `.txt`/`.png`) → rejected with a friendly toast, no card created
- [ ] Record → translated "out" card appears with original + translated audio players, both play
- [ ] Drag the translated `.ogg` from the card's drag handle into a WhatsApp chat → lands as an **audio attachment** and plays (drag shows the bundled audio thumbnail, not just a filename)
- [ ] «Сохранить как» on an "out" card opens the save dialog and writes the `.ogg` to the chosen path
- [ ] Voice progress stages update **live** (pending → transcribing → synthesizing → done) without a refresh
- [ ] Force an error (disconnect network), then "Повторить" / retry succeeds once reconnected
- [ ] 5-minute record cap enforced: recording auto-stops at the cap
- [ ] Too-short recording (<1s) rejected with a friendly message, no broken card

## Stage 2 checklist — history

- [ ] After a live call ends (Stop), a call transcript row is saved to history
- [ ] History survives an app restart: close and relaunch → previous calls and voice messages still listed
- [ ] History search finds rows by transcript/translation text
- [ ] «Очистить историю» (confirm) wipes all rows **and** deletes files under `%APPDATA%/com.livetranslator.app/voice`
- [ ] All Stage-2 UI strings render in both ru and en

## Stage 3 checklist — polish & hardening

- [ ] Стоимость и таймер видны при звонке: в статус-баре LiveScreen отображаются примерная стоимость (например, `~$0.12`) и длительность (например, `05:32`); значения обновляются каждую секунду; тултип объясняет, что цена является оценочной
- [ ] «Микшировать оригинал»: при включённой опции собеседник слышит тихий оригинальный голос под переводом (gain регулируется ползунком mixGainDb); без опции поведение прежнее — чистый перевод
- [ ] VAD-экономия (при включённом vadEconomy): при тишине (>800ms ниже порога) трафик к Gemini останавливается — это видно по отсутствию новых строк в транскриптах/логах; при возобновлении речи первое слово не теряется благодаря пре-роллу (300ms буфер)
- [ ] Повторный запуск exe: если приложение уже запущено и пользователь запускает второй экземпляр, фокус переключается на существующее окно (второй экземпляр завершается без открытия нового окна)
- [ ] Установка через NSIS-инсталлятор: файл `*_en-US.exe` из `src-tauri/target/release/bundle/nsis/` запускается, проходит процесс установки и создаёт рабочий ярлык; приложение запускается из установленного местоположения
