import "dotenv/config";
import fs from "fs/promises";

const {
    ADSTERRA_API_KEY,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
} = process.env;

if (!ADSTERRA_API_KEY || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("ENV belum lengkap. Cek file .env");
    process.exit(1);
}

/* ===================== KURS USD ➜ IDR ===================== */
async function getUsdToIdrRate() {
    const cacheFile = "forex_cache.json";
    const fallback = 16000; // jika API gagal

    // cek cache
    try {
        const { date, rate } = JSON.parse(await fs.readFile(cacheFile, "utf8"));
        const today = new Date().toISOString().slice(0, 10);
        if (date === today && rate > 0) return rate;
    } catch { }

    // ambil kurs API
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

const today = new Date().toISOString().slice(0, 10);

/* ===================== AMBIL PLACEMENT (alias) ===================== */
async function getPlacementNameMap() {
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

/* ===================== AMBIL STATISTIK PER PLACEMENT ===================== */
async function getAdsterraStats() {
    const url =
        `https://api3.adsterratools.com/publisher/stats.json` +
        `?start_date=${today}&finish_date=${today}&group_by=placement`;

    const res = await fetch(url, {
        headers: {
            Accept: "application/json",
            "X-API-Key": ADSTERRA_API_KEY,
        },
    });

    if (!res.ok) throw new Error(await res.text());
    return await res.json();
}

/* ===================== KIRIM TELEGRAM ===================== */
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

    if (!res.ok) throw new Error(await res.text());
}

/* ===================== MAIN REPORT ===================== */
(async () => {
    try {
        const rate = await getUsdToIdrRate();
        const nameMap = await getPlacementNameMap();
        const stats = await getAdsterraStats();
        const items = stats.items || [];

        let totalTodayImpr = 0;
        let totalTodayClk = 0;
        let totalTodayRevUSD = 0;

        let body = "";

        for (const row of items) {
            const id = String(row.placement);
            const name = nameMap[id] || id;

            const todayImpr = Number(row.impression || 0);
            const todayRevUSD = Number(row.revenue || 0);
            const todayRevIDR = todayRevUSD * rate;

            totalTodayImpr += todayImpr;
            totalTodayClk += Number(row.clicks || 0);
            totalTodayRevUSD += todayRevUSD;

            body +=
                `👤 ${name} / ${id}
Impression hari ini : ${todayImpr}
Revenue hari ini    : Rp ${todayRevIDR.toLocaleString("id-ID")}

`;
        }

        const totalRevIDR = totalTodayRevUSD * rate;
        const cpmAPI = totalTodayImpr > 0 ? (1000 * totalTodayRevUSD) / totalTodayImpr : 0;
        const cpmIDR = cpmAPI * rate;

        const header =
            `*Laporan CPM Adsterra (Smartlink) Agung Satrio*
Tanggal: ${today}
Kurs: USD → IDR = Rp ${rate.toLocaleString("id-ID")}

`;

        const footer =
            `*total hari ini*
Impression: ${totalTodayImpr}
Clicks    : ${totalTodayClk}
Revenue   : Rp ${totalRevIDR.toLocaleString("id-ID")}
CPM (API) : Rp ${cpmIDR.toLocaleString("id-ID")}
CPM (calc): Rp ${cpmIDR.toLocaleString("id-ID")}
`;

        await sendTelegram(header + body + footer);
        console.log("Laporan terkirim ✓");
    } catch (err) {
        console.error("ERROR:", err.message);
    }
})();
