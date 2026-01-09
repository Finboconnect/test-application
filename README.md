# Static Kanban + Scrum (IndexedDB + Offline)

Fully static, offline-capable Jira-like board with multiple boards, Kanban + Scrum views, task create/edit/delete, and IndexedDB persistence. No backend.

## Files
- `index.html` - UI shell + modals
- `style.css` - light/dark themes (Jira-like light)
- `script.js` - app UI + DnD + Scrum + wiring
- `db.js` - IndexedDB wrapper (`kanbanDB`: `boards`, `tasks`, `epics`, `sprints`, `sprintSnapshots`, `events`, `settings`)
- `boards.js` - multi-board helpers
- `theme.js` - theme persistence + toggle
- `sw.js` - service worker cache for offline use

## Local preview
Serve over HTTP (modules + service worker won't work from `file://`).

### Option A: Docker (recommended)
Build + run:
- `docker build -t kanban-local .`
- `docker run --name kanban-local -p 8080:80 -d kanban-local`
- Open `http://localhost:8080`

Stop/start:
- Stop: `docker stop kanban-local`
- Start: `docker start kanban-local`
- Remove container: `docker rm -f kanban-local`

### Option B: Node (downloads a dev server on first run)
- `npx http-server -p 8000`
- Open `http://localhost:8000`

## Deploy to S3 + CloudFront (no backend)
You said you already have S3/CloudFront infra; these steps focus on app settings and gotchas.

### S3
1. Upload these files to the bucket root: `index.html`, `style.css`, `script.js`, `db.js`, `boards.js`, `theme.js`, `sw.js`.
2. Verify content types:
   - `index.html` -> `text/html`
   - `style.css` -> `text/css`
   - `*.js` -> `text/javascript` or `application/javascript`
3. Static website hosting is optional if you use CloudFront + S3 origin access (OAC/OAI). If you rely on S3 website hosting, set index document to `index.html`.

### CloudFront
1. Origin: S3 bucket (recommended: S3 REST origin with Origin Access Control).
2. Default root object: `index.html`.
3. Viewer protocol policy: Redirect HTTP -> HTTPS.
4. TLS cert: attach ACM certificate for `*.schoolplant.academy` (ACM cert must be in `us-east-1` for CloudFront).
5. Recommended caching:
   - Keep `index.html` with low/zero TTL (so deploys update quickly).
   - Allow longer caching for `style.css`, `*.js`, `sw.js`, and use CloudFront invalidations on deploy if needed.

### Route 53
Create an alias record:
- `kanban.schoolplant.academy` -> CloudFront distribution domain name

## Offline behavior
- First load must happen online (to install the service worker + cache files).
- After that, the app runs offline; data persists in IndexedDB.

## Troubleshooting
- If updates seem stuck on CloudFront, hard-refresh (`Ctrl+F5`) or use the in-app "Refresh" banner when it appears.
- If IndexedDB says "upgrade blocked", close other tabs of the app and reload.
