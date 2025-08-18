// bot.js — ASForex Telegram bot -> MT4 demo + Google Sheet
// ENV: BOT_TOKEN, API_URL, SHEET_ID, (SHEET_TAB=signups), ADMIN_IDS,
//      GOOGLE_CREDENTIALS (JSON string) ILI GOOGLE_APPLICATION_CREDENTIALS (path)

const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const { google } = require("googleapis");

// ---- ENV ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const API_URL   = process.env.API_URL || "http://localhost:8081/mt4/create";
const SHEET_ID  = process.env.SHEET_ID || "";
const SHEET_TAB = process.env.SHEET_TAB || "signups";
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

if (!BOT_TOKEN) { console.error("Missing BOT_TOKEN"); process.exit(1); }

// ---- Tiny web server (Railway keep-alive) ----
const app = express();
app.get("/health", (_req, res) => res.send("ok"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Web listening on", PORT));

// ---- Google Sheets helper ----
async function getSheetsClient() {
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];
  let auth;
  if (process.env.GOOGLE_CREDENTIALS) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    auth = new google.auth.GoogleAuth({ credentials: creds, scopes });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes });
  } else {
    console.warn("No Google credentials supplied; sheet logging disabled.");
    return null;
  }
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

async function appendSignupRow(row) {
  if (!SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  } catch (e) {
    console.error("Sheets append error:", e.message);
  }
}

// ---- Helpers ----
function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||"").trim());
}
function cleanedPhone(s) {
  return String(s||"").replace(/[^\d+]/g, "");
}

// ---- Telegram bot ----
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// sessions: chatId -> { step, first, last, email, phone }
const sessions = {};

function confirmationKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Ne, pošalji prijavu", callback_data: "confirm_send" },
         { text: "Želim da promenim",  callback_data: "edit_menu" }]
      ]
    }
  };
}

function editKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "Promeni email",   callback_data: "edit_email" }],
        [{ text: "Promeni telefon", callback_data: "edit_phone" }],
        [{ text: "?? Nazad",        callback_data: "confirm_again" }]
      ]
    }
  };
}

function askEmail(chatId) {
  sessions[chatId].step = "email";
  bot.sendMessage(chatId, "Dobrodošao u ASForex tim! ?\nZa pocetak, ukucaj svoj **email**:", { parse_mode: "Markdown" });
}

function askPhone(chatId) {
  sessions[chatId].step = "phone";
  bot.sendMessage(chatId, "Hvala! ?\nSada upiši svoj **broj telefona** (sa prefiksom, npr. +3816…):", { parse_mode: "Markdown" });
}

function askConfirm(chatId) {
  const s = sessions[chatId];
  if (!s) return;
  s.step = "confirm";
  const preview =
    `Proveri podatke:\n` +
    `• Ime i prezime: ${s.first || ""} ${s.last || ""}\n` +
    `• Email: ${s.email}\n` +
    `• Telefon: ${s.phone}\n\n` +
    `Da li želiš da pošaljem prijavu ili da izmeniš podatke?`;
  bot.sendMessage(chatId, preview, confirmationKeyboard());
}

async function createAccount(chatId) {
  const s = sessions[chatId];
  if (!s) return;

  await bot.sendMessage(chatId, "? Registracija tvog DEMO naloga je u toku, molimo sacekaj…");

  try {
    const payload = {
      first: s.first || "User",
      last:  s.last  || "",
      email: s.email,
      phone: s.phone
    };

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const txt = await res.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = { ok:false, error:"Bad JSON from API", raw:txt }; }

    if (!res.ok) {
      await bot.sendMessage(chatId, `?? Greška: ${data?.error || res.statusText}`);
      return;
    }

    const acc = data.account || {};
    if (acc.login && acc.password) {
      await bot.sendMessage(
        chatId,
        "*Tvoj demo nalog je spreman:*\n" +
        "```\n" +
        `Login:     ${acc.login}\n` +
        `Password:  ${acc.password}\n` +
        (acc.investor ? `Investor: ${acc.investor}\n` : "") +
        "Server:    MetaQuotes-Demo\n" +
        "Platforma: MT4\n" +
        "```\n",
        { parse_mode: "Markdown" }
      );

      const row = [
        new Date().toISOString(),
        chatId,
        s.username || "",
        s.first || "",
        s.last || "",
        s.email,
        s.phone,
        acc.login || "",
        acc.password || "",
        acc.investor || "",
        "MetaQuotes-Demo",
        "MT4",
        "telegram"
      ];
      appendSignupRow(row).catch(console.error);
    } else {
      await bot.sendMessage(chatId, `?? Nije dobijen login/password. Detalji: ${data?.mt4?.error || data?.error || "unknown"}`);
    }
  } catch (e) {
    await bot.sendMessage(chatId, `?? Nešto je puklo: ${String(e)}`);
  } finally {
    delete sessions[chatId];
  }
}

// ---- Commands & handlers ----
bot.onText(/\/start/i, (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = {
    step: "email",
    first: (msg.from?.first_name || "").trim(),
    last:  (msg.from?.last_name  || "").trim(),
    username: msg.from?.username || "",
    email: "", phone: ""
  };
  askEmail(chatId);
});

bot.onText(/^\/broadcast (.+)$/s, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(String(chatId))) {
    return bot.sendMessage(chatId, "Nemaš ovlašcenje za /broadcast.");
  }
  const text = match[1].trim();
  // Ovde možeš da dodaš svoju listu chatova iz baze/sheets-a.
  await bot.sendMessage(chatId, "OK (demo): poslao bih broadcast: " + text);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const s = sessions[chatId];
  if (!s) return;

  if (s.step === "email") {
    const e = (msg.text || "").trim();
    if (!isValidEmail(e)) return bot.sendMessage(chatId, "Email ne deluje ispravno. Probaj ponovo:");
    s.email = e;
    return askPhone(chatId);
  }

  if (s.step === "phone") {
    const p = cleanedPhone(msg.text);
    if (!p || p.length < 6) return bot.sendMessage(chatId, "Telefon ne deluje ispravno. Pošalji u formatu +3816…");
    s.phone = p;
    return askConfirm(chatId);
  }

  // u "confirm" i "editing" koracima sve ide preko inline-dugmica (callback_query)
});

bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const s = sessions[chatId];
  const data = q.data;

  if (!s) return bot.answerCallbackQuery(q.id);

  if (data === "confirm_send") {
    await bot.answerCallbackQuery(q.id);
    return createAccount(chatId);
  }

  if (data === "edit_menu") {
    await bot.answerCallbackQuery(q.id);
    s.step = "editing";
    return bot.sendMessage(chatId, "Šta želiš da promeniš?", editKeyboard());
  }

  if (data === "edit_email") {
    await bot.answerCallbackQuery(q.id);
    s.step = "email";
    return bot.sendMessage(chatId, "Pošalji novi *email*:", { parse_mode: "Markdown" });
  }

  if (data === "edit_phone") {
    await bot.answerCallbackQuery(q.id);
    s.step = "phone";
    return bot.sendMessage(chatId, "Pošalji novi *broj telefona* (sa prefiksom):", { parse_mode: "Markdown" });
  }

  if (data === "confirm_again") {
    await bot.answerCallbackQuery(q.id);
    return askConfirm(chatId);
  }

  bot.answerCallbackQuery(q.id);
});

console.log("Telegram bot running (polling)…");