// pump-migrate-discord.js
// Analytics bot: nghe Pump.fun migration → phân tích top holders (owner wallet, bỏ LP khỏi %)
// Gửi Discord embed đẹp + @everyone + link Solscan + Axiom (paste CA để trade)

const WebSocket = require("ws");
const axios = require("axios");
const bs58Module = require("bs58");
const { Buffer } = require("buffer"); // ✅ FIX: đảm bảo Buffer luôn tồn tại (Bun / môi trường lạ)

// ================== CONFIG ==================
const DISCORD_WEBHOOK_URL =
  "https://discord.com/api/webhooks/1441130174316937236/jB1R900aKhkvLRxHunSqQn8bPx_o5jSpMtW6x-Xj6te8M4AJewfjvTUbJnLyNGiNCPRE";

const WS_URL = "wss://pumpportal.fun/api/data";
// Nên dùng RPC riêng (Helius, Triton, v.v.)
const RPC_URL =
  "https://mainnet.helius-rpc.com/?api-key=2504db9f-75d5-4f46-a6da-c4b30f1345b9";

const RECONNECT_DELAY_MS = 5000;
const DEDUPE_TTL_MS = 5 * 60 * 1000; // 5 phút chống spam
// ============================================

const lastNotifiedByMint = new Map();

// ✅ Cache metadata Pump.fun để đỡ call lại nhiều lần
const pumpMetaCache = new Map();

// ================== HELPERS ==================
function shorten(addr) {
  if (!addr) return "Unknown";
  return addr.length <= 10 ? addr : `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function formatTokenAmountCompact(amount) {
  if (!Number.isFinite(amount)) return "N/A";
  if (amount >= 1_000_000_000) {
    const v = amount / 1_000_000_000;
    return (Number.isInteger(v) ? v.toString() : v.toFixed(2)) + "b";
  }
  if (amount >= 1_000_000) {
    const v = amount / 1_000_000;
    return (Number.isInteger(v) ? v.toString() : v.toFixed(2)) + "m";
  }
  if (amount >= 1_000) {
    const v = amount / 1_000;
    return (Number.isInteger(v) ? v.toString() : v.toFixed(2)) + "k";
  }
  return amount.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function b58encode(bytes) {
  if (typeof bs58Module.encode === "function") return bs58Module.encode(bytes);
  if (typeof bs58Module === "function") return bs58Module(bytes);
  if (bs58Module.default && typeof bs58Module.default.encode === "function") {
    return bs58Module.default.encode(bytes);
  }
  throw new Error("Không tìm thấy hàm encode trong bs58 module");
}

async function callRpc(method, params) {
  const body = {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1_000_000),
    method,
    params,
  };

  const res = await axios.post(RPC_URL, body, {
    headers: { "Content-Type": "application/json" },
  });

  if (res.data.error) {
    console.error(
      `❌ RPC error ${method}:`,
      res.data.error.message || res.data.error
    );
    throw new Error(
      `RPC error ${method}: ${
        res.data.error.message || JSON.stringify(res.data.error)
      }`
    );
  }
  return res.data.result;
}

// ================== PUMP.FUN METADATA ==================
/**
 * Lấy metadata (name, symbol) từ Pump.fun frontend API theo mint
 * Chỉ gọi khi:
 * - Có mint
 * - name hiện tại rỗng / "-" / trùng symbol (tức là vô nghĩa)
 */
async function fetchPumpMetadata(mint, currentName, currentSymbol) {
  if (!mint) {
    return { name: currentName || currentSymbol || "-", symbol: currentSymbol || "-" };
  }

  // Nếu name đã ổn rồi thì khỏi gọi API
  if (
    currentName &&
    currentName !== "-" &&
    currentName.toUpperCase() !== (currentSymbol || "").toUpperCase()
  ) {
    return { name: currentName, symbol: currentSymbol || "-" };
  }

  // Check cache
  if (pumpMetaCache.has(mint)) {
    const cached = pumpMetaCache.get(mint);
    return {
      name: cached.name || currentName || currentSymbol || "-",
      symbol: cached.symbol || currentSymbol || "-",
    };
  }

  try {
    const url = `https://frontend-api.pump.fun/coins/${mint}`;
    const res = await axios.get(url, { timeout: 5000 });
    const data = res.data || {};

    const name =
      data.name ||
      data.tokenName ||
      currentName ||
      currentSymbol ||
      "-";

    const symbol =
      data.symbol ||
      data.ticker ||
      data.tokenSymbol ||
      currentSymbol ||
      "-";

    pumpMetaCache.set(mint, { name, symbol });

    return { name, symbol };
  } catch (e) {
    console.error("❌ Pump.fun metadata error:", e.message);
    return {
      name: currentName || currentSymbol || "-",
      symbol: currentSymbol || "-",
    };
  }
}

// ================= FETCH HOLDERS + SUPPLY =================
/**
 * Lấy top holders theo ví owner:
 * - Dùng getTokenLargestAccounts → token accounts
 * - Decode owner từ data account SPL
 * - Group theo owner, sort desc, lấy top 10
 * - Lấy current SOL balance bằng getMultipleAccounts(owner ví)
 *
 * LỖI THƯỜNG GẶP:
 * - RPC KHÔNG support getTokenLargestAccounts (error -32010: KeyExcludedFromSecondaryIndex)
 *   → Bắt buộc đổi RPC (Helius, QuickNode, Shyft, Triton, v.v.)
 */
async function fetchOnchainHoldersAndSupply(mint) {
  try {
    // 1) Top token accounts (dùng finalized cho holder ranking ổn định)
    const largest = await callRpc("getTokenLargestAccounts", [
      mint,
      { commitment: "finalized" },
    ]);

    if (!largest || !Array.isArray(largest.value)) {
      console.log(
        "⚠️ getTokenLargestAccounts trả về rỗng / sai format cho mint:",
        mint
      );
      return { holders: [], supplyUi: null };
    }

    // 2) Supply
    const supplyRes = await callRpc("getTokenSupply", [mint]);
    const supplyInfo = supplyRes?.value || {};

    // Lấy decimals chắc chắn (ưu tiên supply, fallback largest)
    const fallbackDecimals =
      largest.value[0]?.decimals != null ? largest.value[0].decimals : 0;
    const decimals =
      supplyInfo.decimals != null ? supplyInfo.decimals : fallbackDecimals;

    let supplyUi = null;
    if (typeof supplyInfo.uiAmount === "number") {
      supplyUi = supplyInfo.uiAmount;
    } else if (supplyInfo.amount) {
      // amount là string raw u64
      supplyUi = Number(supplyInfo.amount) / 10 ** decimals;
    }

    // Chuẩn hóa list token accounts + uiAmount
    const raw = (largest.value || [])
      .map((h) => {
        let ui = typeof h.uiAmount === "number" ? h.uiAmount : null;
        if (ui == null && h.amount) {
          ui = Number(h.amount) / 10 ** (h.decimals ?? decimals);
        }
        return {
          address: h.address,
          uiAmount: ui,
        };
      })
      .filter((h) => h.uiAmount && Number(h.uiAmount) > 0);

    if (!raw.length) {
      console.log("⚠️ Không có token account nào > 0 balance cho mint:", mint);
      return { holders: [], supplyUi };
    }

    // 3) Lấy token account info để đọc owner
    const tokenAccountAddresses = raw.map((h) => h.address);
    const tokenAccInfos = await callRpc("getMultipleAccounts", [
      tokenAccountAddresses,
      { commitment: "confirmed", encoding: "base64" },
    ]);

    const tokenAccList = tokenAccInfos?.value || [];

    // Map owner → tổng amount
    const ownerMap = new Map();

    raw.forEach((h, idx) => {
      const accInfo = tokenAccList[idx];
      if (!accInfo || !accInfo.data) return;

      // data có thể là ["base64string", "base64"] hoặc {data:[...]}
      let base64Str = null;
      if (Array.isArray(accInfo.data)) {
        base64Str = accInfo.data[0];
      } else if (Array.isArray(accInfo.data.data)) {
        base64Str = accInfo.data.data[0];
      }
      if (!base64Str) return;

      let data;
      try {
        data = Buffer.from(base64Str, "base64");
      } catch (e) {
        console.error("❌ Lỗi Buffer.from khi decode account data:", e.message);
        return;
      }

      if (data.length < 64) {
        // Không đủ 64 byte để đọc owner, bỏ qua
        return;
      }

      // SPL Token layout:
      // 0..31: mint
      // 32..63: owner
      const ownerBytes = data.subarray(32, 64);
      let owner;
      try {
        owner = b58encode(ownerBytes);
      } catch (e) {
        console.error("❌ Lỗi encode base58 khi đọc owner:", e.message);
        return;
      }

      const amountUi = Number(h.uiAmount) || 0;
      if (!ownerMap.has(owner)) {
        ownerMap.set(owner, { address: owner, amountUi: 0 });
      }
      ownerMap.get(owner).amountUi += amountUi;
    });

    let holdersAgg = Array.from(ownerMap.values());
    if (!holdersAgg.length) {
      console.log("⚠️ Không decode được owner nào cho mint:", mint);
      return { holders: [], supplyUi };
    }

    // 4) Sort desc theo amount, lấy top 10 owner
    holdersAgg.sort((a, b) => b.amountUi - a.amountUi);
    holdersAgg = holdersAgg.slice(0, 10);

    // 5) Lấy current SOL balance của ví owner
    const ownerAddresses = holdersAgg.map((h) => h.address);
    const ownerAccInfos = await callRpc("getMultipleAccounts", [
      ownerAddresses,
      { commitment: "confirmed", encoding: "base64" },
    ]);

    const ownerAccList = ownerAccInfos?.value || [];

    const holders = holdersAgg.map((h, idx) => {
      const accInfo = ownerAccList[idx];
      const lamports = accInfo?.lamports ?? null;
      const solBalance = lamports != null ? lamports / 1_000_000_000 : null;

      return {
        rank: idx + 1,
        address: h.address,
        amountUi: h.amountUi,
        solBalance,
      };
    });

    return { holders, supplyUi };
  } catch (err) {
    console.error("❌ Lỗi fetch on-chain holders/supply:", err.message);
    if (err.response?.data) {
      console.error("RPC raw response:", JSON.stringify(err.response.data));
    }
    return { holders: [], supplyUi: null };
  }
}

// ================== ANALYTICS (REMOVE LP FOR % CALC) ==================
/**
 * Tính % top1 / top10 nhưng BỎ LP (giả định holder #1 là LP)
 * - top1Pct = ví giàu nhất không phải LP (holders[1])
 * - top10Pct = sum 10 ví đầu tiên sau khi bỏ LP (holders.slice(1, 11))
 */
function analyzeConcentrationExcludingLp(holders, supplyUi) {
  if (!holders.length || !supplyUi || supplyUi <= 0) {
    return { top1Pct: null, top10Pct: null, risk: "⚠️ No Data" };
  }

  const nonLp = holders.slice(1); // bỏ LP
  if (!nonLp.length) {
    return {
      top1Pct: null,
      top10Pct: null,
      risk: "⚠️ Only LP exists, no holder data",
    };
  }

  const top1 = nonLp[0]?.amountUi || 0;
  const top10 = nonLp
    .slice(0, 10)
    .reduce((sum, h) => sum + (h.amountUi || 0), 0);

  const top1Pct = (top1 / supplyUi) * 100;
  const top10Pct = (top10 / supplyUi) * 100;

  let risk = "🟢 Balanced (LP excluded)";
  if (top1Pct > 40 || top10Pct > 90) {
    risk = "☠️ High whale risk (LP excluded)";
  } else if (top1Pct > 20 || top10Pct > 75) {
    risk = "⚠️ Concentrated (LP excluded)";
  }

  return { top1Pct, top10Pct, risk };
}

// ================= SEND TO DISCORD ==================
/**
 * pingEveryone = true  → @everyone
 * pingEveryone = false → không ping (dùng cho startup)
 */
async function sendToDiscord({
  name,
  symbol,
  mint,
  holders,
  supplyUi,
  pingEveryone = true,
}) {
  const axiomLink = `https://axiom.trade/discover?chain=sol`;
  const solscan = `https://solscan.io/token/${mint}`;

  let holdersText = "No holder data";
  if (holders && holders.length) {
    holdersText = holders
      .map((h) => {
        const addrShort = shorten(h.address);
        const amtStrBase = formatTokenAmountCompact(h.amountUi);
        const amtStr =
          h.rank === 1
            ? `${amtStrBase} tokens (liquidity pool)`
            : `${amtStrBase} tokens`;
        const solStr =
          h.solBalance != null ? `${h.solBalance.toFixed(3)} SOL` : "N/A";
        return `▫️ **#${h.rank}** — [${addrShort}](https://solscan.io/account/${h.address}) • **${amtStr}** • 💰 ${solStr}`;
      })
      .join("\n");
    if (holdersText.length > 1024) {
      holdersText = holdersText.slice(0, 1020) + "...";
    }
  }

  const { top1Pct, top10Pct, risk } = analyzeConcentrationExcludingLp(
    holders || [],
    supplyUi
  );

  const supplyStr = supplyUi
    ? supplyUi.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : "No Data";

  const top1Str = top1Pct != null ? `${top1Pct.toFixed(2)}%` : "N/A";
  const top10Str = top10Pct != null ? `${top10Pct.toFixed(2)}%` : "N/A";

  const content = pingEveryone
    ? "@everyone 🚨 **New Pump.fun Migration Detected!**"
    : "✅ Bot is online.";

  const body = {
    content,
    allowed_mentions: pingEveryone ? { parse: ["everyone"] } : { parse: [] },

    username: "Migration Scanner",

    embeds: [
      {
        title:
          mint === "SYSTEM_READY"
            ? "🟢 Migration Scanner Online"
            : `🚀 ${symbol || "-"} Migrated`,

        color: mint === "SYSTEM_READY" ? 0x2ecc71 : 0x00ffcc,

        fields: [
          ...(mint === "SYSTEM_READY"
            ? []
            : [
                {
                  name: "🧪 Token",
                  value: `**${name || "-"} (${symbol || "-"})**`,
                },
                {
                  name: "🤑 Contract (CA)",
                  value: "```" + mint + "```",
                },
                {
                  name: "🔗 Quick Links",
                  value: `[Solscan](${solscan}) | [Trade on Axiom](${axiomLink})`,
                },
                {
                  name: "📦 Total Supply",
                  value: supplyStr,
                  inline: true,
                },
                {
                  name: "🐋 Top 1 Holder (ex-LP)",
                  value: top1Str,
                  inline: true,
                },
                {
                  name: "👥 Top 10 Holders (ex-LP)",
                  value: top10Str,
                  inline: true,
                },
                {
                  name: "⚖️ Distribution Quality",
                  value: risk,
                },
                {
                  name: "🏦 Holder Breakdown",
                  value: holdersText,
                },
              ]),
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  try {
    await axios.post(DISCORD_WEBHOOK_URL, body);
  } catch (e) {
    console.error("❌ Discord webhook error:", e.message);
  }
}

// ================== EVENT HANDLER ==================
async function handleEvent(msg) {
  try {
    const token = msg?.token || msg?.data?.token || msg;

    const mint =
      token?.mint || token?.mintAddress || token?.address || msg?.mint;
    if (!mint) return;

    let symbol =
      token?.symbol ||
      token?.ticker ||
      token?.tokenSymbol ||
      msg?.symbol ||
      msg?.ticker ||
      "-";

    let name =
      token?.name ||
      token?.tokenName ||
      token?.coin_name ||
      msg?.name ||
      symbol ||
      "-";

    // ✅ Bổ sung: nếu name/symbol tệ → gọi Pump.fun API để lấy metadata chuẩn
    const meta = await fetchPumpMetadata(mint, name, symbol);
    name = meta.name;
    symbol = meta.symbol;

    // chống spam cùng CA
    const now = Date.now();
    if (
      lastNotifiedByMint.has(mint) &&
      now - lastNotifiedByMint.get(mint) < DEDUPE_TTL_MS
    ) {
      console.log(`⏭ Skip duplicate mint: ${mint}`);
      return;
    }
    lastNotifiedByMint.set(mint, now);

    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🔥 MIGRATION DETECTED");
    console.log("Tên   :", name);
    console.log("Ticker:", symbol);
    console.log("Mint  :", mint);
    console.log("Đang fetch holders + supply (owner-based, ex-LP)...");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    const { holders, supplyUi } = await fetchOnchainHoldersAndSupply(mint);
    await sendToDiscord({
      name,
      symbol,
      mint,
      holders,
      supplyUi,
      pingEveryone: true,
    });
  } catch (e) {
    console.error("❌ handleEvent error:", e.message);
  }
}

// ================== WEBSOCKET ==================
function startWebSocket() {
  console.log("🔌 Đang kết nối PumpPortal...");
  const ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log("✅ WebSocket connected");
    ws.send(JSON.stringify({ method: "subscribeMigration" }));
    console.log("📨 Đã subscribe migration feed");
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (Array.isArray(msg)) {
      msg.forEach((m) => handleEvent(m));
      return;
    }

    if (msg.data) {
      if (Array.isArray(msg.data)) {
        msg.data.forEach((m) => handleEvent(m));
      } else {
        handleEvent(msg.data);
      }
      return;
    }

    handleEvent(msg);
  });

  ws.on("close", () => {
    console.log(
      `⚠️ WS closed — reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`
    );
    setTimeout(startWebSocket, RECONNECT_DELAY_MS);
  });

  ws.on("error", (err) => {
    console.error("❌ WS Error:", err.message);
  });
}

// ================== STARTUP PING ==================
// Ping lên Discord (KHÔNG @everyone) khi bot khởi động
sendToDiscord({
  name: "Bot đã khởi động",
  symbol: "READY",
  mint: "SYSTEM_READY",
  holders: [],
  supplyUi: 1,
  pingEveryone: false,
}).catch(() => {});

// ================== RUN ==================
startWebSocket();
