const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const TelegramBot = require("node-telegram-bot-api");
const http = require('http');
const https = require('https');
const url = require('url');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG = {
  TELEGRAM_TOKEN: "8306652884:AAF0FkTKB_qmCgLwqjJlEkyii-7lcuMFAd0",
  PORT: 3000,
  REFRESH_INTERVAL: 240000,
  M3U8_PATTERN: /(https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?)/i,
  NAV_TIMEOUT: 60000,
  CAPTURE_WAIT: 20000,
  VIEWPORT: { width: 1366, height: 768 },
  INITIAL_MATCHES: [],
};

let matchesState = {};
let browser = null;
let bot = null;

async function initBrowser() {
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
    console.log("[✓] Browser launched (headless)");
  } catch (err) {
    console.error("[✗] Browser launch failed:", err.message);
    throw err;
  }
}

async function initMatchPage(state) {
  if (!browser) throw new Error("Browser not initialized");
  const page = await browser.newPage();
  await page.setViewport(CONFIG.VIEWPORT);
  await page.setRequestInterception(true);

  page.on("request", (req) => {
    if (req.url().includes(".m3u8") || req.url().includes(".ts") || req.url().includes(".mp4")) {
      console.log(`[i][${state.id}] Streaming request: ${req.url()}`);
    }
    req.continue();
  });

  page.on("response", async (response) => {
    try {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";
      let m3u8Found = false;

      if (contentType.includes("application/vnd.apple.mpegurl") || contentType.includes("application/x-mpegurl")) {
        console.log(`[✓][${state.id}] M3U8 found via content-type: ${url}`);
        state.latestM3u8 = url;
        state.lastUpdated = new Date().toISOString();
        m3u8Found = true;
      } else if (CONFIG.M3U8_PATTERN.test(url)) {
        console.log(`[✓][${state.id}] M3U8 found via URL: ${url}`);
        state.latestM3u8 = url;
        state.lastUpdated = new Date().toISOString();
        m3u8Found = true;
      }

      // 🍪 Extract cookies as soon as m3u8 is found
      if (m3u8Found || url.includes(".m3u8")) {
        const cookies = await page.cookies(url);
        if (cookies && cookies.length > 0) {
          const cookieString = cookies.map(c => `${c.name}=${c.value}`).join("; ");
          state.cookies = cookieString;
          console.log(`[🍪][${state.id}] Cookies extracted (${cookies.length}): ${cookieString.substring(0, 120)}...`);
        }
      }
    } catch (err) {
      // Ignore errors
    }
  });

  state.page = page;
}

async function triggerPlayer(state) {
  try {
    await state.page.evaluate(() => {
      const video = document.querySelector("video");
      if (video && video.paused) {
        video.play().catch(() => {});
      }
    });
  } catch (err) {
    console.log(`[!][${state.id}] triggerPlayer error: ${err.message}`);
  }
}

/* ============================================================
   FAILOVER SYSTEM — التبديل التلقائي بين الروابط
   ============================================================ */
function failoverToNextUrl(state) {
  const oldIndex = state.activeUrlIndex;
  state.activeUrlIndex = (state.activeUrlIndex + 1) % state.urls.length;
  state.url = state.urls[state.activeUrlIndex];
  state.consecutiveFailures = 0;
  state.cookies = null; // 🍪 Reset cookies on failover
  if (state.page && !state.page.isClosed()) {
    state.page.close().catch(() => {});
  }
  state.page = null;
  state.latestM3u8 = null;
  console.log(`[↻][${state.id}] Failover: ${oldIndex} → ${state.activeUrlIndex} | ${state.url}`);
}

async function captureMatch(state) {
  if (state.removed) return;
  if (state.isCapturing) {
    console.log(`[!][${state.id}] Previous cycle still running, skip.`);
    return;
  }
  state.isCapturing = true;

  try {
    if (!state.page || state.page.isClosed()) {
      await initMatchPage(state);
    }

    console.log(`[i][${state.id}] Reloading: ${state.url}`);
    await state.page.goto(state.url, { waitUntil: "networkidle2", timeout: CONFIG.NAV_TIMEOUT });
    await triggerPlayer(state);
    await new Promise((r) => setTimeout(r, CONFIG.CAPTURE_WAIT));

    if (state.latestM3u8) {
      console.log(`[✓][${state.id}] Latest link: ${state.latestM3u8}`);
      state.consecutiveFailures = 0;
    } else {
      console.log(`[!][${state.id}] No m3u8 found in this cycle.`);
      state.consecutiveFailures++;
      // إذا فشلت دورتان متتاليتان بدون m3u8، انتقل للرابط التالي
      if (state.consecutiveFailures >= 2) {
        console.log(`[✗][${state.id}] Repeated failures — switching to backup URL...`);
        failoverToNextUrl(state);
      }
    }
  } catch (err) {
    console.error(`[✗][${state.id}] Error: ${err.message}`);
    try {
      if (state.page && !state.page.isClosed()) await state.page.close();
    } catch (_) {}
    state.page = null;
    // عند خطأ فادح (Timeout، الخادم غير متاح...) انتقل للرابط الاحتياطي فوراً
    failoverToNextUrl(state);
  } finally {
    state.isCapturing = false;
  }
}

function startMatchLoop(state) {
  captureMatch(state);
  state.timer = setInterval(() => captureMatch(state), CONFIG.REFRESH_INTERVAL);
}

async function addMatch(id, urls) {
  if (matchesState[id]) {
    throw new Error(`ID "${id}" already exists.`);
  }
  const urlArray = Array.isArray(urls) ? urls : [urls];
  if (urlArray.length === 0) throw new Error("No URLs provided.");
  const state = {
    id,
    urls: urlArray,
    activeUrlIndex: 0,
    url: urlArray[0], // ← الرابط الأول فقط هو المراقب حالياً
    latestM3u8: null,
    lastUpdated: null,
    cookies: null, // 🍪 Cookie storage
    page: null,
    isCapturing: false,
    timer: null,
    removed: false,
    consecutiveFailures: 0,
  };
  matchesState[id] = state;
  startMatchLoop(state);
  return state;
}

function removeMatch(id) {
  const state = matchesState[id];
  if (!state) return false;
  state.removed = true;
  if (state.timer) clearInterval(state.timer);
  if (state.page && !state.page.isClosed()) {
    state.page.close().catch(() => {});
  }
  delete matchesState[id];
  return true;
}

/* ============================================================
   Telegram Bot — أمر /add يستقبل عدة روابط
   ============================================================ */
function initTelegramBot() {
  bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: true });

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      "Welcome! 🎥\n\n" +
        "Bot commands:\n" +
        "/add [id] [url1] [url2] ... — Add a match (with backup URLs)\n" +
        "/list — List matches\n" +
        "/remove [id] — Remove a match\n" +
        "/help — Help"
    );
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      "📋 Usage:\n\n" +
        "/add match1 https://korazon.life/match1 https://yallashoot.com/match1\n" +
        "/list\n" +
        "/remove match1"
    );
  });

  bot.onText(/\/add/, async (msg) => {
    const chatId = msg.chat.id;
    // دعم الفصل بالمسافة أو الفاصلة أو كليهما
    const parts = msg.text.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) {
      return bot.sendMessage(
        chatId,
        "⚠️ Usage:\n/add [id] [url1] [url2] ...\n\nExample:\n/add match-1 https://korazon.life/match1 https://yallashoot.com/match1"
      );
    }
    const id = parts[1];
    const urls = parts.slice(2).filter((p) => /^https?:\/\//i.test(p));
    if (urls.length === 0) {
      return bot.sendMessage(
        chatId,
        "⚠️ No valid URLs found. URLs must start with http:// or https://"
      );
    }
    try {
      await addMatch(id, urls);
      bot.sendMessage(
        chatId,
        `✅ Match added successfully.\n` +
          `🆔 ID: ${id}\n` +
          `🔗 Primary URL: ${urls[0]}\n` +
          (urls.length > 1 ? `🔗 Backup URLs: ${urls.length - 1}\n` : "") +
          `🖥️ Stream: http://localhost:${CONFIG.PORT}/stream/${id}\n` +
          `⏳ Fetching m3u8...`
      );
    } catch (err) {
      bot.sendMessage(chatId, `❌ Failed to add: ${err.message}`);
    }
  });

  bot.onText(/\/list/, (msg) => {
    const chatId = msg.chat.id;
    const keys = Object.keys(matchesState);
    if (keys.length === 0) {
      return bot.sendMessage(chatId, "📭 No matches currently.");
    }
    let text = `📋 Matches (${keys.length}):\n\n`;
    keys.forEach((id) => {
      const s = matchesState[id];
      const status = s.latestM3u8 ? "✅ Active" : "⏳ Fetching";
      const currentUrl = s.url || s.urls?.[s.activeUrlIndex] || "—";
      const activeIdx = s.activeUrlIndex ?? 0;
      text +=
        `🆔 ${id}\n` +
        `🔗 Current URL (${activeIdx + 1}/${s.urls.length}): ${currentUrl}\n` +
        `📡 Status: ${status}\n` +
        `📅 Last update: ${s.lastUpdated || "—"}\n\n`;
    });
    bot.sendMessage(chatId, text);
  });

  bot.onText(/\/remove(?:\s+(\S+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const id = match[1];
    if (!id) {
      return bot.sendMessage(chatId, "⚠️ Usage: /remove [id]");
    }
    if (removeMatch(id)) {
      bot.sendMessage(chatId, `🗑️ Match "${id}" removed successfully.`);
    } else {
      bot.sendMessage(chatId, `❌ Match "${id}" not found.`);
    }
  });
}

/* ============================================================
   Express API Routes
   ============================================================ */
app.get("/stream/:id", (req, res) => {
  const state = matchesState[req.params.id];
  if (!state) {
    return res.status(404).json({ success: false, message: "Match ID not found" });
  }
  if (!state.latestM3u8) {
    return res.status(404).json({ success: false, message: "Fetching stream URL, please wait..." });
  }
  res.json({ success: true, m3u8: state.latestM3u8, updated: state.lastUpdated, url: state.url });
});

app.get("/matches", (req, res) => {
  const list = Object.keys(matchesState).map((id) => {
    const s = matchesState[id];
    return {
      id,
      activeUrl: s.url,
      activeUrlIndex: s.activeUrlIndex,
      urlsCount: s.urls.length,
      latestM3u8: s.latestM3u8,
      lastUpdated: s.lastUpdated,
    };
  });
  res.json({ success: true, matches: list });
});

app.get("/health", (req, res) => {
  res.json({ success: true, status: "ok" });
});

/* ============================================================
   Proxy helpers (HTTP/HTTPS passthrough with Referer + Cookies)
   ============================================================ */
function fetchUrl(targetUrl, referer, cookies, callback) {
  if (typeof cookies === "function") { callback = cookies; cookies = null; }

  const parsed = url.parse(targetUrl);
  const protocol = parsed.protocol === 'https:' ? https : http;

  const PROXY_HEADERS = {
    'Referer': referer || 'https://korazon.life/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // 🍪 Inject cookies if present
  if (cookies) {
    PROXY_HEADERS['Cookie'] = cookies;
  }

  const options = {
    hostname: parsed.hostname,
    port: parsed.port,
    path: parsed.path,
    method: 'GET',
    headers: PROXY_HEADERS,
  };

  const req = protocol.request(options, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      return fetchUrl(res.headers.location, referer, cookies, callback);
    }
    callback(null, res);
  });
  req.on('error', (err) => callback(err));
  req.end();
}

function fetchBinary(targetUrl, referer, cookies, callback) {
  if (typeof cookies === "function") { callback = cookies; cookies = null; }

  const chunks = [];
  fetchUrl(targetUrl, referer, cookies, (err, res) => {
    if (err) return callback(err);
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => callback(null, Buffer.concat(chunks)));
    res.on('error', (err) => callback(err));
  });
}

function resolveUrl(baseUrl, targetUrl) {
  if (targetUrl.startsWith('http')) return targetUrl;
  const parsed = url.parse(baseUrl);
  if (targetUrl.startsWith('/')) {
    return `${parsed.protocol}//${parsed.host}${targetUrl}`;
  }
  const basePath = parsed.pathname || '/';
  const baseDir = basePath.endsWith('/') ? basePath : basePath.substring(0, basePath.lastIndexOf('/') + 1);
  return `${parsed.protocol}//${parsed.host}${baseDir}${targetUrl}`;
}

/* ============================================================
   HLS Proxy endpoint — يبث الـ m3u8 والقطع (TS) عبر البروكسي
   ============================================================ */
app.get("/proxy/:id/stream.m3u8", async (req, res) => {
  const state = matchesState[req.params.id];
  if (!state || !state.latestM3u8) {
    return res.status(404).send("Stream not found or not ready yet.");
  }

  const m3u8Url = state.latestM3u8;
  const referer = state.url || 'https://korazon.life/';
  const cookies = state.cookies || null;

  fetchUrl(m3u8Url, referer, cookies, (err, response) => {
    if (err) {
      console.error(`[✗][${state.id}] Proxy fetch error: ${err.message}`);
      return res.status(502).send("Failed to fetch stream.");
    }

    res.setHeader('Content-Type', response.headers['content-type'] || 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');

    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      const baseUrl = m3u8Url;
      const rewritten = body.split('\n').map((line) => {
        line = line.trim();
        if (!line || line.startsWith('#')) return line;
        const absoluteUrl = resolveUrl(baseUrl, line);
        if (absoluteUrl.includes('.ts') || absoluteUrl.includes('.mp4') || absoluteUrl.includes('.m4s')) {
          const encoded = Buffer.from(absoluteUrl).toString('base64');
          return `${req.protocol}://${req.get('host')}/proxy/${req.params.id}/segment?url=${encoded}`;
        }
        return absoluteUrl;
      }).join('\n');

      res.send(rewritten);
    });
  });
});
// ──────────────────────────────────────────
// مسار جلب أجزاء الفيديو (.ts)
// ──────────────────────────────────────────
app.get("/proxy/:id/segment", (req, res) => {
  const state = matchesState[req.params.id];
  if (!state || !req.query.url) {
    return res.status(404).send("Segment not found");
  }

  const segmentUrl = Buffer.from(req.query.url, 'base64').toString('utf-8');
  const referer = state.url || 'https://korazon.life/';
  const cookies = state.cookies || null;

  fetchUrl(segmentUrl, referer, cookies, (err, response) => {
    if (err) {
      console.error(`[✗][${state.id}] Segment fetch error: ${err.message}`);
      return res.status(502).send("Failed to fetch segment.");
    }
    res.setHeader('Content-Type', response.headers['content-type'] || 'video/MP2T');
    res.setHeader('Access-Control-Allow-Origin', '*');
    response.pipe(res);
  });
});

// ──────────────────────────────────────────
// دالة التشغيل الرئيسية (الساروت)
// ──────────────────────────────────────────
async function start() {
  process.on("unhandledRejection", (reason) => {
    console.error(`[✗] Unhandled Rejection: ${reason}`);
  });
  process.on("uncaughtException", (err) => {
    console.error(`[✗] Uncaught Exception: ${err.message}`);
  });

  await initBrowser();
  initTelegramBot();

  app.listen(CONFIG.PORT, () => {
    console.log(`[i] الخادم يعمل على: http://localhost:${CONFIG.PORT}`);
    console.log(`[i] بوت تيليغرام يعمل ومستعد!`);
  });
}

// ديماري الموطور!
start();