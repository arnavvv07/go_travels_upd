<<<<<<< HEAD
require("dotenv").config();
const express = require("express");
const path = require("path");
const db = require("./db");

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// ---------------------------------------------------------------------------
// Login tracking endpoint
// ---------------------------------------------------------------------------
// Called from the frontend right after a rider successfully verifies their
// OTP. Persists to a local SQLite file (see db.js) so login counts survive
// server restarts. Every login bumps that user's personal login_count and
// appends a row to login_events, so we can report both "total logins ever"
// and "how many distinct users have logged in".
// ---------------------------------------------------------------------------
app.post("/api/login", async (req, res) => {
  const { phone, name } = req.body || {};

  if (!phone || !String(phone).trim()) {
    return res.status(400).json({ error: "phone is required" });
  }

  try {
    const result = await db.recordLogin(phone, name);
    res.json({
      ok: true,
      loginCount: result.user.login_count,
      totalLogins: result.totalLogins,
      uniqueUsers: result.uniqueUsers
    });
  } catch (err) {
    console.error("Login tracking error:", err.message);
    res.status(500).json({ error: "Could not record login" });
  }
});

// Simple read-only stats endpoint (e.g. for an internal dashboard).
app.get("/api/login/stats", async (req, res) => {
  try {
    res.json(await db.getStats(20));
  } catch (err) {
    console.error("Login stats error:", err.message);
    res.status(500).json({ error: "Could not load stats" });
  }
});

// ---------------------------------------------------------------------------
// AI Agent endpoint
// ---------------------------------------------------------------------------
// The frontend does the actual PREDICTION work (cancellation risk scoring,
// demand-level classification, route-deviation detection) using plain JS
// heuristics — that logic doesn't need an LLM and runs instantly client-side.
//
// This endpoint is the "reasoning" layer on top of those predictions: it
// takes the structured scores/context and asks a free Groq-hosted LLM to
// turn them into a short, human-readable explanation for the rider. This is
// the only place an AI API is called, and it only ever runs on the server —
// the API key never reaches the browser.
//
// If GROQ_API_KEY isn't set (e.g. a fresh clone before setup), it falls back
// to a canned explanation so the app still works end-to-end.
// ---------------------------------------------------------------------------
app.post("/api/agent", async (req, res) => {
  const { task, context } = req.body || {};

  if (!process.env.GROQ_API_KEY) {
    return res.json({ explanation: fallbackExplanation(task, context), source: "fallback" });
  }

  try {
    const systemPrompt =
      "You are the AI dispatch agent inside an Indian cab-booking app called go_travels. " +
      "You are given structured JSON describing a prediction the app's own scoring logic already made " +
      "(driver reliability, demand level, or safety status). Explain that decision to the rider in " +
      "ONE short paragraph, max 3 sentences, plain and reassuring. Do not dump the raw JSON back.";

    const userPrompt = "Task: " + task + "\nContext: " + JSON.stringify(context);

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.GROQ_API_KEY
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 200,
        temperature: 0.5
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      throw new Error("Groq API error " + groqRes.status + ": " + errText);
    }

    const data = await groqRes.json();
    const explanation =
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim() ||
      fallbackExplanation(task, context);

    res.json({ explanation, source: "groq" });
  } catch (err) {
    console.error("Agent endpoint error:", err.message);
    res.json({ explanation: fallbackExplanation(task, context), source: "fallback" });
  }
});

function fallbackExplanation(task, context) {
  context = context || {};
  if (task === "driver-assignment") {
    return "Assigned " + (context.driverName || "your driver") + " — predicted " +
      (context.reliability != null ? context.reliability : "high") +
      "% reliable based on cancellation history, demand, and trip distance.";
  }
  if (task === "demand") {
    return "Demand nearby is currently " + (context.demandLevel || "moderate") +
      ", so drivers were prepositioned to reduce your wait time.";
  }
  if (task === "safety") {
    return context.deviation
      ? "Route deviation detected — this trip is being monitored closely."
      : "This trip is tracking the planned route normally.";
  }
  return "The AI agent is monitoring your trip.";
}

// ---------------------------------------------------------------------------
// Support chat endpoint
// ---------------------------------------------------------------------------
// Emergency messages are caught with a keyword check BEFORE anything touches
// the LLM. This guarantees the helpline info comes back instantly and
// reliably — it never depends on Groq being reachable, fast, or even
// configured. Everything else is routed to the LLM for a normal, contextual
// support answer.
const EMERGENCY_KEYWORDS = [
  "emergency", "accident", "unsafe", "danger", "sos", "help me",
  "assault", "harass", "police", "threat", "kidnap", "attacked",
  "stranded", "robbed", "scared", "following me"
];

const EMERGENCY_REPLY =
  "🚨 If you're in immediate danger, call 112 (India's National Emergency Number) or 100 (Police) right now. " +
  "You can also tap \"Alert emergency contact\" on your active trip screen to notify your saved contact instantly. " +
  "Stay on the line with them if you can, and share your live location. I'm here if you need anything else.";

function isEmergencyMessage(msg) {
  const lower = (msg || "").toLowerCase();
  return EMERGENCY_KEYWORDS.some((k) => lower.indexOf(k) !== -1);
}

function fallbackSupportReply() {
  return "I'm here to help with bookings, fares, cancellations, and safety features — " +
    "ask me anything about go_travels. (AI is running in offline/fallback mode right now.)";
}

app.post("/api/support-chat", async (req, res) => {
  const { message, history } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  // Highest priority: emergency detection, answered instantly, no LLM call.
  if (isEmergencyMessage(message)) {
    return res.json({ reply: EMERGENCY_REPLY, emergency: true });
  }

  if (!process.env.GROQ_API_KEY) {
    return res.json({ reply: fallbackSupportReply(), emergency: false });
  }

  try {
    const systemPrompt =
      "You are the AI customer support assistant for go_travels, a cab-booking app in India. " +
      "Help with questions about booking rides, fares, cancellations, payment methods (UPI, card, cash, points), " +
      "and safety features. Keep replies to 2-4 short sentences, friendly and specific to go_travels. " +
      "If anything resembling an emergency or unsafe situation comes up, always lead with: call 112 or 100 immediately, " +
      "and mention the in-app 'Alert emergency contact' button.";

    const messages = [{ role: "system", content: systemPrompt }];
    (Array.isArray(history) ? history.slice(-8) : []).forEach((h) => {
      if (h && h.role && h.content) messages.push({ role: h.role, content: String(h.content) });
    });
    messages.push({ role: "user", content: String(message) });

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + process.env.GROQ_API_KEY
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages,
        max_tokens: 250,
        temperature: 0.6
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      throw new Error("Groq API error " + groqRes.status + ": " + errText);
    }

    const data = await groqRes.json();
    const reply =
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim() ||
      fallbackSupportReply();

    res.json({ reply, emergency: false });
  } catch (err) {
    console.error("Support chat error:", err.message);
    res.json({ reply: fallbackSupportReply(), emergency: false });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
=======
const express = require("express");
const path = require("path");

const app = express();

app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
>>>>>>> 42beb36f5b10186e859d004bab219e62a5e92d72
