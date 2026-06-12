# Stage 1 E2E checklist

Manual end-to-end verification of the Stage-1 live-translation MVP. Each line is
a checkbox to be executed by the user/dev on a real machine with real calls —
these cases require audio hardware, a virtual cable, and a remote peer, so they
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

## Checklist

- [ ] Wizard from clean state (no key, no cable) completes; Zoom shows "CABLE Output" as mic
- [ ] Zoom test call (zoom.us test meeting or second device): peer hears translated speech, not original
- [ ] YouTube video in browser: IN translation audible in headphones, original ducks to set level, restores on stop
- [ ] Both directions simultaneously on a real call for 12+ minutes (survives at least one GoAway/reconnect: status chip flashes yellow, audio resumes, no app restart)
- [ ] Unplug headphones mid-call: app pauses gracefully, no crash; replug + reselect device works
- [ ] Close captured app mid-call: in_session shows source_lost toast; can pick new source. NOTE: process loopback may deliver silence (not an error) when the target pid dies — if the toast never fires, add a pid-liveness watchdog (OpenProcess poll ~2s) to the IN capture that exits the loop when the target is gone.
- [ ] Kill app (taskkill) while ducking active; relaunch: ducked app volume restored on startup
- [ ] Invalid API key: clear error, Start disabled; fixing key in Settings re-enables without restart
- [ ] All UI strings render in both ru and en
