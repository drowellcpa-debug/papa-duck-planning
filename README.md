# Papa Duck Homeschool — tool backups

Every build Claude delivers is pushed here the same session (rule of 2026-10-12).
These are **backup copies**: secrets are replaced with placeholders. The working copies
(with real tokens) live on Papa Duck's PC in `C:\PapaDuck` and in the Claude Project.

| Folder | What | Placeholder to fill from the working copy |
|---|---|---|
| `book-station/` | Papa Duck Book Station (one file per version) | `DRAFTS_TOKEN = 'PASTE_STATION_TOKEN_HERE'` |
| `dispatch/` | Dispatch page + `papaduck_local.py` helper | `AMZ_CLOUD_SECRET`, `CLOUD_INTAKE` = `PASTE_FROM_WORKING_COPY` |
| `cloud/` | Supabase edge-function sources | (secrets are Supabase env vars, none in code) |

Dispatch's helper watches the Downloads folder and installs any recognised file within ~15 s,
so the delivery path is chat → download → auto-install. GitHub is the backup, not the installer.
