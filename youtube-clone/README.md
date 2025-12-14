## YouTube-like clone (minimal)

This repo is originally TrustWallet assets; the clone lives under `youtube-clone/` and is isolated.

### Features included (baseline)
- Auth: register/login with JWT
- Video upload (stored locally)
- Video streaming via HTTP Range (`<video>` works)
- Feed + search
- Likes (toggle)
- Comments
- Subscriptions (toggle)

### Run

```bash
cd youtube-clone/api
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:4000`.

### Notes
- Storage goes to `youtube-clone/storage/`
- DB uses `sqlite3` CLI if available; otherwise it falls back to a dev JSON store.
