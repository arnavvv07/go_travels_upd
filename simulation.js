// ---------------------------------------------------------------------------
// Live traffic & demand simulation engine
// ---------------------------------------------------------------------------
// Models traffic congestion, rider demand, and weather across a handful of
// named Chennai zones, evolving over time. This serves two purposes:
//   1. Drives the "live conditions" badge shown in the app (visible simulation)
//   2. Generates realistic synthetic training data for the fare ML model
//
// This is a simulation, not real traffic data — it's built to behave
// plausibly (rush-hour spikes, weekday vs weekend patterns, occasional rain)
// so the ML model has real structure to learn from.

const ZONES = [
    { name: "Vandalur / VIT Chennai", lat: 12.8996, lng: 80.0817 },
    { name: "Tambaram",               lat: 12.9249, lng: 80.1000 },
    { name: "Guindy",                 lat: 13.0067, lng: 80.2206 },
    { name: "T Nagar",                lat: 13.0418, lng: 80.2341 },
    { name: "Anna Nagar",             lat: 13.0850, lng: 80.2101 },
    { name: "Chennai Airport",        lat: 12.9941, lng: 80.1709 },
    { name: "Chennai Central",        lat: 13.0827, lng: 80.2751 },
    { name: "OMR / Sholinganallur",   lat: 12.9010, lng: 80.2279 }
];

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Base traffic curve across a 24h day (0 = free-flowing, 1 = gridlock).
// Two rush-hour bumps: ~8-10am and ~6-9pm.
function baseTrafficForHour(hour) {
    const morning = Math.exp(-Math.pow(hour - 9, 2) / 4) * 0.75;
    const evening = Math.exp(-Math.pow(hour - 19, 2) / 5) * 0.85;
    const floor = 0.15;
    return clamp(floor + morning + evening, 0, 1);
}

// Base demand curve — similar shape but shifted slightly, plus weekend nights
function baseDemandForHour(hour, isWeekend) {
    const morning = Math.exp(-Math.pow(hour - 9, 2) / 5) * 0.6;
    const evening = Math.exp(-Math.pow(hour - 19, 2) / 6) * 0.7;
    const nightlife = isWeekend ? Math.exp(-Math.pow(hour - 23, 2) / 6) * 0.5 : 0;
    const floor = 0.2;
    return clamp(floor + morning + evening + nightlife, 0, 1);
}

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ---------------------------------------------------------------------------
// Live state — evolves every tick, drifting toward the current base curve
// with a bit of random noise per zone, plus an independent chance of rain.
// ---------------------------------------------------------------------------

let liveState = ZONES.map(z => ({
    ...z,
    traffic: 0.3,
    demand: 0.3,
    raining: false
}));

function tick() {
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const isWeekend = [0, 6].includes(now.getDay());

    liveState = liveState.map(z => {
        const targetTraffic = baseTrafficForHour(hour);
        const targetDemand = baseDemandForHour(hour, isWeekend);

        // drift toward target with noise, rather than snapping instantly —
        // makes the "live" feed look organic rather than robotic
        const traffic = clamp(z.traffic + (targetTraffic - z.traffic) * 0.3 + (Math.random()-0.5)*0.06, 0, 1);
        const demand = clamp(z.demand + (targetDemand - z.demand) * 0.3 + (Math.random()-0.5)*0.06, 0, 1);

        let raining = z.raining;
        if (Math.random() < 0.01) raining = !raining; // rare toggle

        return { ...z, traffic, demand, raining };
    });
}

// evolve the simulation every 8 seconds
setInterval(tick, 8000);
tick(); // seed with a real value immediately instead of waiting 8s

function nearestZone(lat, lng) {
    if (lat == null || lng == null) return liveState[0];
    let best = liveState[0], bestDist = Infinity;
    for (const z of liveState) {
        const d = haversineKm(lat, lng, z.lat, z.lng);
        if (d < bestDist) { bestDist = d; best = z; }
    }
    return best;
}

function levelLabel(v) {
    if (v < 0.35) return "Low";
    if (v < 0.65) return "Moderate";
    return "High";
}

function getZoneStatus(lat, lng) {
    const z = nearestZone(lat, lng);
    return {
        zone: z.name,
        traffic: Math.round(z.traffic * 100) / 100,
        demand: Math.round(z.demand * 100) / 100,
        raining: z.raining,
        trafficLabel: levelLabel(z.traffic),
        demandLabel: levelLabel(z.demand)
    };
}

function getCitySummary() {
    const avgTraffic = liveState.reduce((s, z) => s + z.traffic, 0) / liveState.length;
    const avgDemand = liveState.reduce((s, z) => s + z.demand, 0) / liveState.length;
    const anyRain = liveState.some(z => z.raining);
    return {
        traffic: Math.round(avgTraffic * 100) / 100,
        demand: Math.round(avgDemand * 100) / 100,
        raining: anyRain,
        trafficLabel: levelLabel(avgTraffic),
        demandLabel: levelLabel(avgDemand),
        zones: liveState.map(z => ({
            name: z.name,
            traffic: Math.round(z.traffic * 100) / 100,
            demand: Math.round(z.demand * 100) / 100,
            raining: z.raining
        }))
    };
}

// ---------------------------------------------------------------------------
// Synthetic training data generator for the ML fare model.
// Produces a plausible "historical trip" with a ground-truth fare multiplier
// that depends on traffic, demand, weather, and distance — the model is
// trained to recover this relationship from the features alone.
// ---------------------------------------------------------------------------

function generateTrainingSample() {
    const distanceKm = 1 + Math.random() * 29;
    const hour = Math.random() * 24;
    const dayOfWeek = Math.floor(Math.random() * 7);
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    const traffic = clamp(baseTrafficForHour(hour) + (Math.random()-0.5)*0.25, 0, 1);
    const demand = clamp(baseDemandForHour(hour, isWeekend) + (Math.random()-0.5)*0.25, 0, 1);
    const raining = Math.random() < 0.12;

    // ground-truth relationship the model has to learn
    let multiplier = 1
        + 0.35 * traffic
        + 0.45 * demand
        + (raining ? 0.15 : 0)
        - 0.002 * distanceKm
        + (Math.random() - 0.5) * 0.08; // measurement noise

    multiplier = clamp(multiplier, 0.75, 1.85);

    return {
        features: [distanceKm / 30, hour / 24, dayOfWeek / 7, traffic, demand, raining ? 1 : 0],
        label: multiplier
    };
}

module.exports = {
    getZoneStatus,
    getCitySummary,
    generateTrainingSample,
    ZONES
};
