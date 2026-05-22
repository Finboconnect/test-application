# Static Kanban (IndexedDB + Offline)

Fully static, offline-capable Kanban app with multiple boards, drag-and-drop, task create/edit/delete, dark mode, and IndexedDB persistence.

### Files
- `index.html` – UI shell + modal
- `style.css` – light/dark themes
- `script.js` – app UI + DnD + wiring
- `db.js` – IndexedDB wrapper (`kanbanDB`: `boards`, `tasks`, `settings`)
- `boards.js` – multi-board helpers
- `theme.js` – theme persistence + toggle
- `sw.js` – service worker cache for offline use

## Local dev
Serve over HTTP (modules + service worker won’t work from `file://`).

- Python: `python -m http.server 8000`
- Then open: `http://localhost:8000`

## Deploy to S3 + CloudFront (no backend)
You said you already have S3/CloudFront infra; these steps focus on settings and gotchas for this app.

### S3
1. Upload these files to the bucket root: `index.html`, `style.css`, `script.js`, `db.js`, `boards.js`, `theme.js`, `sw.js`.
2. Ensure correct content types (S3 usually auto-detects, but verify):
   - `index.html` → `text/html`
   - `style.css` → `text/css`
   - `*.js` → `text/javascript` (or `application/javascript`)
   - `sw.js` → `text/javascript` (or `application/javascript`)
3. Static website hosting is optional if you use CloudFront + S3 origin access (OAC/OAI). If you rely on S3 website hosting, enable it and set the index document to `index.html`.

### CloudFront
1. Origin: S3 bucket (recommended: S3 REST origin with Origin Access Control).
2. Default root object: `index.html`.
3. Viewer protocol policy: Redirect HTTP → HTTPS.
4. TLS cert: attach ACM certificate for `*.schoolplant.academy` (ACM cert must be in `us-east-1` for CloudFront).
5. (Recommended caching)
   - Keep `index.html` with low/zero TTL (so deploys update quickly).
   - Allow longer caching for `style.css`, `*.js`, `sw.js`, and use CloudFront invalidations on deploy if needed.

### Route 53
Create an alias record:
- `kanban.schoolplant.academy` → CloudFront distribution domain name

### Offline behavior
- First load must happen online (to install the service worker + cache files).
- After that, the app runs offline; data persists in IndexedDB.
