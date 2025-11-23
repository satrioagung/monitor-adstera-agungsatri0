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

/* ================== ADSTERRA HELPERS ================== */

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

// Stats harian per placement (untuk cek delta impression)
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

// Stats per placement di-breakdown by COUNTRY
async function getStatsForPlacementByCountry(date, placementId, domainId) {
    let url =
        `https://api3.adsterratools.com/publisher/stats.json` +
        `?start_date=${date}` +
        `&finish_date=${date}` +
        `&group_by=country` +
        `&placement=${placementId}`;

    if (domainId) url += `&domain=${domainId}`;

    const res = await fetch(url, {
        headers: {
            Accept: "application/json",
            "X-API-Key": ADSTERRA_API_KEY,
        },
    });

    if (!res.ok)
        throw new Error(`Stats(country) ${res.status}: ${await res.text()}`);

    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
}

/* ================== STATE HELPERS ================== */

async function loadState() {
    try {
        const txt = await fs.readFile(STATE_FILE, "utf8");
        return JSON.parse(txt);
    } catch {
        return { date: "", placements: {} };
    }
}

async function saveState(state) {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

/* ================== TELEGRAM ================== */

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

/* ================== MAIN ================== */

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

        let totalImpr = 0;
        let totalClk = 0;
        let totalRev = 0;

        const increased = [];

        for (const row of items) {
            const id = String(row.placement);
            const info = placementMap[id] || { name: id, domainId: undefined };

            const impr = Number(row.impression || 0);
            const clk = Number(row.clicks || 0);
            const rev = Number(row.revenue || 0);

            const prevImpr = Number(prevPlacements[id] || 0);
            const delta = impr - prevImpr;

            newState.placements[id] = impr;

            totalImpr += impr;
            totalClk += clk;
            totalRev += rev;

            if (delta > 0) {
                increased.push({
                    id,
                    name: info.name,
                    domainId: info.domainId,
                    impr,
                    clk,
                    rev,
                    cpmApi: Number(row.cpm || 0),
                    delta,
                });
            }
        }

        await saveState(newState);

        if (increased.length === 0) {
            console.log("Tidak ada peningkatan impression baru.");
            process.exit(0);
        }

        const totalCpm = totalImpr > 0 ? (1000 * totalRev) / totalImpr : 0;

        for (const p of increased) {
            const { id, name, domainId, impr, clk, rev, cpmApi, delta } = p;

            const byCountry = await getStatsForPlacementByCountry(
                today,
                id,
                domainId,
            );

            const cpmCalc = impr > 0 ? (1000 * rev) / impr : 0;

            const formatCountry = (rows, max = 5) =>
                rows
                    .slice(0, max)
                    .map((r) => {
                        const label = r.country || "unknown";
                        const i = Number(r.impression || 0);
                        const rv = Number(r.revenue || 0);
                        const cpm = Number(r.cpm || 0);
                        return `- ${label}: impr ${i}, rev $${rv.toFixed(
                            3,
                        )}, cpm $${cpm.toFixed(3)}`;
                    })
                    .join("\n") || "- (tidak ada data)";

            const msg =
                `*Update Impression Adsterra (Smartlink)*
Tanggal: ${today}

id : ${name}
ID Placement : ${id}
+Impression  : ${delta}

Impression: ${impr}
Clicks    : ${clk}
Revenue   : $${rev.toFixed(3)}
CPM (API) : $${cpmApi.toFixed(3)}
CPM (calc): $${cpmCalc.toFixed(3)}

*COUNTRY*
${formatCountry(byCountry)}

*DEVICE FORMAT*
- Tidak tersedia lewat Publisher API (hanya di dashboard web)

*OPERATING SYSTEM*
- Tidak tersedia lewat Publisher API (hanya di dashboard web)

*BROWSER*
- Tidak tersedia lewat Publisher API (hanya di dashboard web)

Total hari ini (semua placement)
Impression: ${totalImpr}
Clicks    : ${totalClk}
Revenue   : $${totalRev.toFixed(3)}
CPM (calc): $${totalCpm.toFixed(3)}
`;

            await sendTelegram(msg);
        }

        console.log(
            "Notifikasi peningkatan impression terkirim per-ID + breakdown COUNTRY.",
        );
    } catch (err) {
        console.error("ERROR:", err.message);
    }
})();