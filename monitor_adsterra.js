import "dotenv/config";

const {
    ADSTERRA_API_KEY,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
} = process.env;

if (!ADSTERRA_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("ENV belum lengkap. Cek file .env");
    process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);

// ========== AMBIL MAP ID -> ALIAS ==========
async function getPlacementNameMap() {
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
        map[id] = name;
    }

    return map;
}

// ========== AMBIL STATISTIK PER PLACEMENT ==========
async function getAdsterraStats() {
    const url =
        `https://api3.adsterratools.com/publisher/stats.json` +
        `?start_date=${today}` +
        `&finish_date=${today}` +
        `&group_by=placement`;

    const res = await fetch(url, {
        headers: {
            Accept: "application/json",
            "X-API-Key": ADSTERRA_API_KEY,
        },
    });

    if (!res.ok) throw new Error(`Stats ${res.status}: ${await res.text()}`);

    return await res.json();
}

// ========== KIRIM TELEGRAM ==========
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

// ========== MAIN ==========
(async () => {
    try {
        const nameMap = await getPlacementNameMap();
        const stats = await getAdsterraStats();
        const items = stats.items || [];

        let totalImpr = 0;
        let totalClk = 0;
        let totalRev = 0;

        let body = "";

        for (const row of items) {
            const id = String(row.placement);
            const name = nameMap[id] || id;

            const impr = Number(row.impression || 0);
            const clk = Number(row.clicks || 0);
            const rev = Number(row.revenue || 0);
            const cpmApi = Number(row.cpm || 0);
            const cpmCalc = impr > 0 ? (1000 * rev) / impr : 0;

            totalImpr += impr;
            totalClk += clk;
            totalRev += rev;

            body +=
                `nama : ${name}
id        : ${id}
Impression: ${impr}
Clicks    : ${clk}
Revenue   : $${rev.toFixed(3)}
CPM (API) : $${cpmApi.toFixed(3)}
CPM (calc): $${cpmCalc.toFixed(3)}

`;
        }

        const totalCpm = totalImpr > 0 ? (1000 * totalRev) / totalImpr : 0;

        const header =
            `*Laporan CPM Adsterra (Smartlink) Agung Satrio*
Tanggal: ${today}

`;

        const footer =
            `total
Impression: ${totalImpr}
Clicks    : ${totalClk}
Revenue   : $${totalRev.toFixed(3)}
CPM (API) : $${totalCpm.toFixed(3)}
CPM (calc): $${totalCpm.toFixed(3)}
`;

        await sendTelegram(header + body + footer);
        console.log("Laporan CPM terkirim ke Telegram ✓");
    } catch (err) {
        console.error("ERROR:", err.message);
    }
})();
