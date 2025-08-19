// bot.js — Telegram → MT4 demo create → confirm/edit flow + Google Sheet log (clean UI)
// env: BOT_TOKEN, API_URL, ADMIN_IDS, SHEET_ID, (SHEET_TAB=signups),
//      GOOGLE_CREDENTIALS (JSON string) ILI GOOGLE_APPLICATION_CREDENTIALS (path)

const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const { google } = require("googleapis");

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_URL   = process.env.API_URL || "http://localhost:8081/mt4/create";
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

const SHEET_ID  = process.env.SHEET_ID || "1tPpGTvhC2gaSy-7SAyrH55eigbyv8x_vTf9MSgOATwE";
const SHEET_TAB = process.env.SHEET_TAB || "signups";

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN"); process.exit(1);
}

// ------- KONFIG TEKSTOVA / LINKOVA -------
const CONTACT_URL = "https://t.me/aleksa_asf01";

const MSG_WELCOME =
  "Dobrodosao u ASForex Tim!\n\n" +
  "Za pocetak upisi svoj Email, kako bi nastavili sa tvojom registracijom za tvoj DEMO nalog!";

const MSG_ASK_PHONE =
  "Hvala! ✅\n\nSada upiši broj telefona (npr 0611234567):";

function formatAccountMsg({ login, password, server = "MetaQuotes-Demo" }) {
  return (
    "Tvoj nalog je spreman! molim te pogledaj ovaj video ispod kako bih se povezao na nalog i pratio nase rezultate!\n\n" +
    "Ako ti je potrebna pomoć, klikni na dugme ispod.\n\n" +
    `<pre>Login:    ${login}
Password: ${password}
Server:   ${server}
Platform: MT4</pre>`
  );
}

// ========== lokalni storage chat-ova (za broadcast) ==========
const DATA_DIR = "C:\\bot\\data";
const CHATS_FILE = path.join(DATA_DIR, "chats.json");
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CHATS_FILE)) fs.writeFileSync(CHATS_FILE, "[]");

const loadChats = () => { try { return JSON.parse(fs.readFileSync(CHATS_FILE, "utf8")); } catch { return []; } };
const saveChats = (arr) => { try { fs.writeFileSync(CHATS_FILE, JSON.stringify(arr, null, 2)); } catch {} };
const upsertChat = (chat) => { const arr = loadChats(); const i = arr.findIndex(c=>c.id===chat.id); if(i>=0) arr[i]=chat; else arr.push(chat); saveChats(arr); };

// ========== Google Sheets helper ==========
async function getSheetsClient() {
  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
  let auth;
  if (process.env.GOOGLE_CREDENTIALS) {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    auth = new google.auth.GoogleAuth({ credentials: creds, scopes });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes });
  } else {
    throw new Error("Missing GOOGLE_CREDENTIALS or GOOGLE_APPLICATION_CREDENTIALS");
  }
  return google.sheets({ version: "v4", auth: await auth.getClient() });
}

async function appendSignupRow(row) {
  if (!SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] }
    });
  } catch (e) {
    console.error("Google Sheets append error:", e.message);
  }
}

// ========== Telegram bot ==========
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// sesije: chatId -> { step, first, last, email, phone }
const sessions = {};

const isValidEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s||""));
const cleanedPhone = (s) => (s || "").replace(/[^\d+]/g, "");

// UI helpers
function askEmail(chatId) {
  sessions[chatId].step = "email";
  bot.sendMessage(chatId, MSG_WELCOME);
}
function askPhone(chatId) {
  sessions[chatId].step = "phone";
  bot.sendMessage(chatId, MSG_ASK_PHONE);
}
function askConfirm(chatId) {
  const s = sessions[chatId] || {};
  sessions[chatId].step = "confirm";
  const text =
    "Proveri podatke pre slanja prijave:\n" +
    `• Email: ${s.email || "—"}\n` +
    `• Telefon: ${s.phone || "—"}\n\n` +
    "Da li želiš da promeniš svoje podatke, ili da pošaljem prijavu?";
  bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Ne, pošalji prijavu", callback_data: "confirm_send" },
          { text: "✏️ Želim da promenim", callback_data: "confirm_change" }
        ]
      ]
    }
  });
}
function askWhatToChange(chatId) {
  sessions[chatId].step = "edit_choice";
  bot.sendMessage(chatId, "Šta želiš da promeniš?", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📧 Email", callback_data: "change_email" },
          { text: "📱 Broj telefona", callback_data: "change_phone" }
        ],
        [{ text: "⬅️ Nazad", callback_data: "back_confirm" }]
      ]
    }
  });
}

async function createAccount(chatId, fromUser) {
  const s = sessions[chatId];
  if (!s) return;

  sessions[chatId].step = "creating";
  await bot.sendMessage(chatId, "✅ Registracija tvog DEMO naloga je u toku, molimo sačekaj...");

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
    let data = null;
    try { data = JSON.parse(txt); } catch { data = { ok:false, error: "Bad JSON from API", raw: txt }; }

    if (!res.ok) {
      await bot.sendMessage(chatId, `Došlo je do greške: ${data?.error || res.statusText}`);
      return;
    }

    const acc = data.account || {};
    if (acc.login && acc.password) {
      await bot.sendMessage(
        chatId,
        formatAccountMsg({ login: acc.login, password: acc.password, server: "MetaQuotes-Demo" }),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📩 Kontaktiraj me!", url: CONTACT_URL }]
            ]
          }
        }
      );

      // log u Google Sheet (investor ostavljamo prazno da ne razbijamo kolone)
      const row = [
        new Date().toISOString(),
        chatId,
        fromUser?.username || "",
        s.first || "",
        s.last  || "",
        s.email,
        s.phone,
        acc.login || "",
        acc.password || "",
        "",                      // Investor prazno
        "MetaQuotes-Demo",
        "telegram"
      ];
      appendSignupRow(row).catch(console.error);
    } else {
      await bot.sendMessage(chatId, `Nije dobijen login/password. Detalji: ${data?.mt4?.error || data?.error || "unknown error"}`);
    }
  } catch (e) {
    await bot.sendMessage(chatId, `Nešto je puklo: ${String(e)}`);
  } finally {
    delete sessions[chatId];
  }
}

// ========== Komande ==========
bot.onText(/\/start|\/create/i, async (msg) => {
  const chatId = msg.chat.id;
  const first = (msg.from?.first_name || "").trim();
  const last  = (msg.from?.last_name || "").trim();

  sessions[chatId] = { step: "email", first, last, email: "", phone: "" };
  upsertChat({ id: chatId, username: msg.from?.username || "", first, last, added_at: new Date().toISOString() });

  askEmail(chatId);
});

// Broadcast (admin)
bot.onText(/^\/broadcast (.+)$/s, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(String(chatId))) return bot.sendMessage(chatId, "Nemaš ovlašcenje za /broadcast.");
  const text = match[1].trim();
  const chats = loadChats();
  let ok = 0, fail = 0;
  for (const c of chats) { try { await bot.sendMessage(c.id, text); ok++; } catch { fail++; } }
  bot.sendMessage(chatId, `Broadcast poslat. OK: ${ok}, FAIL: ${fail}`);
});

// ========== Obrada poruka ==========
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const s = sessions[chatId];
  if (!s) return;
  if (msg.data || (typeof msg.text === "string" && msg.text.startsWith("/"))) return;

  if (s.step === "email") {
    const e = (msg.text || "").trim();
    if (!isValidEmail(e)) return bot.sendMessage(chatId, "Email ne deluje ispravno. Probaj ponovo:");
    s.email = e;
    return askPhone(chatId);
  }

  if (s.step === "phone") {
    const p = cleanedPhone(msg.text);
    if (!p || p.length < 6) return bot.sendMessage(chatId, "Telefon ne deluje ispravno. Pošalji broj u formatu npr 0611234567.");
    s.phone = p;
    return askConfirm(chatId);
  }

  if (s.step === "edit_email") {
    const e = (msg.text || "").trim();
    if (!isValidEmail(e)) return bot.sendMessage(chatId, "Email ne deluje ispravno. Probaj ponovo:");
    s.email = e;
    return askConfirm(chatId);
  }

  if (s.step === "edit_phone") {
    const p = cleanedPhone(msg.text);
    if (!p || p.length < 6) return bot.sendMessage(chatId, "Telefon ne deluje ispravno. Pošalji broj u formatu npr 0611234567.");
    s.phone = p;
    return askConfirm(chatId);
  }
});

// ========== Inline dugmad (callback_query) ==========
bot.on("callback_query", async (cbq) => {
  const chatId = cbq.message?.chat?.id;
  const data = cbq.data;
  if (!chatId || !sessions[chatId]) return bot.answerCallbackQuery(cbq.id);

  // HOĆEMO da nestane poruka sa dugmadima čim neko klikne:
  const confirmMsgId = cbq.message.message_id;

  if (data === "confirm_send") {
    await bot.answerCallbackQuery(cbq.id);
    try { await bot.deleteMessage(chatId, confirmMsgId); } catch {}
    return createAccount(chatId, cbq.from);
  }

  if (data === "confirm_change") {
    await bot.answerCallbackQuery(cbq.id);
    try { await bot.deleteMessage(chatId, confirmMsgId); } catch {}
    return askWhatToChange(chatId);
  }

  if (data === "change_email") {
    await bot.answerCallbackQuery(cbq.id);
    return bot.sendMessage(chatId, "Unesi novi Email:");
  }

  if (data === "change_phone") {
    await bot.answerCallbackQuery(cbq.id);
    return bot.sendMessage(chatId, "Unesi novi broj telefona (npr 0611234567):");
  }

  if (data === "back_confirm") {
    await bot.answerCallbackQuery(cbq.id);
    return askConfirm(chatId);
  }

  await bot.answerCallbackQuery(cbq.id);
});

console.log("Telegram bot running (polling)…");
