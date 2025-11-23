import "dotenv/config";
import fs from "fs/promises";

const {
    ADSTERRA_API_KEY,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
} = process.env;

if (!ADSTERRA_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("ENV belum lengkap. Cek .env");
    process.exit(1);
}

const STATE_FILE = "last_impressions.json";

/* ======================= KURS USD ➜ IDR ======================= */
async function getUsdToIdrRate() {
    const cacheFile = "forex_cache.json";
    const fallback = 16000;

    // pakai cache dulu
    try {
        const { date, rate } = JSON.parse(await fs.readFile(cacheFile, "utf8"));
        const today = new Date().toISOString().slice(0, 10);
        if (date === today && rate > 0) return rate;
    } catch { }

    // ambil kurs dari API
    try {
        const res = await fetch("https://open.er-api.com/v6/latest/USD");
        const data = await res.json();
        const rate = Number(data.rates?.IDR);
        if (rate > 0) {
            await fs.writeFile(
                cacheFile,
                JSON.stringify({ date: new Date().toISOString().slice(0, 10), rate }, null, 2),
            );
            return rate;
        }
    } catch { }

    return fallback;
}

function getToday() {
    return new Date().toISOString().slice(0, 10);
}

/* ======================= ADSTERRA HELPERS ======================= */
async function getPlacementInfoMap() {
    const url = "https://api3.adsterratools.com/publisher/placements.json";

    const res = await fetch(url, {
        headers: {
            Accept: "application/json",
            "X-API-Key": ADSTERRA_API_KEY,
        },
    });

    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();
    const map = {};
    for (const p of data.items || []) {
        const id = String(p.id);
        const alias = p.alias?.trim();
        const title = p.title?.trim();
        map[id] = alias || title || `Placement ${id}`;
    }
    return map;
}

async function getStatsByPlacement(date) {
    const url =
        `https://api3.adsterratools.com/publisher/stats.json` +
        `?start_date=${date}&finish_date=${date}&group_by=placement`;

    const res = await fetch(url, {
        headers: {
            Accept: "application/json",
            "X-API-Key": ADSTERRA_API_KEY,
        },
    });

    if (!res.ok) throw new Error(await res.text());
    return await res.json();
}

/* ======================= STATE HANDLING ======================= */
async function loadState() {
    try {
        const obj = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
        const placements = {};
        for (const [id, val] of Object.entries(obj.placements || {})) {
            placements[id] = {
                impr: Number(val.impr || 0),
                rev: Number(val.rev || 0),
            };
        }
        return { date: obj.date || "", placements };
    } catch {
        return { date: "", placements: {} };
    }
}

async function saveState(state) {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/* ======================= TELEGRAM ======================= */
async function sendTelegram(text) {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text,
            parse_mode: "Markdown",
        }),
    });
}

/* ======================= MAIN ======================= */
(async () => {
    try {
        const today = getToday();
        const rate = await getUsdToIdrRate(); // kurs otomatis

        const [placementMap, statsPlacement, stateOld] = await Promise.all([
            getPlacementInfoMap(),
            getStatsByPlacement(today),
            loadState(),
        ]);

        const items = statsPlacement.items || [];
        const prev = stateOld.date === today ? stateOld.placements : {};

        const newState = { date: today, placements: {} };
        const increased = [];

        for (const row of items) {
            const id = String(row.placement);
            const name = placementMap[id] || id;

            const impr = Number(row.impression || 0);
            const rev = Number(row.revenue || 0);

            const prevImpr = prev[id]?.impr ?? 0;
            const prevRev = prev[id]?.rev ?? 0;

            const deltaImpr = impr - prevImpr;
            const deltaRev = rev - prevRev;

            newState.placements[id] = { impr, rev };

            if (deltaImpr > 0 || deltaRev > 0) {
                increased.push({
                    id,
                    name,
                    deltaImpr,
                    deltaRevIDR: deltaRev * rate,
                });
            }
        }

        await saveState(newState);

        // kalau tidak ada peningkatan
        if (increased.length === 0) {
            console.log("Tidak ada peningkatan impression / revenue.");
            return;
        }

        // kirim satu pesan per placement
        for (const p of increased) {
            const { name, id, deltaImpr, deltaRevIDR } = p;

            const msg =
                `👤 ${name}
ID Placement : ${id}
+ Impression : ${deltaImpr}
+ Revenue    : Rp ${deltaRevIDR.toLocaleString("id-ID")}
`;

            await sendTelegram(msg);
        }

        console.log("Notifikasi terkirim (IDR active ✓)");
    } catch (err) {
        console.error("ERROR:", err.message);
    }
})();
