require("dotenv").config();

console.log("🔥 SERVER.JS LOADED - VERSION 2026-02-01");

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());

/* ================================
   STEP 2 – TEST ROUTES (NO BODY PARSERS)
   ================================ */
app.post("/test", (req, res) => {
  console.log("✅ /test route hit");
  res.json({ ok: true });
});


app.post("/create-order-test", (req, res) => {
  res.json({ reached: true });
});

/* ================================
   BODY PARSERS AFTER TEST ROUTES
   ================================ */
app.use(express.json());

/* ================================
   MULTER (FILE UPLOADS)
   ================================ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

/* ================================
   SUPABASE
   ================================ */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = "paid-print-jobs";
const BW_PRICE = parseInt(process.env.BW_PRICE_CENTS || "200", 10);
const COLOR_PRICE = parseInt(process.env.COLOR_PRICE_CENTS || "800", 10);

function generateCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/* ================================
   PDF PAGE COUNT
   ================================ */
function countPdfPages(buffer) {
  const text = buffer.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 1;
}

/* ================================
   YOCO CHECKOUT
   ================================ */
async function createYocoCheckout({
  amount_cents,
  description,
  successUrl,
  cancelUrl,
  metadata
}) {
  const resp = await fetch("https://payments.yoco.com/api/checkouts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.YOCO_SECRET_KEY}`
    },
    body: JSON.stringify({
      amount: amount_cents,
      currency: "ZAR",
      description,
      successUrl,
      cancelUrl,
      metadata
    })
  });

  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(data?.message || "Failed to create Yoco checkout");
  }

  return data;
}

/* ================================
   HEALTH CHECK
   ================================ */
app.get("/", (req, res) => {
  res.send("BiTS Paid Print Server ✅");
});

/* ================================
   CREATE ORDER (REAL ROUTE)
   ================================ */
console.log("🚀 Registering /create-order route");

app.post("/create-order", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const color_mode = (req.body.color_mode || "bw").toLowerCase();
    const copies = Math.max(parseInt(req.body.copies || "1", 10), 1);

    if (!file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    if (path.extname(file.originalname).toLowerCase() !== ".pdf") {
      return res.status(400).json({ success: false, error: "PDF only allowed" });
    }

    if (!["bw", "color"].includes(color_mode)) {
      return res.status(400).json({ success: false, error: "Invalid color_mode" });
    }

    const pages = countPdfPages(file.buffer);
    const pricePerPage = color_mode === "bw" ? BW_PRICE : COLOR_PRICE;
    const amount_cents = pages * copies * pricePerPage;

    let code = generateCode();
    for (let i = 0; i < 5; i++) {
      const { data } = await supabase
        .from("print_orders")
        .select("id")
        .eq("code", code)
        .maybeSingle();

      if (!data) break;
      code = generateCode();
    }

    const safeName = file.originalname.replace(/[<>:"/\\|?*]+/g, "_");
    const storagePath = `${code}/${Date.now()}_${safeName}`;

    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: "application/pdf"
      });

    if (uploadErr) throw uploadErr;

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
        status: "pending_payment"
      })
      .select()
      .single();

    if (dbErr) throw dbErr;

    const checkout = await createYocoCheckout({
      amount_cents,
      description: `BiTS Printing (${color_mode.toUpperCase()}) - Code ${code}`,
      successUrl: `https://bits-paid-print-server.onrender.com/success?code=${code}`,
      cancelUrl: `https://bits-paid-print-server.onrender.com/cancel?code=${code}`,
      metadata: { code }
    });

    await supabase
      .from("print_orders")
      .update({ payment_ref: checkout.id })
      .eq("id", order.id);

    res.json({
      success: true,
      code,
      pages,
      copies,
      amount_cents,
      payUrl: checkout.redirectUrl
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ================================
   YOCO WEBHOOK
   ================================ */
app.post("/webhook/yoco", async (req, res) => {
  try {
    const event = req.body;
    const checkoutId = event?.payload?.id;
    const status = event?.payload?.status;

    if (!checkoutId) return res.status(400).send("No checkout id");
    if (status !== "succeeded") return res.status(200).send("Ignored");

    const { data: order } = await supabase
      .from("print_orders")
      .select("*")
      .eq("payment_ref", checkoutId)
      .maybeSingle();

    if (!order) return res.status(404).send("Order not found");

    await supabase
      .from("print_orders")
      .update({
        status: "paid",
        paid_at: new Date().toISOString()
      })
      .eq("id", order.id);

    res.send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("Webhook error");
  }
});

/* ================================
   START SERVER
   ================================ */
app.listen(process.env.PORT || 8080, "0.0.0.0", () => {
  console.log("✅ Paid print server running");
});