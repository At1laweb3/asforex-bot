// bot.js — Telegram → MT4 demo create (email + phone) + Google Sheet log + confirm UI

const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const { google } = require("googleapis");

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_URL   = process.env.API_URL; // npr. https://xxxx.trycloudflare.com/mt4/create
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

const SHEET_ID  = process.env.SHEET_ID || "1tPpGTvhC2gaSy-7SAyrH55eigbyv8x_vTf9MSgOATwE";
const SHEET_TAB = process.env.SHEET_TAB || "signups";

if (!BOT_TOKEN || !API_URL) {
  console.error("Missing BOT_TOKEN or API_URL");
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* ---------------- Helpers ---------------- */

function onlyLettersDigitsSpaces(s) {
  return (s || "").normalize("NFKD").replace(/[^\p{L}\p{N}\s_-]/gu, "").trim();
}

function buildNameFromTelegram(user) {
  // prioritet: @username → "At1laweb3" ; fallback: "First Last" ; zadnje: "Trader"
  let candidate =
    user?.username
      ? user.username
      : `${user?.first_name || ""} ${user?.last_name || ""}`.trim() || "Trader";

  candidate = onlyLettersDigitsSpaces(candidate).replace(/_/g, " ").replace(/\s+/g, " ");

  // MT4 Name: min 5 char → dopuni ako treba
  if (candidate.length < 5) {
    const suffix = String(user?.id || Math.floor(Math.random()*1e6)).slice(-5);
    candidate = (candidate + " Trader " + suffix).trim();
  }
  // sigurnosno skratimo na 40
  if (candidate.length > 40) candidate = candidate.slice(0, 40);
  return candidate;
}

function normalizeEmail(s) {
  return (s || "").trim();
}
function isValidEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function normalizePhone(raw) {
  let p = (raw || "").replace(/[^\d+]/g, "");
  if (!p.startsWith("+")) {
    // forsiramo srpski prefiks +381; skidamo leading 0 ako postoji
    if (p.startsWith("0")) p = p.slice(1);
    if (p.startsWith("381")) p = "+" + p;
    else p = "+381" + p;
  }
  if (!p.startsWith("+381")) {
    // ako je stigao neki drugi kod, ipak prebacimo na +381
    p = p.replace(/^\+?\d+/, "+381") + p.replace(/^\+?\d+/, "");
    // praktično +381 + ostatak unosa; najčešći slučaj je da korisnik upiše bez +
    if (!p.startsWith("+381")) p = "+381" + p.replace(/[^\d]/g, "");
  }
  return p;
}

/* --------- Google Sheets (opciono) ---------- */
async function getSheetsClient() {
  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
  let auth;
  if (process.env.GOOGLE_CREDENTIALS) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    auth = new google.auth.GoogleAuth({ credentials: creds, scopes });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes });
  } else {
    return null; // nije podešeno → preskoči
  }
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

async function appendSignupRowSafe(values) {
  if (!SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    });
  } catch (e) {
    console.error("Sheets append error:", e.message);
  }
}

/* --------------- State --------------- */
const sessions = {}; // chatId -> { step, name, email, phone }

/* --------------- UI Flows --------------- */
function askEmail(chatId) {
  sessions[chatId].step = "email";
  bot.sendMessage(
    chatId,
    "Dobrodošao u ASForex tim! 👋\n\nZa početak upiši svoj **Email**:",
    { parse_mode: "Markdown" }
  );
}
function askPhone(chatId) {
  sessions[chatId].step = "phone";
  bot.sendMessage(
    chatId,
    "Hvala! ✅\n\nSada upiši **broj telefona** (sa prefiksom, npr. `+3816...`):",
    { parse_mode: "Markdown" }
  );
}
function showConfirm(chatId) {
  const s = sessions[chatId];
  const text =
    "Proveri podatke:\n" +
    `• Ime i prezime: ${s.name}\n` +
    `• Email: ${s.email}\n` +
    `• Telefon: ${s.phone}\n\n` +
    "Da li želiš da pošaljem prijavu ili da izmeniš podatke?";
  const kb = {
    inline_keyboard: [
      [
        { text: "✅ Ne, pošalji prijavu", callback_data: "confirm_send" },
        { text: "✏️ Želim da promenim", callback_data: "edit_choose" },
      ],
    ],
  };
  bot.sendMessage(chatId, text, { reply_markup: kb });
}
function showEditMenu(chatId) {
  const kb = {
    inline_keyboard: [
      [
        { text: "✉️ Promeni Email", callback_data: "edit_email" },
        { text: "📞 Promeni Telefon", callback_data: "edit_phone" },
      ],
      [{ text: "⬅️ Nazad", callback_data: "back_confirm" }],
    ],
  };
  bot.sendMessage(chatId, "Šta želiš da izmeniš?", { reply_markup: kb });
}

/* --------------- Commands --------------- */
bot.onText(/\/start/i, (msg) => {
  const chatId = msg.chat.id;
  const name = buildNameFromTelegram(msg.from);
  sessions[chatId] = { step: "email", name, email: "", phone: "" };
  askEmail(chatId);
});

bot.onText(/^\/broadcast (.+)$/s, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(String(chatId))) {
    return bot.sendMessage(chatId, "Nemaš ovlašćenje za /broadcast.");
  }
  const text = match[1].trim();
  // simple broadcast (bez memorizacije svih chatova ovde)
  bot.sendMessage(chatId, "OK, broadcast poslat (pokušaj).");
});

/* --------------- Text handler --------------- */
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const s = sessions[chatId];
  if (!s) return;              // ignorisi ako nema sesije
  if (msg.text && msg.text.startsWith("/")) return; // ignoriši komande

  if (s.step === "email") {
    const e = normalizeEmail(msg.text);
    if (!isValidEmail(e)) return bot.sendMessage(chatId, "Email ne deluje ispravno. Probaj ponovo:");
    s.email = e;
    askPhone(chatId);
    return;
  }

  if (s.step === "phone") {
    const p = normalizePhone(msg.text);
    if (!/^\+381\d{6,}$/.test(p)) {
      return bot.sendMessage(chatId, "Telefon ne deluje ispravno. Pošalji u formatu `+3816...`.", { parse_mode: "Markdown" });
    }
    s.phone = p;
    showConfirm(chatId);
    return;
  }

  // ako je u edit modu
  if (s.step === "edit_email") {
    const e = normalizeEmail(msg.text);
    if (!isValidEmail(e)) return bot.sendMessage(chatId, "Email ne deluje ispravno. Probaj ponovo:");
    s.email = e;
    showConfirm(chatId);
    return;
  }
  if (s.step === "edit_phone") {
    const p = normalizePhone(msg.text);
    if (!/^\+381\d{6,}$/.test(p)) {
      return bot.sendMessage(chatId, "Telefon ne deluje ispravno. Pošalji u formatu `+3816...`.", { parse_mode: "Markdown" });
    }
    s.phone = p;
    showConfirm(chatId);
    return;
  }
});

/* --------------- Callback buttons --------------- */
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const s = sessions[chatId];
  if (!s) return bot.answerCallbackQuery(q.id);

  if (q.data === "edit_choose") {
    bot.answerCallbackQuery(q.id);
    showEditMenu(chatId);
    return;
  }
  if (q.data === "edit_email") {
    bot.answerCallbackQuery(q.id);
    s.step = "edit_email";
    bot.sendMessage(chatId, "Unesi novi **Email**:", { parse_mode: "Markdown" });
    return;
  }
  if (q.data === "edit_phone") {
    bot.answerCallbackQuery(q.id);
    s.step = "edit_phone";
    bot.sendMessage(chatId, "Unesi novi **broj telefona** (format `+3816...`):", { parse_mode: "Markdown" });
    return;
  }
  if (q.data === "back_confirm") {
    bot.answerCallbackQuery(q.id);
    showConfirm(chatId);
    return;
  }

  if (q.data === "confirm_send") {
    bot.answerCallbackQuery(q.id);

    // šaljemo zahtev API-ju
    bot.sendMessage(chatId, "✅ Registracija tvog DEMO naloga je u toku, molimo sačekaj...");

    const payload = {
      // server će sam raspakovati u first/last ako nisu prosleđeni
      name: s.name,
      email: s.email,
      phone: s.phone
    };

    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const txt = await res.text();
      let data;
      try { data = JSON.parse(txt); } catch { data = { ok:false, error:"Bad JSON", raw:txt }; }

      if (!res.ok || !data?.ok) {
        return bot.sendMessage(chatId, `❌ Greška: ${data?.error || res.statusText}`);
      }

      const acc = data.account || {};
      if (acc.login && acc.password) {
        await bot.sendMessage(
          chatId,
          "🎉 Tvoj demo nalog je spreman!\n" +
          "```\n" +
          `Login:     ${acc.login}\n` +
          `Password:  ${acc.password}\n` +
          (acc.investor ? `Investor: ${acc.investor}\n` : "") +
          "Server:    MetaQuotes-Demo\n" +
          "Platforma: MT4\n" +
          "```\n",
          { parse_mode: "Markdown" }
        );

        // log u Google Sheet (opciono)
        appendSignupRowSafe([
          new Date().toISOString(),
          chatId,
          q.from?.username || "",
          s.name,
          s.email,
          s.phone,
          acc.login || "",
          acc.password || "",
          acc.investor || "",
          "MetaQuotes-Demo",
          "telegram"
        ]);
      } else {
        await bot.sendMessage(chatId, `⚠️ Nalog je kreiran, ali login/password nisu detektovani. Detalji: ${data?.mt4?.error || data?.error || "n/a"}`);
      }
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Nešto je puklo: ${String(e)}`);
    } finally {
      delete sessions[chatId];
    }
  }
});

/* --------------- Minimalni web (Railway health) --------------- */
const express = require("express");
const app = express();
app.get("/", (_req,res)=>res.send("ok"));
const PORT = process.env.PORT || 8080;
app.listen(PORT, ()=>console.log("Web listening on", PORT));