# Weekly AI Report — Google Ads + Claude

A weekly performance-reporting tool for Google Ads consultants managing multiple client accounts through a Manager Account (MCC). Pulls per-client metrics via GAQL, sends them through Anthropic's Claude API together with client-specific written context, and writes a structured analysis to a master Google Sheet for consultant review.

**Production status:** This tool is currently operational. It runs inside a Google Ads MCC as a Google Ads Script with an hourly trigger gated to Monday 06:00–12:00 Europe/Istanbul.

**Used by:** Alptuğ Özer — independent Google Ads consultant ([alptugads.com](https://alptugads.com))

---

## What it does

For each client marked as AI-enabled in the central Config Sheet, the script:

1. Switches the MCC context to the client's Google Ads account
2. Runs three GAQL account-level metric queries (current week, prior week, prior 28-day baseline) and one top-campaigns query
3. Loads the client's per-account written context (system prompt, brief, tone examples) from a private Google Drive folder
4. Sends the structured metrics + context to the Anthropic Claude API
5. Parses the structured JSON response (evaluation report, red alerts, action plan, draft customer message)
6. Writes results to four tabs of a master Google Sheet:
   - `Özet` — cross-client summary, rebuilt weekly
   - `Geçmiş` — append-only weekly history
   - `Run Log` — per-run diagnostics
   - `<Client Name>` — rich weekly view, overwritten each Monday

The consultant reviews the master Sheet and authors the actual client-facing communication. No message is auto-sent.

## What it is NOT

- **Not a mutate tool.** Only read operations are performed against Google Ads (GAQL `FROM customer` / `FROM campaign`). No bid changes, status changes, or campaign edits happen via this script.
- **Not a client-facing product.** Clients do not have access to the script, the master Sheet, or the API. They receive a curated weekly communication that the consultant authors.

---

## Architecture

```
Hourly trigger (Mon 06–12 İstanbul gate)
        ↓
Read Config Sheet → list of AI-enabled clients
        ↓
For each client (until 25-min time budget hits):
    AdsManagerApp.select(client.accountId)
        ↓
    GAQL × 3 ranges (account metrics) + top campaigns
        ↓
    Load Drive folder context (system_prompt.txt, brief.md, ...)
        ↓
    POST to api.anthropic.com/v1/messages (claude-opus-4-7)
        ↓
    Parse structured JSON response
        ↓
    Write to Master Sheet tabs
        ↓
    Save client to "processed" state in PropertiesService
```

Multiple hourly triggers within the Monday window drain any clients not processed in the first run. State is held in `PropertiesService` keyed by week-start date, so partial progress survives any single execution timing out.

---

## Setup

### Prerequisites

- Google Ads Manager Account (MCC) with at least one linked client account
- Anthropic API key
- One Google Sheet used as the master Config Sheet (column schema below)
- Per-client Google Drive folder with at least `system_prompt.txt`

### Installation

1. Open the MCC, go to **Tools → Bulk actions → Scripts**, create a new script
2. Paste the contents of `Weekly_AI_Report.js`
3. Replace `<YOUR_CONFIG_SHEET_ID>` (line ~120) with your Config Sheet's ID
4. Authorize the script (Drive + Sheets + UrlFetch + Ads access)
5. From the editor, run `setupConfigSheet()` once — this adds the AI-specific columns to the Config Sheet
6. From the editor, run `setApiKey('sk-ant-...')` once to store the Anthropic API key in `PropertiesService`
7. For each client you want to enable:
   - In the Config Sheet, set `ai_enabled = TRUE`
   - Set `ai_drive_folder_id` to the client's Drive folder ID
   - Place at least `system_prompt.txt` in that folder
8. Run `runMainNow()` once to verify end-to-end. The Master Sheet will be auto-created and its ID stored in `PropertiesService`. The console will log the Sheet URL.
9. Set the script's schedule to **Hourly** in the Google Ads Scripts UI. The internal Monday-window gate handles when work actually happens.

### Config Sheet schema

See [`config_schema.md`](config_schema.md) for the exact column structure.

### Per-client Drive folder

Each AI-enabled client needs a Google Drive folder containing at least `system_prompt.txt`. Optional files: `client_brief.md`, `tone_examples.md`, and any other `.txt` or `.md` files (all are read and added to context).

---

## Manual utilities (run from the script editor)

| Function | Purpose |
|---|---|
| `setupConfigSheet()` | Add the AI-specific columns to the Config Sheet |
| `setApiKey('sk-ant-...')` | Store the Anthropic API key |
| `runMainNow()` | Run the full batch immediately (bypasses Monday-window gate) |
| `runForClient('SECRET_KEY')` | Process one client now, without touching batch state |
| `getMasterSheetId()` | Log the current master Sheet ID |
| `setMasterSheetId('SHEET_ID')` | Override the master Sheet ID |
| `clearMasterSheetId()` | Reset master Sheet ID (next run creates a new one) |
| `resetBatchState()` | Reset the current week's state (for retry after a fix) |
| `getBatchStatus()` | Log the current batch state |
| `clearApiKey()` | Delete the stored API key |

---

## Security and credentials

- **Anthropic API key** is stored in Google Ads Scripts' `PropertiesService`, never in source.
- **Master Sheet ID** is stored in `PropertiesService` on first run.
- **Google Ads access** is granted to the MCC; the script runs under the MCC's existing developer token.
- **No client PII** is stored in this repository.
- **`secret_key` in the Config Sheet** is a misnomer — it is a short, non-sensitive handle (e.g. `acme`, `bluebird`) used to identify a row, not an authentication secret. It is fine to log or include in error messages.

---

## License

MIT — see [LICENSE](LICENSE)
