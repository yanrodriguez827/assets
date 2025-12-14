import 'dotenv/config';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
const config = loadConfig();
const db = await openDb(config.storageDir);
const app = createApp(config, db);
app.listen(config.port, () => {
    console.log(`youtube-clone listening on http://localhost:${config.port}`);
    console.log(`serving web from ${config.webDir}`);
    console.log(`storage at ${config.storageDir}`);
});
