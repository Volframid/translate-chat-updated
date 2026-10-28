# Translate Chat Updated

Chat translation for TERA Toolbox by CEM. No account, subscription or API key is required. Incoming messages remain visible with a translated copy below. Optional outgoing translation sends the translated message; if translation fails, the original is sent once.

## Commands

Use these commands in Toolbox chat (/8):

| Command | Action |
| --- | --- |
| translate on / off | Enable or disable translation |
| translate source auto | Detect the incoming language automatically |
| translate source ru | Fix the incoming source language (example) |
| translate target en | Translate incoming messages to English |
| translate target tr | Translate incoming messages to Turkish |
| translate send ru | Enable outgoing translation to Russian |
| translate send off | Disable outgoing translation |
| translate status | Show saved settings and any service pause |
| translate stats | Show incoming/outgoing messages, requests, cache hits and failures |
| translate diagnose | Show version, connection retries and the last fixed error category/code |
| translate help | Show command help |

Changing outgoing translation mode or its language keeps incoming translations and conversation order intact. Pending outgoing messages are released once in their original form when the setting changes.

Settings persist across restarts. Existing settings are retained on upgrade. The default for a new installation is incoming translation to English, with outgoing translation off.

## Translation and reliability

Uses Google's accountless web translation endpoint. This is an unofficial integration, not a guaranteed Google Cloud API service. Network access is required; availability and limits can change. Rate-limit responses trigger a pause instead of repeated requests. There is no account or login prompt.

For connection failures, the module retries once on a fresh IPv4 connection to the same Google endpoint within the original three-second request deadline. A stalled initial connection gets an early fallback; an established connection keeps its remaining response time. Successful fallback temporarily prefers IPv4 for one minute. HTTP 403/429 limits and invalid translations are never retried, and certificate verification stays enabled. This does not change Windows routes or promise to bypass ExitLag.

The module reads all translated sentence segments, preserves message order within each chat channel/conversation, and bounds outgoing waits to four seconds. Incoming originals are shown immediately. During busy chat, outgoing messages receive queue priority without increasing the request rate. Intentional shutdown settles active requests without counting them as network failures. Real service rate limits and network failures retain their existing pause behavior. Known service outages return originals promptly; cached translations remain available. Pending messages are discarded when the connection ends.

Player names, URLs, email addresses and supported item links are protected. Numbers, emoji and messages consisting only of protected names or links pass through without a translation request. Messages already returned unchanged do not get an extra translated copy. Chat content is not written to a local log.

If a protected token is lost or duplicated by the service, or a response contains an untranslated sentence, the unsafe translation is discarded. Short, mixed-language messages and gaming slang can still be mistranslated; this does not add a context-aware AI model.

## If incoming translation fails with ExitLag

Keep ExitLag enabled and check `translate stats`, `translate status` and `translate diagnose` in Toolbox chat. Increasing **Incoming** confirms the module sees chat messages. Increasing requests/failures with network errors indicates the separate Google HTTPS connection failed; `http-429`/`http-403` indicates a service restriction. No incoming count suggests a module, packet hook, settings or version issue rather than proving a translation-service outage.

ExitLag normally routes only applications selected in its profile. Check whether Toolbox/Node/Electron was also selected before changing the game profile. These commands show counters and fixed error codes only; they do not log or display chat content, names, URLs or network addresses. They do not send a test chat message. A real ExitLag failure must still be verified on the affected user's computer.

## Updates

Automatic updates use this module’s own CEM-maintained GitHub repository. The old upstream update connection is not used.

## Install and update

Download the ZIP from [Releases](https://github.com/Volframid/translate-chat-updated/releases/latest) and extract the `translate-chat-updated` folder into `Toolbox/mods`. Keep only one installation of this module. Toolbox downloads subsequent updates automatically when module updates are enabled. Existing private settings are preserved.
