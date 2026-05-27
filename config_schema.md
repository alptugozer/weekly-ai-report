# Config Sheet schema

The script reads its client list from a single Google Sheet ("Config Sheet"). The Sheet's ID is hard-coded in `Weekly_AI_Report.js` (replace `<YOUR_CONFIG_SHEET_ID>` during setup). The first tab of the Sheet is used.

## Required columns

| Column header | Type | Purpose |
|---|---|---|
| `secret_key` | text | Short non-sensitive handle for the client (e.g. `acme`, `bluebird`). Used as the row identifier and in logs. Not an auth secret. |
| `client_name` | text | Display name written to the master Sheet (e.g. `Acme Co.`). |
| `client_account_id` | text | Google Ads Customer ID for the client, with or without dashes (`123-456-7890` or `1234567890`). Must be linked to the MCC under which this script runs. |
| `ai_enabled` | `TRUE` / `FALSE` | Per-client switch. Only rows with `TRUE` are processed. |
| `ai_drive_folder_id` | text | Google Drive folder ID containing the client's AI context files. Must contain at least `system_prompt.txt`. |

## Optional columns

| Column header | Type | Purpose |
|---|---|---|
| `email` | text | Recipient for failure notifications. If empty, failures are only logged. |
| `dashboard_spreadsheet_id` | text | Google Sheet ID of an upstream per-client dashboard (maintained outside this script) that contains a search-term tab. If present, top search terms are pulled from there and added to the AI context. |

The script auto-adds `ai_enabled` and `ai_drive_folder_id` to the Sheet if they're missing — run `setupConfigSheet()` once after pasting in the script.

## Adding a new client

1. Append a row to the Config Sheet with at least `secret_key`, `client_name`, `client_account_id`.
2. Set `ai_enabled = TRUE`.
3. Create a Google Drive folder, drop `system_prompt.txt` in it, set `ai_drive_folder_id` to the folder ID.
4. Done — the next Monday window picks the client up automatically.

## Removing a client

Either delete the row or set `ai_enabled = FALSE`. The client's tab in the master Sheet can be deleted manually.

## Per-client Drive folder contents

| File | Required? | Purpose |
|---|---|---|
| `system_prompt.txt` | Yes | The system message sent to Claude for this client. Defines tone, role, output format expectations. |
| `client_brief.md` | Recommended | Industry, products, goals, target audience, success metrics. |
| `tone_examples.md` | Optional | Past message examples that reflect the desired tone. |
| Any other `.txt` / `.md` | Optional | All `.txt` and `.md` files in the folder are auto-loaded and added to the context. |
