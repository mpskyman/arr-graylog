# arr-graylog

A small Node.js service that polls the logs of **Sonarr**, **Radarr** and **Prowlarr** over their HTTP API and forwards new entries to **Graylog** using the **GELF** format. It has no runtime dependencies and needs Node 18 or newer.

## How it works

- Each service's `GET /api/v3/log` (Prowlarr: `/api/v1/log`) endpoint is polled every `POLL_INTERVAL_SECONDS`.
- Requests are authenticated with the `X-Api-Key` header and ask for newest entries first, filtered to `MIN_LOG_LEVEL` or higher.
- Each record has a monotonically increasing `id`. The service remembers the highest id it has sent per service and forwards only newer records, oldest first.
- Records become GELF 1.1 messages:
  - `short_message` is the log message and `full_message` is the exception text.
  - `timestamp` is the log time, and `level` is the syslog severity (fatal→2, error→3, warn→4, info→6, debug/trace→7).
  - Extra fields are `_service`, `_source_url`, `_level_name`, `_logger`, `_exception_type` and `_record_id`. Graylog reserves `_id`, so the *arr id is stored as `_record_id`.
- Transport is GELF over UDP (gzip JSON) or TCP (NUL-delimited JSON).

By default the first poll only sets the starting position, so existing history is not re-sent on every restart. Set `BACKFILL_ON_START=true` to send recent history once at startup.

## Setup

1. Copy `.env.example` to `.env` and fill in each service URL and API key. API keys are under *Settings → General → Security* in each app.
2. Point `GRAYLOG_HOST` and `GRAYLOG_PORT` at a GELF input. In Graylog, create a **GELF UDP** or **GELF TCP** input, matching `GRAYLOG_PROTOCOL`.
3. Run it, loading `.env` (Node 20.6 or newer):

```sh
node --env-file=.env src/index.js
```

Or export the variables yourself (or pass them inline) and run `npm start`:

```sh
SONARR_URL=http://sonarr:8989 SONARR_API_KEY=... GRAYLOG_HOST=graylog.lan npm start
```

To run the unit tests:

```sh
npm test
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SONARR_URL`, `SONARR_API_KEY` | — | Enable Sonarr. Both are required together. |
| `RADARR_URL`, `RADARR_API_KEY` | — | Enable Radarr. |
| `PROWLARR_URL`, `PROWLARR_API_KEY` | — | Enable Prowlarr. |
| `*_API_BASE` | `/api/v3` (Prowlarr: `/api/v1`) | Override the API base path. |
| `GRAYLOG_HOST` | `127.0.0.1` | Graylog GELF input host. |
| `GRAYLOG_PORT` | `12201` | Graylog GELF input port. |
| `GRAYLOG_PROTOCOL` | `udp` | `udp` or `tcp`. |
| `GELF_HOST_NAME` | system hostname | Value of the GELF `host` field. |
| `POLL_INTERVAL_SECONDS` | `30` | Seconds between polls. |
| `MIN_LOG_LEVEL` | `info` | Lowest level to forward: fatal, error, warn, info, debug, trace. |
| `PAGE_SIZE` | `100` | Records per request. |
| `MAX_PAGES_PER_POLL` | `10` | Pagination cap per poll. |
| `REQUEST_TIMEOUT_SECONDS` | `10` | HTTP timeout per request. |
| `BACKFILL_ON_START` | `false` | Send recent existing entries on startup. |
| `BACKFILL_LIMIT` | `200` | Maximum entries sent by backfill. |

## Caveats

- **Database logging must be on.** The `/log` endpoint returns nothing unless the app's database log is enabled. Nothing is sent in that case, and the service doesn't report an error.
- **UDP size limit.** Plain GELF over UDP is limited to about 8 KB per message. Long messages are trimmed to fit, and messages that still don't fit are dropped. Use `GRAYLOG_PROTOCOL=tcp` if you need full-length messages.
- **Timestamps.** Log times without a timezone are treated as UTC.
- **Log resets.** If an app's log database is cleared and its ids start again, the service resyncs from the new top of the log. Entries written between the old and new ids may be skipped.
- **Unverified against live apps.** The endpoints, parameters and response shape come from the apps' source code and generated API clients. Confirm them against your own instance at `http://<host>:<port>/docs` before relying on the service.

## Layout

```
src/index.js       entry point: loads config, runs the poll loop
src/config.js      environment variable parsing and validation
src/arr-client.js  HTTP client for the /log endpoint
src/poller.js      per-service cursor tracking and forwarding
src/gelf.js        GELF message building, encoding and UDP/TCP senders
test/              unit tests (node:test)
```
