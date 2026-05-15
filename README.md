# Engagement Analytics Dashboard

A small first-party analytics app with a public technology blog article and a password-protected admin dashboard at `/admin`.

## Run

```bash
ADMIN_PASSWORD="replace-with-a-strong-password" npm start
```

Open `http://localhost:3000` for the blog page and `http://localhost:3000/admin` for the dashboard.

## Data

Analytics are stored in `data/analytics.sqlite`. The tracker records IP address, user agent, visit timestamps, session duration, path, referrer, and coarse location fields when your hosting provider supplies geo headers such as `cf-ipcountry`, `x-vercel-ip-country`, `x-vercel-ip-latitude`, or `x-vercel-ip-longitude`.

When served from HTTPS, the tracker also asks the browser for location access. If the visitor allows it, the dashboard stores and displays browser-provided latitude, longitude, and accuracy for that session. If the visitor denies the prompt, the dashboard keeps using the coarse IP/header fallback.

For production, set a strong `ADMIN_PASSWORD` and a stable `SESSION_SECRET` environment variable.
