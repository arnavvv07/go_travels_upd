// ---------------------------------------------------------------------------
// MongoDB storage layer (MongoDB Atlas — cloud-hosted)
// ---------------------------------------------------------------------------
// Requires MONGODB_URI in .env, e.g.:
//   MONGODB_URI=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/go_travels?retryWrites=true&w=majority
//
// Two collections:
//   users        - one doc per phone number, tracks personal login_count
//                  and first/last login timestamps
//   login_events - append-only log, one doc per login
// ---------------------------------------------------------------------------
const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.warn(
    "WARNING: MONGODB_URI is not set. /api/login and /api/login/stats will fail until it's configured in .env"
  );
}

const client = uri ? new MongoClient(uri) : null;

let dbPromise = null;
let indexesReady = false;

// Lazily connects once and reuses the connection for every request
// (the recommended pattern for the MongoDB driver — don't reconnect per call).
function getDb() {
  if (!client) {
    return Promise.reject(new Error("MONGODB_URI is not configured"));
  }
  if (!dbPromise) {
    dbPromise = client.connect().then(async (c) => {
      const database = c.db(); // uses the db name from the URI (e.g. "go_travels")
      if (!indexesReady) {
        await database.collection("users").createIndex({ phone: 1 }, { unique: true });
        await database.collection("login_events").createIndex({ created_at: -1 });
        indexesReady = true;
      }
      return database;
    });
  }
  return dbPromise;
}

/**
 * Records a login for the given phone/name: upserts the user doc
 * (incrementing their personal login_count) and inserts a login_event.
 * Returns the updated user + overall stats.
 */
async function recordLogin(phone, name) {
  phone = String(phone || "").trim();
  name = String(name || "").trim();
  if (!phone) throw new Error("phone is required");

  const database = await getDb();
  const users = database.collection("users");
  const loginEvents = database.collection("login_events");

  const now = new Date();

  await users.updateOne(
    { phone },
    {
      $set: { last_login_at: now, ...(name ? { name } : {}) },
      $setOnInsert: { first_login_at: now },
      $inc: { login_count: 1 }
    },
    { upsert: true }
  );

  await loginEvents.insertOne({ phone, name, created_at: now });

  const [user, totalLogins, uniqueUsers] = await Promise.all([
    users.findOne({ phone }),
    loginEvents.countDocuments(),
    users.countDocuments()
  ]);

  return { user, totalLogins, uniqueUsers };
}

async function getStats(recentLimit) {
  const database = await getDb();
  const users = database.collection("users");
  const loginEvents = database.collection("login_events");

  const [totalLogins, uniqueUsers, recent] = await Promise.all([
    loginEvents.countDocuments(),
    users.countDocuments(),
    loginEvents
      .find({}, { projection: { _id: 0, phone: 1, name: 1, created_at: 1 } })
      .sort({ created_at: -1 })
      .limit(recentLimit || 10)
      .toArray()
  ]);

  return { totalLogins, uniqueUsers, recent };
}

module.exports = { recordLogin, getStats };
