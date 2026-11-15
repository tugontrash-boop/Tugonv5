# T.U.G.O.N. — Barangay 40 & 41, Cavite City
### Waste Collection & Official Proof Management System with Raspberry Pi Cloud Storage

## Overview
- **Residents Portal**: Submit geo-located waste collection reports with photo evidence, offline-first local storage (`localStorage`), and automatic background retry queue synchronization.
- **Barangay Official Portal**: Live operational map, Street View 360, dispatch workflow, mandatory cleanup proof verification, permanent resolution logbooks, Telegram Bot alerts & cloud bubbles, and Raspberry Pi 4B sovereign cloud storage sync.

## Local Development
```bash
npm install
npm run dev
```

## Production Start (Node / Render)
```bash
npm run build
npm start
```

## Cloudflare Workers / Pages Deployment
- **Cloudflare Workers**: Uses `cloudflare-worker.ts` + `ensure-structure.js` auto-generated `wrangler.jsonc` (`run_worker_first: ["/api/*"]`).
- **Cloudflare Pages**: Uses `functions/api/[[path]].ts` + `public/_routes.json`.
- **Build Command**: `npm install && npm run build`

## Official Accounts
- **Barangay / Kagawad Accounts**: `Barangay40&41`, `Kagawad`, `Kagawad41` (`Brgy40&41@CaviteCity2026!`)
- **System Admin Account**: `Admin` (`TUGONADMINACCESS10-ZIRCON`)
