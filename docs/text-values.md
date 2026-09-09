# Text files as values

Click **Load text file** beside a value, select a UTF-8 text file, then click **Save** (or **Create value**). This is available on dashboard value cards, the new-value form, permanent value pages, and one-time value pages.

Files are read locally and sent as the ordinary JSON `value` string. There are no attachments, filenames in the stored value, multipart uploads, or binary/base64 encoding. The Java and JavaScript clients continue to read and write the same strings through the existing APIs.

Imports accept UTF-8 text up to **1 MiB**, including `.txt`, JSON, CSV, configuration files, and files without extensions. Invalid UTF-8, NUL-containing binary files, and oversized files are rejected without replacing the current value. Selecting a file does not save it automatically.

An unchanged imported or reloaded value retains its original spaces, tabs, blank lines, trailing newline, CR/LF/CRLF line endings, and UTF-8 BOM. The multiline preview does not trim or pretty-print anything. Manual edits use the browser textarea's LF line endings; reload the original file to restore its exact text.

The JSON and URL-encoded request limits are 8 MiB to allow JSON escaping overhead. On MySQL/MariaDB, startup upgrades the value and before/after history columns from TEXT to MEDIUMTEXT when necessary; existing MEDIUMTEXT/LONGTEXT columns are left alone. The database account needs ALTER privileges for this one-time upgrade. API requests wait for storage initialization and report 503 if it fails. SQLite/PostgreSQL TEXT needs no migration.

## Verification

`node --test test/value-*.test.cjs` runs file decoding, size/error checks, migration logic, and the actual value-route handlers with an in-memory database/HTTP harness.

`python test/value-text.browser.py` runs focused Chromium DOM tests using Python Playwright and mocked HTTP responses, including file selection, create/reset, resave/reload, permanent and one-time pages, stale file reads, and text/filename injection checks. These tests do not contact a production server or database.
