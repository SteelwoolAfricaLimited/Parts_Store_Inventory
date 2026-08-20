# Parts Store Inventory Tracker — PWA

This is a standalone, installable Progressive Web App version of your dashboard.
It's static (HTML/CSS/JS only), so it can be hosted for free on GitHub Pages —
but it still needs your Google Sheet as the data source, so there are **two
pieces** that work together:

1. **The Apps Script project** (your existing `Code.gs` + Sheet) — now also
   acts as a JSON API.
2. **This PWA folder** — a static site you push to GitHub. It calls the API
   in step 1 with `fetch()` instead of `google.script.run`.

Nothing about your Sheet's formulas or data changes. You're not moving off
Google Sheets — you're just giving the same backend a second doorway that a
plain website can use.

## Step 1 — Turn the Apps Script project into an API

1. Open your Apps Script project (the one with `Code.gs` and `Index.html`).
2. Open `APPEND_TO_CODE_GS.js` from this folder, and paste its entire
   contents onto the end of your existing `Code.gs`. (It only *adds* a
   `doPost()` function and an allow-list of functions — it doesn't touch
   anything else, including your existing `doGet()`.)
3. **Deploy → New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Click Deploy, authorize if prompted, and copy the URL that ends in `/exec`.
5. Keep that project deployed — every time you edit `Code.gs`, you need to
   deploy a **new version** (Deploy → Manage deployments → Edit → New version)
   for the changes to take effect on the live URL.

## Step 2 — Point the PWA at it

Open `config.js` in this folder and paste the URL from Step 1:

```js
window.APP_CONFIG = {
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/XXXXXXXX/exec"
};
```

## Step 3 — Push to GitHub and enable Pages

```bash
git init
git add .
git commit -m "Parts store inventory PWA"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then on GitHub: **Settings → Pages → Source: Deploy from a branch → Branch:
main, folder: / (root)** → Save. GitHub gives you a URL like
`https://<you>.github.io/<repo>/` within a minute or two.

Open that URL — you should see the identity gate. If you instead see the red
"not configured" banner, double check `config.js` was actually committed and
pushed (and that the URL doesn't have a trailing space).

## Notes & limitations

- **Icons are placeholders.** `icons/icon-192.png` and `icon-512.png` are
  simple generated placeholders — swap them for your Steelwool logo/branding
  before rolling this out (any 192×192 and 512×512 PNG works).
- **Offline behavior:** the app shell (layout, styles, script) is cached by
  the service worker so it opens instantly and even loads with no signal.
  Actual data — stock levels, requisitions, approvals — always requires a
  live connection to the Apps Script API, since that's where your Sheet
  lives. Offline, you'll see the shell but data calls will fail until you're
  back online.
- **Approval codes still live only in `Code.gs`** (`REQ_STAGE1_APPROVERS` /
  `REQ_STAGE2_APPROVERS`) and are never sent to the browser — the PWA just
  asks the API to verify a code, same as before.
- **CORS trick:** the PWA sends API requests as `Content-Type: text/plain`
  rather than `application/json`. This is intentional — it keeps requests
  "simple" under CORS rules, avoiding a pre-flight `OPTIONS` request that
  Apps Script web apps can't answer. Don't change that content type.
- **Custom domain:** if you want `inventory.yourcompany.com` instead of the
  default `github.io` URL, add a `CNAME` file with that domain and point a
  DNS `CNAME` record at `<you>.github.io` — GitHub Pages docs cover this.
- **HTTPS is required for install/offline** to work as a proper PWA — both
  GitHub Pages and Apps Script `/exec` URLs are HTTPS by default, so this is
  already satisfied.
