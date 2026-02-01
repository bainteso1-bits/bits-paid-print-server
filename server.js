require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");

const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

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
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ✅ Minimal PDF page count (works for most PDFs)
function countPdfPages(buffer) {
  const text = buffer.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page\b/g);
  return matches ? matches.length : 1;
}

// ✅ Create Yoco checkout (Yoco Online API)
async function createYocoCheckout({ amount_cents, description, successUrl, cancelUrl, metadata }) {
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

// ✅ Health check
app.get("/", (req, res) => {
  res.send("BiTS Paid Print Server ✅");
});

/**
 * POST /create-order
 * body:
 *   color_mode: "bw" | "color"
 *   copies: number
 * file: pdf
 */
app.post("/create-order", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const color_mode = (req.body.color_mode || "bw").toLowerCase();
    const copies = Math.max(parseInt(req.body.copies || "1", 10), 1);

    if (!file) return res.status(400).json({ success: false, error: "No file uploaded" });

    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".pdf") {
      return res.status(400).json({ success: false, error: "PDF only allowed" });
    }

    if (!["bw", "color"].includes(color_mode)) {
      return res.status(400).json({ success: false, error: "Invalid color_mode" });
    }

    // Count pages
    const pages = countPdfPages(file.buffer);
    const pricePerPage = color_mode === "bw" ? BW_PRICE : COLOR_PRICE;
    const amount_cents = pages * copies * pricePerPage;

    // Generate unique code (retry if collision)
    let code = generateCode();
    for (let tries = 0; tries < 5; tries++) {
      const { data: exists } = await supabase
        .from("print_orders")
        .select("id")
        .eq("code", code)
        .maybeSingle();

      if (!exists) break;
      code = generateCode();
    }

    // Upload to Supabase Storage
    const safeName = file.originalname.replace(/[<>:"/\\|?*]+/g, "_");
    const storagePath = `${code}/${Date.now()}_${safeName}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, file.buffer, {
        contentType: "application/pdf",
        upsert: false
      });

    if (upErr) throw new Error("Upload failed: " + upErr.message);

    // Insert DB record
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

    if (dbErr) throw new Error("DB insert failed: " + dbErr.message);

    // Create Yoco checkout
    const successUrl = `https://example.com/success?code=${code}`; // replace later
    const cancelUrl = `https://example.com/cancel?code=${code}`;   // replace later

    const checkout = await createYocoCheckout({
      amount_cents,
      description: `BiTS Printing (${color_mode.toUpperCase()}) - Code ${code}`,
      successUrl,
      cancelUrl,
      metadata: { code }
    });

    // Save payment reference (checkout id)
    await supabase
      .from("print_orders")
      .update({ payment_ref: checkout.id })
      .eq("id", order.id);

    return res.json({
      success: true,
      code,
      pages,
      copies,
      color_mode,
      amount_cents,
      payUrl: checkout.redirectUrl
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ✅ Yoco webhook (YOU MUST configure webhook URL in Yoco dashboard)
app.post("/webhook/yoco", async (req, res) => {
  try {
    // NOTE: Real webhook verification depends on Yoco’s webhook signing.
    // For now we accept event and update using checkout ID.
    const event = req.body;

    const checkoutId = event?.payload?.id;
    const status = event?.payload?.status;

    if (!checkoutId) return res.status(400).send("No checkout id");
    if (status !== "succeeded") return res.status(200).send("Ignored");

    // Find order by payment_ref = checkoutId
    const { data: order, error } = await supabase
      .from("print_orders")
      .select("*")
      .eq("payment_ref", checkoutId)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!order) return res.status(404).send("Order not found");

    // Mark paid
    await supabase
      .from("print_orders")
      .update({
        status: "paid",
        paid_at: new Date().toISOString()
      })
      .eq("id", order.id);

    res.status(200).send("OK");
  } catch (err) {
    console.error(err);
    res.status(500).send("Webhook error");
  }
});

app.listen(process.env.PORT || 8080, "0.0.0.0", () => {
  console.log("✅ Paid print server running on port", process.env.PORT || 8080);
});