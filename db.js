// Lightweight file-based store for login tracking.
// Avoids needing a MongoDB Atlas account/connection string for a student
// project — data is just kept in a local JSON file. On Render's free tier
// this file resets on redeploy (ephemeral disk), which is fine for a demo;
// swap this module out for a real database later if you need it to persist.

const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data", "logins.json");

function ensureStore() {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(DATA_FILE)) {
        fs.writeFileSync(DATA_FILE, JSON.stringify({ users: {}, loginEvents: [] }, null, 2));
    }
}

function readStore() {
    ensureStore();
    try {
        return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch (err) {
        return { users: {}, loginEvents: [] };
    }
}

function writeStore(store) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

async function recordLogin(phone, name) {
    const store = readStore();
    const key = String(phone).trim();

    if (!store.users[key]) {
        store.users[key] = {
            phone: key,
            name: name || "",
            login_count: 0,
            first_login: new Date().toISOString()
        };
    }

    store.users[key].login_count += 1;
    store.users[key].last_login = new Date().toISOString();
    if (name) store.users[key].name = name;

    store.loginEvents.push({ phone: key, name: name || "", at: new Date().toISOString() });
    // keep the event log from growing forever
    if (store.loginEvents.length > 2000) {
        store.loginEvents = store.loginEvents.slice(-2000);
    }

    writeStore(store);

    return {
        user: store.users[key],
        totalLogins: store.loginEvents.length,
        uniqueUsers: Object.keys(store.users).length
    };
}

async function getStats(limit) {
    const store = readStore();
    const users = Object.values(store.users)
        .sort((a, b) => new Date(b.last_login) - new Date(a.last_login))
        .slice(0, limit || 20);

    return {
        totalLogins: store.loginEvents.length,
        uniqueUsers: Object.keys(store.users).length,
        recentUsers: users
    };
}

module.exports = { recordLogin, getStats };
