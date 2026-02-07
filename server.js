require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

/* ================================
   FETCH (SAFE FOR RENDER)
================================ */
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();

/* ================================
   GLOBAL MIDDLEWARE
================================ */
app.use(cors());
app.use(express.json());

console.log("🔥 SERVER.JS LOADED");

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
   YOCO CHECKOUT
================================ */
async function createYocoCheckout({ amount_cents, description, code }) {
  const response = await fetch("https://payments.yoco.com/api/checkouts", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.YOCO_SECRET_KEY}`
    },
    body: JSON.stringify({
      amount: amount_cents,
      currency: "ZAR",
      description,
      successUrl: `${process.env.PUBLIC_BASE_URL}/success?code=${code}`,
      cancelUrl: `${process.env.PUBLIC_BASE_URL}/cancel?code=${code}`,
      metadata: { code }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.message || "Failed to create Yoco checkout");
  }

  return data;
}

/* ================================
   STEP 2 — TEST ROUTES
================================ */
app.post("/test", (req, res) => {
  console.log("✅ /test hit");
  res.json({ ok: true });
});

app.post("/create-order-test", upload.single("file"), (req, res) => {
  console.log("✅ /create-order-test hit");
  console.log("Body:", req.body);
  console.log("File:", req.file?.originalname);

  res.json({
    reached: true,
    hasFile: !!req.file
  });
});

/* ================================
   STEP 4 — CREATE ORDER + PAYMENT
================================ */
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
      return res.status(400).json({ success: false, error: "Only PDF allowed" });
    }

    const pages = countPdfPages(file.buffer);
    const pricePerPage = color_mode === "bw" ? BW_PRICE : COLOR_PRICE;
    const amount_cents = pages * copies * pricePerPage;

    const code = generateCode();
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
      description: `BiTS Printing (${color_mode.toUpperCase()}) - ${code}`,
      code
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
    console.error("❌ create-order error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ================================
   YOCO WEBHOOK
================================ */
app.post("/webhook/yoco", async (req, res) => {
  try {
    const checkoutId = req.body?.payload?.id;
    const status = req.body?.payload?.status;

    if (!checkoutId) return res.status(400).send("Missing checkout id");
    if (status !== "succeeded") return res.send("Ignored");

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
    console.error("Webhook error:", err);
    res.status(500).send("Webhook failed");
  }
});

/* ================================
   HEALTH CHECK
================================ */
app.get("/", (req, res) => {
  res.send("BiTS Paid Print Server ✅");
});

/* ================================
   START SERVER
================================ */
const PORT = process.env.PORT || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
});