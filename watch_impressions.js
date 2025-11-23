import "dotenv/config";
import fs from "fs/promises";

const {
    ADSTERRA_API_KEY,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
} = process.env;

if (!ADSTERRA_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("ENV belum lengkap. Cek .env atau GitHub Secrets");
    process.exit(1);
}

const STATE_FILE = "last_impressions.json";

function getToday() {
    return new Date().toISOString().slice(0, 10);
}

/* ============ ADSTERRA HELPERS ============ */

// Map placementId -> { name, domainId }
async function getPlacementInfoMap() {
    const url = "https://api3.adsterratools.com/publisher/placements.json";

    const res = await fetch(url, {
        headers: {
            Accept: "application/json",
            "X-API-Key": ADSTERRA_API_KEY,
        },
    });

    if (!res.ok) throw new Error(`Placements ${res.status}: ${await res.text()}`);

    const data = await res.json();
    const list = Array.isArray(data.items) ? data.items : [];

    const map = {};
    for (const p of list) {
        const id = String(p.id);
        const alias = p.alias?.trim();
        const title = p.title?.trim();
        const name = alias || title || `Placement ${id}`;
        const domainId = p.domain_id;
        map[id] = { name, domainId };
    }
    return map;
}

// Stats harian per placement (untuk cek delta impression & revenue)
async function getStatsByPlacement(date) {
    const url =
        `https://api3.adsterratools.com/publisher/stats.json` +
        `?start_date=${date}` +
        `&finish_date=${date}` +
        `&group_by=placement`;

    const res = await fetch(url, {
        headers: {
            Accept: "application/json",
            "X-API-Key": ADSTERRA_API_KEY,
        },
    });

    if (!res.ok)
        throw new Error(`Stats(placement) ${res.status}: ${await res.text()}`);

    return await res.json();
}

/* ============ STATE HELPERS ============ */

// state: { date: 'YYYY-MM-DD', placements: { [id]: { impr, rev } } }
async function loadState() {
    try {
        const txt = await fs.readFile(STATE_FILE, "utf8");
        const raw = JSON.parse(txt);

        // Backward compatibility: kalau dulu cuma simpan angka
        const placements = {};
        for (const [id, val] of Object.entries(raw.placements || {})) {
            if (typeof val === "number") {
                placements[id] = { impr: val, rev: 0 };
            } else {
                placements[id] = {
                    impr: Number(val.impr || 0),
                    rev: Number(val.rev || 0),
                };
            }
        }

        return { date: raw.date || "", placements };
    } catch {
        return { date: "", placements: {} };
    }
}

async function saveState(state) {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/* ============ TELEGRAM ============ */

async function sendTelegram(text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text,
            parse_mode: "Markdown",
        }),
    });

    const result = await res.text();
    if (!res.ok) throw new Error(`Telegram ${res.status}: ${result}`);
}

/* ============ MAIN ============ */

(async () => {
    try {
        const today = getToday();

        const [placementMap, statsPlacement, stateOld] = await Promise.all([
            getPlacementInfoMap(),
            getStatsByPlacement(today),
            loadState(),
        ]);

        const items = statsPlacement.items || [];

        const prevPlacements =
            stateOld.date === today ? stateOld.placements || {} : {};

        const newState = { date: today, placements: {} };

        const increased = [];

        for (const row of items) {
            const id = String(row.placement);
            const info = placementMap[id] || { name: id, domainId: undefined };

            const impr = Number(row.impression || 0);
            const rev = Number(row.revenue || 0);

            const prev = prevPlacements[id] || { impr: 0, rev: 0 };
            const prevImpr = Number(prev.impr || 0);
            const prevRev = Number(prev.rev || 0);

            const deltaImpr = impr - prevImpr;
            const deltaRev = rev - prevRev;

            // simpan state baru
            newState.placements[id] = { impr, rev };

            if (deltaImpr > 0 || deltaRev > 0) {
                increased.push({
                    id,
                    name: info.name,
                    deltaImpr,
                    deltaRev,
                });
            }
        }

        await saveState(newState);

        if (increased.length === 0) {
            console.log("Tidak ada peningkatan impression/revenue baru.");
            process.exit(0);
        }

        for (const p of increased) {
            const { id, name, deltaImpr, deltaRev } = p;

            const msg =
                `👤: ${name}
ID Placement : ${id}
+ Impression : ${deltaImpr}
+ Revenue    : $${deltaRev.toFixed(3)}
`;

            await sendTelegram(msg);
        }

        console.log("Notifikasi sederhana terkirim per-ID.");
    } catch (err) {
        console.error("ERROR:", err.message);
    }
})();
