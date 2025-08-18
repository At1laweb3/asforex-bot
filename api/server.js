// server.js — MT4 Demo creator (AHK v1 + MT4 Portable)
// API: POST /mt4/create  {first,last,email,phone}

const express = require("express");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = 8081;

// Gde AHK upisuje rezultat (fiksno ime fajla jer tako radi tvoja .ahk skripta)
const OUT_DIR  = "C:\\bot\\out";
const OUT_FILE = path.join(OUT_DIR, "result.json");

// (opciono) env var da preskocimo autodetekciju
//   setx AHK_EXE    "C:\Program Files\AutoHotkey\AutoHotkeyU64.exe"
//   setx AHK_SCRIPT "C:\bot\create_mt4_demo.ahk"
const AHK_EXE_ENV    = process.env.AHK_EXE || "";
const AHK_SCRIPT_ENV = process.env.AHK_SCRIPT || "";

// Najcešce lokacije AHK v1 (x64 prvo). Poštujemo env ako je zadat.
const AHK_EXE_CANDIDATES = [
  AHK_EXE_ENV,
  "C:\\Program Files\\AutoHotkey\\AutoHotkeyU64.exe",
  "C:\\Program Files\\AutoHotkey\\AutoHotkey.exe",
  "C:\\Program Files (x86)\\AutoHotkey\\AutoHotkeyU32.exe"
].filter(Boolean);

// AHK skripta
const AHK_SCRIPT = AHK_SCRIPT_ENV || "C:\\bot\\create_mt4_demo.ahk";

function findAhkExe() {
  for (const p of AHK_EXE_CANDIDATES) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

app.get("/health", (_req, res) => res.send("ok"));

app.post("/mt4/create", async (req, res) => {
  try {
    const { first, last, email, phone } = req.body || {};
    if (!first || !last || !email || !phone) {
      return res.status(400).json({ ok: false, error: "Missing first/last/email/phone" });
    }

    const ahkExe = findAhkExe();
    if (!ahkExe) {
      return res.status(500).json({ ok: false, error: "AutoHotkey not found (install or fix path)" });
    }
    if (!fs.existsSync(AHK_SCRIPT)) {
      return res.status(500).json({ ok: false, error: `AHK script not found at ${AHK_SCRIPT}` });
    }

    ensureDir(OUT_DIR);
    try { fs.unlinkSync(OUT_FILE); } catch {} // ocisti stari rezultat

    // AHK v1 prima argumente kao %1% %2% %3% %4%
    const args = [AHK_SCRIPT, first, last, email, phone];

    const child = spawn(ahkExe, args, { windowsHide: true });

    child.stdout?.on("data", d => console.log("[AHK stdout]", String(d)));
    child.stderr?.on("data", d => console.error("[AHK stderr]", String(d)));
    child.on("error", (err) => console.error("spawn error:", err));

    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { child.kill(); } catch {}
        return res.status(504).json({ ok: false, error: "Timeout creating demo (AHK took too long)" });
      }
    }, 180000); // 3 min

    child.on("exit", (_code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      try {
        if (!fs.existsSync(OUT_FILE)) {
          return res.status(500).json({ ok: false, error: "No result file produced by AHK" });
        }

        // Vrati baš ono što je AHK upisao (bez duplog parse-a)
        let raw = fs.readFileSync(OUT_FILE, "utf8");
        raw = raw.replace(/^\uFEFF/, "").trim(); // skini BOM

        // Probaj da ispeglaš duple zagrade {{...}} ako ih ima
        let payloadText = raw;
        try {
          JSON.parse(raw);
        } catch {
          const fixed = raw.replace(/^\s*\{\{/, "{").replace(/\}\}\s*$/, "}");
          try { JSON.parse(fixed); payloadText = fixed; } catch {}
        }

        res.type("application/json").send(payloadText);
      } catch (e) {
        return res.status(500).json({ ok: false, error: String(e) });
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => console.log("API listening on", PORT));
