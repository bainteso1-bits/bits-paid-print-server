require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();

/* ================================
   GLOBAL MIDDLEWARE (MUST BE FIRST)
================================ */
app.use(cors());
app.use(express.json());

/* ================================
   BOOT LOG
================================ */
console.log("🔥 SERVER.JS LOADED");

/* ================================
   STEP 2 — TEST ROUTES
================================ */
app.post("/test", (req, res) => {
  console.log("✅ /test route hit");
  res.status(200).json({ ok: true });
});

app.post("/create-order-test", (req, res) => {
  console.log("✅ /create-order-test hit");
  res.status(200).json({ reached: true });
});

// ==============================
// STEP 3 – CREATE ORDER (NO PAYMENT)
// ==============================

app.post("/create-order", upload.single("file"), async (req, res) => {
  try {
    console.log("📥 /create-order hit");

    const file = req.file;
    const color_mode = (req.body.color_mode || "bw").toLowerCase();
    const copies = Math.max(parseInt(req.body.copies || "1", 10), 1);

    if (!file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    if (path.extname(file.originalname).toLowerCase() !== ".pdf") {
      return res.status(400).json({ success: false, error: "Only PDF files allowed" });
    }

    if (!["bw", "color"].includes(color_mode)) {
      return res.status(400).json({ success: false, error: "Invalid color_mode" });
    }

    // Count pages
    const pages = countPdfPages(file.buffer);

    // Pricing
    const pricePerPage = color_mode === "bw" ? BW_PRICE : COLOR_PRICE;
    const amount_cents = pages * copies * pricePerPage;

    // Generate unique code
    let code = generateCode();

    const safeName = file.originalname.replace(/[<>:"/\\|?*]+/g, "_");
    const storagePath = `${code}/${Date.now()}_${safeName}`;

    // Upload to Supabase Storage
    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: "application/pdf"
      });

    if (uploadErr) throw uploadErr;

    // Insert order
    const { data: order, error: dbErr } = await supabase
      .from("print_orders")
      .insert({
        code,
        bucket: BUCKET,
        file_path: storagePath,
        file_name: safeName,
        color_mode,
        copies,
        pages,
        amount_cents,
        status: "created"
      })
      .select()
      .single();

    if (dbErr) throw dbErr;

    res.json({
      success: true,
      code,
      pages,
      copies,
      amount_cents
    });

  } catch (err) {
    console.error("❌ create-order error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});


/* ================================
   FILE UPLOAD CONFIG
================================ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

/* ================================
   SUPABASE
================================ */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/* ================================
   CONSTANTS
================================ */
const BUCKET = "paid-print-jobs";
const BW_PRICE = parseInt(process.env.BW_PRICE_CENTS || "200", 10);
const COLOR_PRICE = parseInt(process.env.COLOR_PRICE_CENTS || "800", 10);

/* ================================
   HELPERS
================================ */
function generateCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function countPdfPages(buffer) {
  const text = buffer.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 1;
}

/* ================================
   HEALTH CHECK
================================ */
app.get("/", (req, res) => {
  res.send("BiTS Paid Print Server ✅");
});

/* ================================
   START SERVER (RENDER SAFE)
================================ */
const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});