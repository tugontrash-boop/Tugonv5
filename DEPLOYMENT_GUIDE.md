# T.U.G.O.N. — Barangay 40 (Gumamela) & Barangay 41 (Rosal), Cavite City
## Official Raspberry Pi 4B, Telegram Bot, & Cloud Deployment Guide

---

## 1. Raspberry Pi 4B Sovereign Cloud Storage Server

Ang `raspberry-pi-server/server.py` ay gumagamit lamang ng **Python 3 Standard Library** (`ThreadingHTTPServer`) — **walang `pip install` o `venv` na kailangan**. Awtomatiko nitong nade-detect ang External Hard Drive (`/media/pi/Vherrsie Back-up/RESEARCH TRASH`), sini-sync ang `pulse_reports.json`, sine-save ang mga `.jpg` na litrato sa `photos/`, at ini-imbak ang mga Logbook snapshots sa `saved_logbooks/`.

### Hakbang A: Patakbuhin ang Pi Storage Server (Port 8000)
```bash
cd ~/tugon-server/raspberry-pi-server
python3 server.py 8000
```

Para kusa itong mag-autorun 24/7 kahit mag-brownout:
```bash
bash setup_autostart.sh
```

### Hakbang B: I-bind at I-lock ang Cloud Server URL
1. Ikonekta ang iyong HTTPS tunnel domain papunta sa port `8000` ng Raspberry Pi.
2. Buksan ang **Barangay Portal -> Raspberry Pi 4 Hub**, ilagay ang iyong Cloud Server URL, at pindutin ang **"I-konekta at I-save ang Link"**.
3. Pindutin ang **"Lock Binding"** (gamit ang Admin access) o itakda sa `public/pi-config.json` / `src/utils/cloudServerConfig.ts` upang permanenteng i-lock ang server URL laban sa hindi awtorisadong pagbabago.

---

## 2. Telegram Kagawad 24/7 Alert Bot Setup

1. Buksan ang Telegram app at hanapin si **@BotFather**, i-send ang `/newbot`, at kopyahin ang **Bot Token**.
2. Buksan ang bagong gawa mong bot sa Telegram at pindutin ang **`/start`** (o i-add ang bot sa Group Chat ng mga Kagawad at mag-send ng mensahe).
3. Sa **Barangay Portal -> Telegram**, i-paste ang **Bot Token** at pindutin ang **"Auto-Detect Chat ID"**.
4. Pindutin ang **"I-verify, I-save, at Magpadala ng Test Alert"**.
   - Bawat bagong report ay magpapadala ng detalye, Google Maps pin, listahan ng active concerns, at litrato ng basura.
   - Bawat naresolbang ticket ay magpapadala rin ng litrato ng katibayan (cleanup proof).

---

## 3. Cloud Deployment (Cloudflare Workers / Pages & Render)

- **Build Command:** `npm run build`
- **Start Command:** `npm start`
- Ganap na tugma sa Cloudflare Workers (`cloudflare-worker.ts`), Cloudflare Pages Functions (`functions/api/[[path]].ts`), at Node.js (`server.ts`).
