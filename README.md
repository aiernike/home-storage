# Home Storage

[简体中文](README.zh-CN.md) | **English**

A household inventory app built for real homes. It remembers where things are, lets you scan a barcode to add something in seconds, and keeps an eye on expiry dates so food and medicine don't quietly go bad. It handles **physical goods, office documents, and books** — and syncs to your own NAS so your desktop and Android phone share one library.

Three clients, one codebase:

| Client | How to install | Notes |
|---|---|---|
| Windows | [Windows11使用指南.md](Windows11使用指南.md) *(Chinese)* | Desktop app, packaged as an NSIS installer |
| Android | [安卓手机使用指南.md](安卓手机使用指南.md) *(Chinese)* | Packaged as a signed APK |
| NAS backend | [群晖部署指南.md](群晖部署指南.md) *(Chinese)* | Optional sync server; works fully offline without it |

## Features

### Three record types, one schema

The app manages three kinds of things, shown as three tabs but backed by the **same table** and the same sync / search / stats / image pipeline:

| Tab | What it holds | Per-record fields |
|---|---|---|
| Goods | Physical items at home | Quantity, expiry date, barcode |
| Documents | Files, contracts, receipts, accounting vouchers | Title, category, document number, year, issuer, amount, retention period |
| Books | Books, textbooks, magazines | Title, author, publisher, publication year, ISBN, reading status |

They are separate because they care about different things: the "expiry date" of a bag of rice is not the "retention period" of a contract, and a magazine has no meaningful "quantity".

### Storage locations

Locations are organized as **Room → Cabinet → Shelf / Compartment**, with unlimited nesting. A sensible home structure is preloaded (kitchen, fridge, pantry, …) and can be freely added to, renamed, or deleted. Filtering by a location automatically includes every descendant — tap "Fridge" and you see everything in both the chiller and the freezer.

### Item icons

Anything without a photo gets an icon in the list, so you can tell at a glance what it is. **82 hand-drawn icons in 9 groups** (food, household, medicine, office, books, digital, tools, clothing, other) — pure vectors, fully offline, no disk cost.

Icons resolve in three levels: your explicit choice → the category's default icon (e.g. the "Accounting" category defaults to a voucher icon) → the tab's fallback (a document for Documents, a book for Books). So you don't have to pick one, but picking one is more precise.

### Barcode input

Four ways, pick whichever fits:

- **Camera scan** — the recognition library ships with the app, no system or third-party service involved
- **From a photo** — read a barcode out of an existing picture
- **Manual entry**
- **Hardware scanner** — with a prefix configured, you can scan from any screen

**Configure a prefix if you use a scanner.** To a PC, a barcode scanner is just a keyboard: without a prefix it types the barcode into whatever field currently has focus — you're filling in "Item name", you scan, and the name becomes a string of digits.

Go to **Settings → Scanner**, enter a character (e.g. `$`), then set the scanner's own **prefix** to the same character. After that, scanning on **any screen** opens or creates the matching record directly, no need to switch to the scan tab, and the barcode never leaks into the form you were filling in. Scanned records appear in the scan log tagged with the source "Scanner". The trade-off: you can no longer type `$` in an input field (it is treated as the prefix). Leave it empty if you don't use a scanner; it can be turned off at any time.

The camera requests maximum resolution (1920×1080, continuous autofocus) and supports the torch, so barcodes in dim light or behind reflections still scan. One item can carry multiple barcodes, so different packagings of the same product don't conflict. Uniqueness is enforced: a duplicate is rejected and the app tells you which item already owns that barcode. Check digits are validated as you type — a mistyped EAN-13 is flagged immediately.

### Books and magazines are recognized automatically

Scan an ISBN from the back of a book (`978` / `979`) or a periodical barcode from a magazine cover (`977`), and the app asks "Add as a book?" — confirming opens the form as a book with the barcode already filled in. You don't have to decide whether "this counts as an item". The check-digit message says "ISBN", not "EAN-13".

### Internal codes for things without a barcode

A soy sauce bottle has a barcode; your rental contract or a bag of home-packed peppercorns does not. Those get an **internal code** on save, in the form `HS-2026-0001` (prefix – year – sequence, incremented per year, deleted numbers are never reused).

- The code is printed on a QR label — stick it on, and if the QR gets scuffed you can still type the code
- Typing or scanning anything starting with `HS-` **opens that record directly** instead of creating a new one
- If nothing matches, the app asks whether to create a record with that code — it never silently drops an empty record
- Codes are searchable: searching `HS-2026-0001` finds it

### QR labels for locations and items

Every location and every item can generate a QR code, saved as an image and printed for boxes, drawers, and storage bins. Scanning one later:

- **Location code** → jumps to that location and lists everything inside, including descendants
- **Item code** → opens that item's detail page

QR codes are vector graphics, so they stay sharp when printed large. They encode the local object ID, so they keep working after switching phones or reinstalling the app.

### Item photos

Take a photo and attach it to an item. The list shows a thumbnail so you can recognize it instantly; tap it for the full image. Full-size photos are stored as separate files, so the data file doesn't balloon — safe to shoot on a phone. Photos sync to the NAS and follow you across devices.

### Expiry tracking

You can enter just an expiry date, or a **production date + shelf life in days** and let the app compute it. The "expiring soon" window is configurable (7 days by default). Expired and soon-to-expire items get dedicated sections on the dashboard and the expiry page, and the app shows a notification at startup.

### Date shorthand

Date fields accept plain text — no calendar picking required:

| Input | Meaning |
|---|---|
| `2027-05-17` | An explicit date (`2027/5/17`, `2027年5月17日`, `20270517` also work) |
| `+1y` / `1年` | One year from now (also `+3m` / `3个月`, `+30d` / `30天`, `+2w` / `2周`) |
| `-30天` | 30 days ago (useful for production dates) |
| `0517` | May 17. **If that date has already passed this year, it means next year** — handy for "next expiry" |
| `x` | No expiry (clears the date) |
| `今天` / `明天` / `昨天` | Today / tomorrow / yesterday |

On blur, the field shows "interpreted as 2027-05-17" so you can confirm at a glance. Anything unparseable is rejected on save — it is **never silently stored as empty**, which would leave you believing the expiry was set.

### Other features

- Quantity +/−, with a prompt to delete when an item runs out
- **Bulk organize**: tap "Bulk organize" on the Goods tab to multi-select a batch and move them all to one location — no more opening items one by one while tidying up
- **27 preset categories** (food / medicine / household / cleaning / hardware / stationery / clothing; 5 for documents, 6 accounting-specific, 3 for reading, 5 extended household). Create, rename, recolor, or delete them under **Settings → Manage categories**. If you discover a missing category mid-entry, the form's category dropdown has a **＋ New** button — no need to exit and come back
- Categories and tags, filterable by category; each filter row has a small heading (Type / Category / Expiry), and extra categories collapse into "More categories" instead of filling the screen
- Search covers name, barcode, internal code, notes, and location path; documents are also searchable by document number, issuer, and amount
- Documents can be filtered by year and whether the retention period has passed; books by reading status
- Statistics page: total records (split by goods / documents / books), category distribution, location distribution, 6-month intake trend, and total value estimate
- Export a complete JSON backup, or **export CSV for Excel**: the CSV contains all three record types, with a header that is the union of their fields (inapplicable cells left empty). Filter by the "Type" column to see one kind. Document number / year / amount / retention period and book author / publisher / reading status are all included
- Import supports merge or full replace

## Project layout

```
home-storage/
├── src/
│   ├── main/            Electron main process
│   │   ├── main.js      Window, IPC, system notifications
│   │   ├── preload.js   Secure bridge
│   │   ├── store.js     Data layer (items / locations / categories / barcodes / expiry)
│   │   └── sync.js      Sync client
│   └── renderer/        UI (shared by desktop and mobile)
│       ├── index.html
│       ├── css/style.css
│       └── js/
│           ├── zxing.min.js   Barcode / QR recognition and generation (bundled, offline)
│           ├── qr.js          QR payload encoding and parsing
│           ├── icons.js       Built-in vector icon library (82 icons / 9 groups)
│           ├── util.js        Utilities + barcode scanner
│           ├── components.js  Modals, toasts, forms
│           ├── views.js       Nine screens
│           └── app.js         Main controller
├── mobile/              Android client
│   ├── platform/        Mobile adaptation layer
│   │   ├── 01-shim.js       Browser runtime (files / paths / crypto / network)
│   │   ├── 02-mobile.css    Mobile layout
│   │   └── 03-bootstrap.js  Wires up window.api
│   ├── android/         Android project (Gradle-free)
│   │   ├── AndroidManifest.xml
│   │   ├── src/.../MainActivity.java
│   │   ├── res/           Icons, strings, theme
│   │   └── assets/www/    Packaged UI (generated)
│   ├── build-mobile.js  Builds UI assets
│   ├── make-icon.js     Generates the app icon
│   ├── build-apk.js     One-command signed APK build
│   └── home-storage.jks Signing keystore (do not delete)
├── server/              Sync service for the NAS
│   ├── index.js         Server (accounts + incremental sync + mobile web hosting)
│   ├── public/          Mobile web app (generated by npm run build:mobile-assets; deploy with the server)
│   ├── Dockerfile
│   └── docker-compose.yml
├── scripts/
│   ├── fetch-tool.js    Build helper: downloads build tool packages
│   ├── icon-preview.js  Dev helper: renders the icon library to an image for visual review
│   ├── nas-diff.js      Dev helper: diffs local vs. NAS web assets, lists files to upload
│   ├── review-check.js  Dev helper: code-standard self-check (npm run review)
│   └── sandbox/         Restricted-environment helpers (only needed when spawnSync is unavailable)
├── .gitattributes       Line-ending policy (keeps Windows Git's autocrlf in check)
├── screenshots/         UI screenshots (desktop + mobile)
├── test/                13 automated suites (1,601 assertions; npm test runs them all)
├── 打包.bat             One-click Windows packaging script
├── 代码规范.md           Read before editing: hard constraints + review checklist
├── 工程实践参考.md        Engineering practices and external references
├── Windows11使用指南.md   Windows usage + build tutorial
├── 安卓手机使用指南.md     Android install and usage
└── 群晖部署指南.md        Synology NAS deployment guide
```

## Running

Requires Node.js 18 or newer.

```bash
cd home-storage
npm install
npm start              # Launch
npm run dev            # Launch with DevTools
npm test               # Run all tests (1,601 assertions)
npm run review         # Code-standard self-check (rebuilt artifacts, line endings, hardcoded versions…)
npm run icon:preview   # Render the icon library to an image; use it after editing icons.js
```

**Read [`代码规范.md`](代码规范.md) before changing code** *(Chinese)* — it documents the project's hard constraints (each one is a bug that was actually hit) and a review checklist.
A few classes of problems that `npm test` cannot catch — stale build artifacts, mangled line endings, inconsistent API shapes — are covered by `npm run review`.

After changing layout or icons, regenerate screenshots and look at them. Position/size assertions can all pass while the UI is visibly broken (both have happened: mobile tabs stretched to full screen width, item rows wrapping onto three lines on narrow screens):

```bash
HS_SHOT_DIR=screenshots node test/test-e2e.js                    # 19 desktop screenshots
HS_MUI_SHOT_DIR=screenshots/mobile node test/test-mobile-ui.js   # 17 mobile screenshots
```

Data is stored here (created automatically):

- Windows: `%APPDATA%/home-storage/data/storage.json`
- macOS: `~/Library/Application Support/home-storage/data/storage.json`
- Linux: `~/.config/home-storage/data/storage.json`

Writes are atomic (temp file, then rename) and a `.bak` copy is kept, so a power cut cannot corrupt your data.

## Building an installer

### Windows

**Double-click `打包.bat` in the project root.** It handles everything:

1. Checks the Node.js environment
2. Installs dependencies on first run (using a China-friendly mirror)
3. Configures the electron-builder download mirror
4. Works around the `winCodeSign` symlink issue (see below)
5. Runs the build

Manually:

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set CSC_IDENTITY_AUTO_DISCOVERY=false
npm run build:win
```

> **First build may fail with "client does not have the required privilege"**
>
> Cause: the `winCodeSign` package electron-builder needs contains macOS `.dylib`
> symlinks, and a normal Windows account cannot create symlinks, so extraction aborts.
>
> Fix: extract it manually with 7-Zip's `-snl` flag (store symlinks as regular files) into
> `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\`.
> electron-builder then reuses the cache and skips extraction. `打包.bat` already does this.
>
> Alternatively, run as administrator or enable Windows Developer Mode.

### macOS / Linux

```bash
npm run build:mac
npm run build:linux
```

Artifacts land in `dist/`; the result is a normal desktop application.

---

## Building an Android APK

No Android Studio and no Gradle — it builds directly with the Android SDK command-line tools:

```bash
npm run build:apk
```

The artifact is `mobile/dist/家庭收纳-1.1.0.apk`; copy it to a phone and tap to install.

You need the Android SDK (build-tools 29.0.3, platforms/android-29) and JDK 8. The default paths are `D:\tools\androidsdk` and `C:\Program Files\Java\jdk1.8.0_333`; override them with `ANDROID_SDK_ROOT` / `JAVA_HOME`.

> **Detailed install and usage instructions: [安卓手机使用指南.md](安卓手机使用指南.md)** *(Chinese)*

### How mobile reuses the desktop UI

The Android client does not reimplement the UI; it puts the desktop UI unchanged inside a WebView:

- `src/main/store.js` (data layer) and `src/main/sync.js` (sync layer) are **byte-for-byte unchanged**;
- `mobile/platform/01-shim.js` provides the browser runtime they need;
- `mobile/platform/03-bootstrap.js` assembles the data layer into the `window.api` shape the renderer expects, identical to the desktop `preload.js`;
- `mobile/platform/02-mobile.css` turns the desktop layout into a mobile one (sidebar becomes a bottom tab bar, modals slide up from the bottom).

The benefit is naturally consistent behavior — whatever the desktop computes, the phone computes the same way.

Two unavoidable technical details (documented in section 8 of the Android guide):

- Pages are served from a virtual `https://hs.local` origin rather than `file://`. The camera's `getUserMedia` only works in a secure context, and `file://` is not one; also, `localStorage` on `file://` does not persist in some WebView versions, which would mean users lose their data.
- Sync requests go through native `HttpURLConnection` rather than page-level `fetch`. The page is on an https origin while the NAS is plain http on the LAN; a direct request would hit both CORS preflight and mixed-content restrictions.

---

## Deploying the NAS sync service

Sync is optional. The app works fine without it; data just stays on one machine.

> **Synology users: see [群晖部署指南.md](群晖部署指南.md)** *(Chinese)* for complete Container Manager walkthroughs, troubleshooting, and remote-access options.
>
> The instructions below are generic.

### 1. Deploy on the NAS

Copy the entire `server` directory to the NAS (e.g. `/volume1/docker/home-storage`), then:

```bash
cd /volume1/docker/home-storage

# Change the default password and secret first
vim docker-compose.yml
```

Two things to change:
- `DB_PASSWORD` and the matching `DB_PASSWORD` in the api service must be identical — set a strong password
- Replace `JWT_SECRET` with random characters (mash the keyboard for ~40 characters)

Then start:

```bash
docker compose up -d --build
```

Wait about 30 seconds and verify:

```bash
curl http://localhost:8787/api/health
# {"ok":true,"name":"家庭收纳同步服务","version":"1.0.0","db":true}
```

### 2. Connect from the client

Open the app → Settings → Data sync:

1. Set **Server address** to `http://NAS_IP:8787`, e.g. `http://192.168.1.100:8787`
2. Enter credentials (use "Register a new account" the first time)
3. Click **Log in and save**

The sync status at the bottom of the sidebar turns green. **Sync now** pushes local changes to the NAS and pulls changes from other devices.

### 3. Other devices

Install the client on each device, use the same server address and the same account. Give each device a name (Living room PC / Laptop) to tell them apart.

### 4. No app required (iPhone / tablet)

The server ships a mobile web app — **nothing to install**. iPhone, iPad, Android phones, and tablets all work, with the same feature set as the mobile app (create, edit, delete, sync).

1. Open `http://NAS_IP:8787/app/` in a mobile browser — keep the trailing slash; `http://NAS_IP:8787` without it is the status page
2. Use the browser menu → **Share → Add to Home Screen**; it then opens from the home screen without an address bar, just like an app
3. It starts empty: go to **Settings → Sync**, enter the server address, and log in with the same account to pull your data

**Scanning is unavailable in this mode**: camera access requires https (or localhost), and browsers reject `http://` on a LAN. The scan page says "no camera available in this environment" and disables the start button; use manual barcode entry or a hardware scanner — everything else works. To enable scanning, put the NAS behind https (see option B below).

### 5. Using it outside the home

Direct LAN access only works at home. Two options for syncing elsewhere:

**Option A: Mesh VPN (recommended)**
Use frp, Tailscale, ZeroTier, or similar. Tailscale is the simplest: install it on the NAS and the phone, and they form a virtual LAN; then use the NAS's virtual IP as the server address.

**Option B: Reverse proxy with HTTPS**
If the NAS has a public IP or domain, point Nginx Proxy Manager at `http://NAS_IP:8787`, install a certificate, and use `https://your-domain`. Also disable registration (`ALLOW_REGISTER: "false"`) so nobody else can create accounts.

### How conflicts are resolved

- Every record carries a modification time. Sync only transfers data changed since the last sync
- If the same item was modified on two devices, **the newer modification wins**
- The overwritten version is not lost: it is kept as a separate entry named "xxx (conflict copy)"
- When conflicts exist, a **conflict list** appears after syncing, offering four choices per item: **Open / Overwrite with copy / Keep / Delete copy**
  — Open views the copy; Overwrite with copy replaces the local record with the copy (this discards the newer NAS change, so it asks first); Keep retains it (it uploads on the next sync); Delete copy removes it permanently
- If the two versions have **different names**, the list also shows the local name so you can match them up
- Closing the list does nothing automatically — **it asks again on the next sync**. The app never decides which version to keep for you and never silently deletes your changes
- Deletes are soft deletes, so they propagate to other devices instead of the record reappearing

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Service port |
| `DB_HOST` | `db` | Database host |
| `DB_PORT` | `5432` | Database port |
| `DB_NAME` | `homestorage` | Database name |
| `DB_USER` | `home` | Database user |
| `DB_PASSWORD` | `home123456` | Database password — **change this** |
| `JWT_SECRET` | `home-storage-change-me` | Token secret — **change this** |
| `ALLOW_REGISTER` | `true` | Whether new accounts can register |
| `LOGIN_MAX_FAILS` | `5` | Failed logins before an account is locked |
| `LOGIN_LOCK_MS` | `900000` | Lock duration in ms (15 minutes by default) |
| `REGISTER_MAX` | `10` | Max accounts per source per hour |

### Backing up NAS data

The database files live in `server/data/postgres`; back up that directory. Or:

```bash
docker exec home-storage-db pg_dump -U home homestorage > backup.sql
```

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| POST | `/api/register` | Register `{username, password}` |
| POST | `/api/login` | Log in `{username, password, device}` |
| POST | `/api/sync` | Incremental sync (Bearer token required) |
| GET | `/api/stats` | Account data statistics |
| GET | `/app/` | Mobile web app (no install required) |

## Design notes

- The three record types (goods / documents / books) live in **one table**, distinguished by a `kind` field. Splitting them into three tables would mean three sync implementations, three searches, and three statistics pipelines, while 90% of the logic is identical. One table also makes cross-type search natural: searching "contract" finds both documents and goods.
- Internal code sequence numbers increment **per year**: `HS-2026-0001`, `HS-2026-0002`, … and restart at `0001` in a new year; the year is part of the code, so they never collide. Allocation also considers **deleted** records, so deleting and re-creating never reuses a number — otherwise an old printed QR sticker would point at a new record.
- Old data files are **migrated automatically** on open (adding `kind` / `icon` / `code` / `extra`, and any new preset categories). Migration is additive only: your renamed categories and colors are untouched, and preset categories you deleted do not come back.
- Barcode and QR recognition use a bundled copy of ZXing: **no system dependency, no network, nothing to install**. Some browsers' built-in detection APIs simply don't exist in Android WebView, which is why they aren't used.
- Full-size photos are stored as separate files; the data file holds only a small thumbnail. This keeps the data file from growing to megabytes because of a few photos, and avoids write failures on phones with small storage quotas. A photo that fails to save is **reported as an error** instead of claiming "saved" and showing a blank image: phone storage can be as small as 5 MB, and one photo can fill it. On failure the app also suggests exporting a backup and cleaning up old photos. Imports and syncs report exactly how many photos failed to land.
- Item icons are built-in vector graphics (SVG), not image files: no disk cost, sharp at any resolution, theme-aware, fully offline.
- Before every save, a `storage.json.bak` copy is kept. **If the main file cannot be read (corrupted, or touched by antivirus / a sync tool), it is restored from the backup automatically.** If neither can be read, the damaged file is **renamed to `storage.json.corrupt-<timestamp>`** instead of being overwritten — the original content survives for manual recovery. Every step is logged.
- Data stays on your machine by default and is never uploaded anywhere. Only if you enable sync does it go to your own NAS.
- Standalone use is fully offline: record normally without a network, and sync when you're back online.

## License

MIT
