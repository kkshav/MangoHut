# MangoHut

Static web app that uses the [OpenDota API](https://docs.opendota.com/) to summarize your recent games on **one hero**: most-built **items**, **skill build order**, and **talent** picks.

**Project folder:** name the directory **`MangoHut`** (if yours is still `spotify`, close Cursor/any terminals using that folder, rename it in File Explorer, then reopen the `MangoHut` folder).

## What to ship (export)

The app is **only static files**. Copy or zip this entire folder; everything needed is included:

| File | Role |
|------|------|
| `index.html` | Page shell, fonts, favicon link |
| `app.js` | OpenDota calls and UI logic |
| `styles.css` | Layout and MangoHut theme |
| `favicon.png` | Tab icon and header logo |
| `netlify.toml` | Netlify config (publish this folder, security headers) |

No build step. Do **not** rely on opening `index.html` as `file://` — browsers block API calls from file URLs. Always serve over **http(s)**.

## Run locally

From this folder:

```bash
npm start
```

Then open **http://localhost:3000** (or use `npx serve .` / `python -m http.server 8080` if you prefer).

## Host on Netlify

MangoHut is a **static site**. Netlify serves the files in this repo’s **root** (`index.html`, `app.js`, etc.). The included [`netlify.toml`](netlify.toml) sets `publish = "."` and a no-op build command.

### 1. Create the site

1. Sign up at **[app.netlify.com](https://app.netlify.com/)** (GitHub/GitLab/Bitbucket or email).
2. **Add new site** → choose one:
   - **Import an existing project** → connect **GitHub** (or GitLab) → pick the repo with MangoHut → branch `main` → Netlify reads `netlify.toml` and deploys. Every push can auto-redeploy.
   - **Deploy manually** → drag this **entire project folder** onto the deploy drop zone (good for a quick test without Git).

3. After the first deploy, you get a URL like **`https://random-name.netlify.app`**. Open it and confirm MangoHut works.

You do **not** need to set a separate “publish directory” in the UI if `netlify.toml` is in the repo root; it already points at `.`.

### 2. Custom domain (your public URL)

1. In Netlify: your site → **Domain management** → **Add domain** → enter e.g. **`www.yourdomain.com`** (recommended) and/or apex **`yourdomain.com`**.
2. Netlify shows **DNS records** to add at your **registrar** (where you bought the domain), for example:
   - **`www`**: **CNAME** → `your-site-name.netlify.app` (exact target is shown in the dashboard).
   - **Apex** (`yourdomain.com` only): use Netlify’s **[Apex domains](https://docs.netlify.com/domains-https/custom-domains/configure-external-dns/#configure-an-apex-domain)** records (A / ALIAS / ANAME depending on your DNS provider), or point the domain’s **nameservers** to Netlify and use **Netlify DNS** so Netlify creates everything for you.
3. Wait until Netlify shows **DNS verified** and **HTTPS** (Let’s Encrypt) provisions — often a few minutes, sometimes longer for DNS propagation.

Official guide: **[Custom domains](https://docs.netlify.com/domains-https/custom-domains/)**.

### 3. Optional: Netlify CLI

From this folder (after `npm i -g netlify-cli` and `netlify login`):

```bash
netlify deploy --prod
```

Useful for deploys without pushing to Git.

### OpenDota

The app calls **https://api.opendota.com** from the visitor’s browser only. You do **not** need Netlify Functions for the API. Keep the site on **HTTPS** (Netlify does this by default).

## Usage

1. **Select a hero** (required).
2. Enter your **Steam 32-bit Account ID** (numeric; see [OpenDota](https://www.opendota.com) or your Steam profile).
3. Set **# of matches** (1–500) and click **Analyze**.

Match history must be **public** for OpenDota to return data. OpenDota applies **rate limits**; very large batches may return fewer games if the API throttles (the app retries some failures).

Data is from OpenDota; not affiliated with Valve.
