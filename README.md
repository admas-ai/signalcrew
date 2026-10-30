# SignalCrew

A cooperative Twitch chat rescue game built by individual entrant Surafiel Temesgien with OpenAI Codex during the October 2026 submission window. Viewers use `!crew scan`, `!crew shield` and `!crew boost`; each account gets one accepted contribution per round. Five rounds decide whether the crew restores the relay while keeping the ship intact.

This public repository restores the runnable source for the existing [SignalCrew submission](https://devpost.com/software/signalcrew) after its former source link became inaccessible. It is the same project, not a second submission. Application, assets, tests and setup files are unchanged from the saved source package; the setup guide was refreshed.

## Run

Install Node.js **24 or newer**. No third-party packages, database, build service or paid model is required.

```sh
npm test
npm start
```

Open http://localhost:4310 for the captain console. On Windows, `start-signalcrew.cmd` can prepare the example configuration and start the server.

A fresh process starts in clearly labeled **synthetic rehearsal**. Launch a round, add rehearsal scan/shield/boost contributors, resolve the window, then launch the next round from its debrief. A balanced crew can complete a five-round rescue. Rehearsal works without a Twitch account.

The read-only stream display is http://localhost:4310/overlay. If using OBS Browser Source, use at least 1280×1000; the earlier 1280×900 layout showed vertical overflow. Keep the captain console local. The server binds to 127.0.0.1; do not expose the port publicly. This is a local single-user game, not an authenticated shared hosting service.

## Connect Twitch

1. Copy `.env.example` to `.env`. The example contains a **public application client ID**, not a client secret or access token. For another application, register a Public client in the official [Twitch developer console](https://dev.twitch.tv/console/apps), put its public client ID in the example field, and restart the server. Do not add secrets to this repository.
2. Click **Connect Twitch** and complete the official authorization flow for the broadcaster. The app requests only `user:read:chat` and subscribes to that authorized account's own `channel.chat.message` EventSub stream.
3. Wait for CONNECTED, start a New Twitch mission, and launch round 1. Send the supported commands in that channel. Each account's first accepted contribution counts once per round.
4. If chat disconnects, the live round pauses with its remaining time. Reconnect and explicitly resume. Twitch does not replay all missed events, so this app does not promise complete outage recovery. Rehearsal injection is rejected in live mode.

Access and refresh tokens remain only in server process memory. They are not written to files, public state, evidence responses or browser storage. Disconnect clears process-held tokens; revoke the provider grant in Twitch Connections to remove it there. Restarting requires reconnecting.

## Review and verification

On October 30, Node v24.22.1 passed all **17 existing automated tests**, zero failures. These tests cover mission outcomes, exact command parsing, deduplication, late inputs, pause/resume, token identity/scope validation, refresh rotation, directed reconnection, cancellation and local HTTP control boundaries. All automated provider tests use injected fakes; they are separate from the genuine recorded Twitch mission.

The [public demonstration](https://youtu.be/kdvQJsUvrwo) shows Twitch behavior and recorded Codex development. Original Codex build session: `01a16a9a-4b62-737f-ad19-357195d290e8`, also displayed on the public Devpost project. The Twitch test used one broadcaster account on an offline channel; no OBS or public-broadcast test is claimed. Independent-viewer, actual outage/revocation and phone checks remain future verification work. Judges determine evidence sufficiency and eligibility.

## Controls and privacy

Captain mutations require a runtime control key and same-origin requests. Unknown hosts, cross-origin writes, source-file requests and overlay control access are rejected. Logs/evidence expose aggregate game outcomes rather than chat text or viewer names. Resetting clears in-memory mission history; export aggregate evidence first if needed. No private submission documents, saved credentials or provider test receipts are included here.
