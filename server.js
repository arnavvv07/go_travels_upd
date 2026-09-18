require("dotenv").config();

const express = require("express");
const path = require("path");
const db = require("./db");
const sim = require("./simulation");
const mlFareModel = require("./ml-fare-model");

const app = express();

// Groq model used for every AI call below. The old model (llama-3.3-70b-versatile)
// was shut down by Groq on 16 Aug 2026, which caused the "Groq API error 404".
// You can change it later from Render's Environment tab (GROQ_MODEL) without editing code.
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

app.use(express.json());
app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// ---------------------------------------------------------------------------
// Agentic booking: parse a natural-language command into pickup/drop/date/time
// ---------------------------------------------------------------------------

const WEEKDAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];


// removes leftover phrases like "two passenger" or "1 luggage bag" from the end of a location
function cleanLocation(place) {
    if (!place) return place;
    var cleaned = place.replace(/\s+(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:passengers?|people|persons?|pax|bags?|luggage|suitcases?)\b.*$/i, "");
    cleaned = cleaned.replace(/\s+(?:and|with|for)$/i, "");
    return cleaned.trim();
}

function fallbackParseBooking(command, nowISO) {
    var now = nowISO ? new Date(nowISO) : new Date();
    var text = String(command || "");
    var lower = text.toLowerCase();

    var result = { pickup: null, drop: null, date: null, time: null, passengers: null, luggage: null, source: "fallback" };

    // "from X to Y" — also handles "to Y from X". "with"/"for" are included as
    // stop words so trailing clauses like "...to Y with 2 bags" don't get
    // swallowed into the location text.
    var stopWords = "(?:on|at|tomorrow|today|tonight|by|next|with|for|" + WEEKDAYS.join("|") + ")";
    var fromTo = lower.match(new RegExp("from\\s+(.+?)\\s+to\\s+(.+?)(?:\\s+" + stopWords + "\\b|[.,]|$)", "i"));
    if (fromTo) {
        result.pickup = titleCaseFromOriginal(text, fromTo[1]);
        result.drop = titleCaseFromOriginal(text, fromTo[2]);
    } else {
        var toFrom = lower.match(new RegExp("to\\s+(.+?)\\s+from\\s+(.+?)(?:\\s+" + stopWords + "\\b|[.,]|$)", "i"));
        if (toFrom) {
            result.drop = titleCaseFromOriginal(text, toFrom[1]);
            result.pickup = titleCaseFromOriginal(text, toFrom[2]);
        }
    }

    result.pickup = cleanLocation(result.pickup);
    result.drop = cleanLocation(result.drop);

    // date
    function pad(n){ return String(n).padStart(2, "0"); }
    function isoDate(d){ return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()); }

    if (/\btomorrow\b/.test(lower)) {
        var t = new Date(now); t.setDate(t.getDate()+1);
        result.date = isoDate(t);
    } else if (/\btoday\b|\btonight\b/.test(lower)) {
        result.date = isoDate(now);
    } else {
        for (var i=0;i<WEEKDAYS.length;i++){
            if (lower.indexOf(WEEKDAYS[i]) !== -1) {
                var target = i, cur = now.getDay();
                var diff = (target - cur + 7) % 7 || 7;
                var d2 = new Date(now); d2.setDate(d2.getDate()+diff);
                result.date = isoDate(d2);
                break;
            }
        }
    }
    var explicitDate = lower.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if (explicitDate && !result.date) {
        var dd = explicitDate[1].padStart(2,"0"), mm = explicitDate[2].padStart(2,"0");
        var yyyy = explicitDate[3] ? (explicitDate[3].length===2 ? "20"+explicitDate[3] : explicitDate[3]) : now.getFullYear();
        result.date = yyyy + "-" + mm + "-" + dd;
    }

    // time — "6pm", "6:30 pm", "18:00"
    var timeMatch = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
    if (timeMatch) {
        var hh = parseInt(timeMatch[1],10);
        var min = timeMatch[2] || "00";
        var ap = timeMatch[3];
        if (ap === "pm" && hh !== 12) hh += 12;
        if (ap === "am" && hh === 12) hh = 0;
        result.time = pad(hh) + ":" + min;
    } else {
        var time24 = lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
        if (time24) result.time = pad(parseInt(time24[1],10)) + ":" + time24[2];
    }

    // Spoken numbers often come through as words ("two", "six") rather than
    // digits — normalize a separate copy of the text so passenger/luggage
    // extraction works regardless of how it was said. (Kept separate from
    // `lower`/`text` above so location extraction still indexes correctly
    // against the original wording.)
    var NUM_WORDS = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12 };
    var normalizedNums = lower.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g,
        function(w){ return String(NUM_WORDS[w]); });

    // passengers — "3 passengers", "for 2 people", "party of 4", "in two passenger"
    var paxMatch = normalizedNums.match(/\b(\d+)\s*(?:passengers?|people|persons?|pax)\b/) ||
                    normalizedNums.match(/\bparty of\s*(\d+)\b/) ||
                    normalizedNums.match(/\bfor\s*(\d+)\s*(?:of us)?\b(?=.*(?:passenger|people|person|going|travel))/);
    if (paxMatch) result.passengers = parseInt(paxMatch[1], 10);

    // luggage — "2 bags", "3 luggage", "1 suitcase"
    var luggageMatch = normalizedNums.match(/\b(\d+)\s*(?:bags?|luggage|suitcases?|bagages?)\b/);
    if (luggageMatch) result.luggage = parseInt(luggageMatch[1], 10);

    // payment method, if mentioned
    if (/\bupi\b/.test(normalizedNums)) result.paymentMethod = "upi";
    else if (/\bcash\b/.test(normalizedNums)) result.paymentMethod = "cash";
    else if (/\bdebit\b/.test(normalizedNums)) result.paymentMethod = "debit";
    else if (/\bcredit\b/.test(normalizedNums)) result.paymentMethod = "credit";
    else if (/\bpoints?\b/.test(normalizedNums)) result.paymentMethod = "points";
    else if (/\bcard\b/.test(normalizedNums)) result.paymentMethod = "card";
    else result.paymentMethod = null;

    // whether this sounds like a direct booking instruction ("book a cab...")
    // vs just providing details — used by the frontend to decide whether to
    // auto-complete the booking or just fill the form for review
    result.bookIntent = /\bbook\b/.test(normalizedNums);

    return result;
}

// crude helper to recover original casing for the matched substring
function titleCaseFromOriginal(originalText, lowerMatch) {
    var cleaned = lowerMatch.trim().replace(/\s+(tomorrow|today|tonight)$/i, "");
    var idx = originalText.toLowerCase().indexOf(cleaned);
    if (idx === -1) return cleaned;
    return originalText.substr(idx, cleaned.length).trim();
}

app.post("/api/parse-booking", async (req, res) => {
    const { command, now } = req.body || {};

    if (!command || !String(command).trim()) {
        return res.status(400).json({ error: "command is required" });
    }

    if (!process.env.GROQ_API_KEY) {
        return res.json(fallbackParseBooking(command, now));
    }

    try {
        const systemPrompt =
            "You extract structured ride-booking details from a rider's natural-language request for an " +
            "Indian cab-booking app. The current date/time (ISO) will be given so you can resolve relative " +
            "dates like 'tomorrow' or 'next Friday'. Reply with ONLY a JSON object, no other text, in this " +
            'exact shape: {"pickup": string|null, "drop": string|null, "date": "YYYY-MM-DD"|null, "time": "HH:MM"|null, ' +
            '"passengers": number|null, "luggage": number|null, "paymentMethod": "upi"|"card"|"cash"|"debit"|"credit"|"points"|null, ' +
            '"bookIntent": boolean} (24-hour time). bookIntent is true if the rider is directly instructing a booking ' +
            '(e.g. "book a cab...", "get me a ride...") rather than just describing details. Use null for anything not mentioned. ' +
            "Do not invent locations, passenger counts, or luggage counts that weren't said.";

        const userPrompt = "Current date/time: " + (now || new Date().toISOString()) + "\nRequest: " + command;

        const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + process.env.GROQ_API_KEY
            },
            body: JSON.stringify({
                model: GROQ_MODEL,
                reasoning_effort: "low",
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt }
                ],
                max_tokens: 1000,
                temperature: 0.1,
                response_format: { type: "json_object" }
            })
        });

        if (!groqRes.ok) {
            throw new Error("Groq API error " + groqRes.status);
        }

        const data = await groqRes.json();
        const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        const parsed = JSON.parse(raw);

        res.json({
            pickup: parsed.pickup || null,
            drop: parsed.drop || null,
            date: parsed.date || null,
            passengers: parsed.passengers != null ? parsed.passengers : null,
            luggage: parsed.luggage != null ? parsed.luggage : null,
            paymentMethod: parsed.paymentMethod || null,
            bookIntent: !!parsed.bookIntent,
            time: parsed.time || null,
            source: "groq"
        });
    } catch (err) {
        console.error("Parse-booking error:", err.message);
        res.json(fallbackParseBooking(command, now));
    }
});

// ---------------------------------------------------------------------------
// Live traffic/demand status (simulation)
// ---------------------------------------------------------------------------

app.get("/api/traffic-status", (req, res) => {
    const lat = req.query.lat ? parseFloat(req.query.lat) : null;
    const lng = req.query.lng ? parseFloat(req.query.lng) : null;

    if (lat != null && lng != null) {
        return res.json(sim.getZoneStatus(lat, lng));
    }
    res.json(sim.getCitySummary());
});

// ---------------------------------------------------------------------------
// ML fare prediction — base fare × AI-predicted demand/traffic multiplier
// ---------------------------------------------------------------------------

app.post("/api/predict-fare", (req, res) => {
    const { distanceKm, baseFare, pickupLat, pickupLng } = req.body || {};

    if (distanceKm == null || baseFare == null) {
        return res.status(400).json({ error: "distanceKm and baseFare are required" });
    }

    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay();
    const zoneStatus = sim.getZoneStatus(pickupLat, pickupLng);

    const info = mlFareModel.getTrainingInfo();

    if (!info.ready) {
        // model still training (very brief window right at server startup) —
        // fall back to a plain 1x multiplier rather than erroring out
        return res.json({
            multiplier: 1,
            predictedFare: Math.round(baseFare),
            traffic: zoneStatus.traffic,
            demand: zoneStatus.demand,
            raining: zoneStatus.raining,
            trafficLabel: zoneStatus.trafficLabel,
            demandLabel: zoneStatus.demandLabel,
            zone: zoneStatus.zone,
            modelReady: false
        });
    }

    const features = [
        Math.min(distanceKm, 30) / 30,
        hour / 24,
        dayOfWeek / 7,
        zoneStatus.traffic,
        zoneStatus.demand,
        zoneStatus.raining ? 1 : 0
    ];

    const multiplier = mlFareModel.predictMultiplier(features);
    const predictedFare = Math.round(baseFare * multiplier);

    res.json({
        multiplier,
        predictedFare,
        traffic: zoneStatus.traffic,
        demand: zoneStatus.demand,
        raining: zoneStatus.raining,
        trafficLabel: zoneStatus.trafficLabel,
        demandLabel: zoneStatus.demandLabel,
        zone: zoneStatus.zone,
        modelReady: true
    });
});

// ---------------------------------------------------------------------------
// Routing proxy — OpenRouteService if ORS_API_KEY is set, else falls back to
// the free public OSRM demo server. Kept server-side so the ORS key never
// ships to the browser.
// ---------------------------------------------------------------------------

app.post("/api/route", async (req, res) => {
    const { pickupLat, pickupLng, dropLat, dropLng } = req.body || {};

    if ([pickupLat, pickupLng, dropLat, dropLng].some(v => v == null)) {
        return res.status(400).json({ error: "pickupLat, pickupLng, dropLat, dropLng are required" });
    }

    if (process.env.ORS_API_KEY) {
        try {
            const orsRes = await fetch(
                "https://api.openrouteservice.org/v2/directions/driving-car/geojson",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": process.env.ORS_API_KEY
                    },
                    body: JSON.stringify({
                        coordinates: [[pickupLng, pickupLat], [dropLng, dropLat]]
                    })
                }
            );

            if (!orsRes.ok) throw new Error("ORS API error " + orsRes.status);

            const data = await orsRes.json();
            const feature = data.features && data.features[0];
            if (!feature) throw new Error("ORS returned no route");

            const distanceKm = Math.round((feature.properties.summary.distance / 1000) * 10) / 10;
            const coords = feature.geometry.coordinates.map(c => [c[1], c[0]]); // [lng,lat] -> [lat,lng]

            return res.json({ distanceKm, coords, source: "ors" });
        } catch (err) {
            console.error("ORS routing error, falling back to OSRM:", err.message);
            // fall through to OSRM fallback below
        }
    }

    try {
        const osrmRes = await fetch(
            `https://router.project-osrm.org/route/v1/driving/${pickupLng},${pickupLat};${dropLng},${dropLat}?overview=full&geometries=geojson`
        );
        const data = await osrmRes.json();
        if (!data.routes || !data.routes.length) throw new Error("OSRM returned no route");

        const distanceKm = Math.round((data.routes[0].distance / 1000) * 10) / 10;
        const coords = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);

        res.json({ distanceKm, coords, source: "osrm" });
    } catch (err) {
        console.error("Routing error:", err.message);
        res.status(500).json({ error: "Could not calculate route" });
    }
});

// ---------------------------------------------------------------------------
// Login tracking endpoint
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

// ---------------------------------------------------------------------------
// Login statistics endpoint
// ---------------------------------------------------------------------------

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

app.post("/api/agent", async (req, res) => {
    const { task, context } = req.body || {};

    if (!process.env.GROQ_API_KEY) {
        return res.json({
            explanation: fallbackExplanation(task, context),
            source: "fallback"
        });
    }

    try {
        const systemPrompt =
            "You are the AI dispatch agent inside an Indian cab-booking app called go_travels. " +
            "You are given structured JSON describing a prediction the app's own scoring logic already made " +
            "(driver reliability, demand level, or safety status). Explain that decision to the rider in " +
            "ONE short paragraph, max 3 sentences, plain and reassuring. Do not dump the raw JSON back.";

        const userPrompt =
            "Task: " +
            task +
            "\nContext: " +
            JSON.stringify(context);

        const groqRes = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization":
                        "Bearer " + process.env.GROQ_API_KEY
                },
                body: JSON.stringify({
                    model: GROQ_MODEL,
                reasoning_effort: "low",
                    messages: [
                        {
                            role: "system",
                            content: systemPrompt
                        },
                        {
                            role: "user",
                            content: userPrompt
                        }
                    ],
                    max_tokens: 800,
                    temperature: 0.5
                })
            }
        );

        if (!groqRes.ok) {
            const errText = await groqRes.text();
            throw new Error(
                "Groq API error " +
                    groqRes.status +
                    ": " +
                    errText
            );
        }

        const data = await groqRes.json();

        const explanation =
            (
                data.choices &&
                data.choices[0] &&
                data.choices[0].message &&
                data.choices[0].message.content
                    ? data.choices[0].message.content
                    : ""
            ).trim() || fallbackExplanation(task, context);

        res.json({
            explanation,
            source: "groq"
        });
    } catch (err) {
        console.error("Agent endpoint error:", err.message);

        res.json({
            explanation: fallbackExplanation(task, context),
            source: "fallback"
        });
    }
});

function fallbackExplanation(task, context) {
    context = context || {};

    if (task === "driver-assignment") {
        return (
            "Assigned " +
            (context.driverName || "your driver") +
            " — predicted " +
            (context.reliability != null
                ? context.reliability
                : "high") +
            "% reliable based on cancellation history, demand, and trip distance."
        );
    }

    if (task === "demand") {
        return (
            "Demand nearby is currently " +
            (context.demandLevel || "moderate") +
            ", so drivers were prepositioned to reduce your wait time."
        );
    }

    if (task === "safety") {
        return context.deviation
            ? "Route deviation detected — this trip is being monitored closely."
            : "This trip is tracking the planned route normally.";
    }

    return "The AI agent is monitoring your trip.";
}

// ---------------------------------------------------------------------------
// Support Chat
// ---------------------------------------------------------------------------

const EMERGENCY_KEYWORDS = [
    "emergency",
    "accident",
    "unsafe",
    "danger",
    "sos",
    "help me",
    "assault",
    "harass",
    "police",
    "threat",
    "kidnap",
    "attacked",
    "stranded",
    "robbed",
    "scared",
    "following me"
];

const EMERGENCY_REPLY =
    "🚨 If you're in immediate danger, call 112 (India's National Emergency Number) or 100 (Police) right now. " +
    'You can also tap "Alert emergency contact" on your active trip screen to notify your saved contact instantly. ' +
    "Stay on the line with them if you can, and share your live location. I'm here if you need anything else.";

function isEmergencyMessage(msg) {
    const lower = (msg || "").toLowerCase();

    return EMERGENCY_KEYWORDS.some((keyword) =>
        lower.includes(keyword)
    );
}

function fallbackSupportReply() {
    return (
        "I'm here to help with bookings, fares, cancellations, and safety features — " +
        "ask me anything about go_travels. " +
        "(AI is running in offline/fallback mode right now.)"
    );
}

// ---------------------------------------------------------------------------
// Support Chat API
// ---------------------------------------------------------------------------

app.post("/api/support-chat", async (req, res) => {
    const { message, history } = req.body || {};

    if (!message || !String(message).trim()) {
        return res.status(400).json({
            error: "message is required"
        });
    }

    // Emergency detection happens before the AI call.
    if (isEmergencyMessage(message)) {
        return res.json({
            reply: EMERGENCY_REPLY,
            emergency: true
        });
    }

    // Fallback if Groq API key isn't configured.
    if (!process.env.GROQ_API_KEY) {
        return res.json({
            reply: fallbackSupportReply(),
            emergency: false
        });
    }

    try {
        const systemPrompt =
            "You are the AI customer support assistant for go_travels, a cab-booking app in India. " +
            "Help with questions about booking rides, fares, cancellations, payment methods (UPI, card, cash, points), " +
            "and safety features. Keep replies to 2-4 short sentences, friendly and specific to go_travels. " +
            "If anything resembling an emergency or unsafe situation comes up, always lead with: call 112 or 100 immediately, " +
            "and mention the in-app 'Alert emergency contact' button.";

        const messages = [
            {
                role: "system",
                content: systemPrompt
            }
        ];

        (Array.isArray(history) ? history.slice(-8) : []).forEach(
            (h) => {
                if (h && h.role && h.content) {
                    messages.push({
                        role: h.role,
                        content: String(h.content)
                    });
                }
            }
        );

        messages.push({
            role: "user",
            content: String(message)
        });

        const groqRes = await fetch(
            "https://api.groq.com/openai/v1/chat/completions",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization":
                        "Bearer " + process.env.GROQ_API_KEY
                },
                body: JSON.stringify({
                    model: GROQ_MODEL,
                reasoning_effort: "low",
                    messages,
                    max_tokens: 800,
                    temperature: 0.6
                })
            }
        );

        if (!groqRes.ok) {
            const errText = await groqRes.text();

            throw new Error(
                "Groq API error " +
                    groqRes.status +
                    ": " +
                    errText
            );
        }

        const data = await groqRes.json();

        const reply =
            (
                data.choices &&
                data.choices[0] &&
                data.choices[0].message &&
                data.choices[0].message.content
                    ? data.choices[0].message.content
                    : ""
            ).trim() || fallbackSupportReply();

        res.json({
            reply,
            emergency: false
        });
    } catch (err) {
        console.error("Support chat error:", err.message);

        res.json({
            reply: fallbackSupportReply(),
            emergency: false
        });
    }
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

async function start() {
    console.log("[startup] training fare adjustment model on simulated trip data...");
    await mlFareModel.trainModel(4000);

    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}

start();
