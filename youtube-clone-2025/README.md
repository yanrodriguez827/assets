## youtube-clone-2025

Run:

```bash
docker compose up --build
```

Run without Docker (SQLite + filesystem + DB-backed queue):

```bash
cd services/api
cp .env.example .env
npm install
npm run dev
```

In another terminal:

```bash
cd services/worker
cp .env.example .env
npm install
npm run dev
```

Open:
- Web/API: `http://localhost:4000`
- MinIO console: `http://localhost:9001` (user: `minio`, pass: `minio12345`)

Security requirement: you must change secrets in `docker-compose.yml` before real deployment.
