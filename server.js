require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const PARADISE_BASE = "https://multi.paradisepags.com/api/v1";
const PARADISE_KEY = process.env.PARADISE_API_KEY;
const UTMIFY_API_TOKEN = process.env.UTMIFY_API_TOKEN || "";
const UTMIFY_API_URL = "https://api.utmify.com.br/api-credentials/orders";

// transactionId → { paradiseId, cents, name, email, phone, document, tracking, ip, createdAt, paidSent }
const pixMap = new Map();

async function sendUtmifyEvent(orderInfo, status) {
  if (!UTMIFY_API_TOKEN) return;
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  const utms = orderInfo.tracking || {};

  const payload = {
    orderId: String(orderInfo.transactionId),
    platform: "OwnPlatform",
    paymentMethod: "pix",
    status: status,
    createdAt: orderInfo.createdAt || now,
    approvedDate: status === "paid" ? now : null,
    refundedAt: null,
    customer: {
      name: orderInfo.name || "Cliente",
      email: orderInfo.email || "",
      phone: (orderInfo.phone || "").replace(/\D/g, "") || null,
      document: (orderInfo.document || "").replace(/\D/g, "") || null,
      country: "BR",
      ip: orderInfo.ip || null,
    },
    products: [
      {
        id: "chuteira-kintsugi",
        name: "Chuteira Futsal Pro 5 Bump Kintsugi Unissex",
        planId: null,
        planName: null,
        quantity: 1,
        priceInCents: orderInfo.cents || 0,
      },
    ],
    trackingParameters: {
      src: utms.src || null,
      sck: utms.sck || null,
      utm_source: utms.utm_source || null,
      utm_campaign: utms.utm_campaign || null,
      utm_medium: utms.utm_medium || null,
      utm_content: utms.utm_content || null,
      utm_term: utms.utm_term || null,
    },
    commission: {
      totalPriceInCents: orderInfo.cents || 0,
      gatewayFeeInCents: 0,
      userCommissionInCents: orderInfo.cents || 0,
      currency: "BRL",
    },
    isTest: false,
  };

  try {
    const res = await fetch(UTMIFY_API_URL, {
      method: "POST",
      headers: { "x-api-token": UTMIFY_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log(`[Utmify] ${status} → ${res.status} ${text.slice(0, 200)}`);
  } catch (e) {
    console.error(`[Utmify] ${status} erro:`, e.message);
  }
}

app.use(express.json());
app.use(express.static(path.join(__dirname), { index: "index.html", etag: false, maxAge: 0 }));
app.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

// ── Criar PIX ───────────────────────────────────────────────────────────
app.post("/api/create-pix", async (req, res) => {
  try {
    const {
      amount, payerName, payerDocument, description,
      transactionId, customer, tracking, totalCents, qty, productName,
    } = req.body;

    const cents = totalCents || Math.round((amount || 0) * 100);
    const phone = (customer?.phone || "").replace(/\D/g, "");
    const doc = (payerDocument || "").replace(/\D/g, "");

    const body = {
      amount: cents,
      description: productName || description || "Chuteira Futsal Pro 5 Bump Kintsugi Unissex",
      reference: transactionId,
      source: "api_externa",
      customer: {
        name: payerName || customer?.name || "Cliente",
        email: customer?.email || "sem@email.com",
        document: doc,
        phone: phone,
      },
    };

    if (tracking) {
      body.tracking = {
        utm_source: tracking.utm_source || undefined,
        utm_medium: tracking.utm_medium || undefined,
        utm_campaign: tracking.utm_campaign || undefined,
        utm_content: tracking.utm_content || undefined,
        utm_term: tracking.utm_term || undefined,
        src: tracking.src || undefined,
        sck: tracking.sck || undefined,
      };
    }

    console.log("[PIX] Enviando para Paradise:", JSON.stringify(body, null, 2));

    const apiRes = await fetch(`${PARADISE_BASE}/transaction.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": PARADISE_KEY,
      },
      body: JSON.stringify(body),
    });

    const data = await apiRes.json();

    if (data.status !== "success") {
      console.error("[Paradise] Erro:", JSON.stringify(data, null, 2));
      return res.status(400).json({
        error: data.message || "Erro ao criar PIX na gateway",
      });
    }

    const orderInfo = {
      transactionId,
      paradiseId: data.transaction_id,
      cents,
      name: payerName || customer?.name || "",
      email: customer?.email || "",
      phone,
      document: doc,
      tracking: tracking || {},
      ip: req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "",
      createdAt: new Date().toISOString().replace("T", " ").substring(0, 19),
      paidSent: false,
    };
    pixMap.set(transactionId, orderInfo);

    console.log(`[PIX] Criado | ref=${transactionId} paradiseId=${data.transaction_id} R$${(cents / 100).toFixed(2)}`);

    sendUtmifyEvent(orderInfo, "waiting_payment");

    res.json({
      copyPaste: data.qr_code || "",
      qrcodeUrl: null,
      qrCodeBase64: data.qr_code_base64 || null,
      transactionId,
    });
  } catch (err) {
    console.error("[PIX] Exceção:", err);
    res.status(500).json({ error: "Erro interno ao gerar PIX" });
  }
});

// ── Consultar status ────────────────────────────────────────────────────
app.get("/api/create-pix", async (req, res) => {
  try {
    const txId = req.query.id;
    if (!txId) return res.status(400).json({ error: "id obrigatório" });

    const orderInfo = pixMap.get(txId);
    if (!orderInfo) return res.json({ status: "pending" });

    const apiRes = await fetch(
      `${PARADISE_BASE}/query.php?action=list_transactions&external_id=${encodeURIComponent(txId)}`,
      { headers: { "X-API-Key": PARADISE_KEY } },
    );

    const data = await apiRes.json();
    const tx = Array.isArray(data) ? data[0] : null;
    const rawStatus = tx?.status || "pending";

    const status = rawStatus === "approved" ? "paid" : rawStatus;

    if (status === "paid" && !orderInfo.paidSent) {
      orderInfo.paidSent = true;
      console.log(`[PIX] Pago! ref=${txId} paradiseId=${orderInfo.paradiseId}`);
      sendUtmifyEvent(orderInfo, "paid");
    }

    res.json({ status });
  } catch (err) {
    console.error("[Status] Exceção:", err);
    res.json({ status: "pending" });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✓ Servidor rodando em http://localhost:${PORT}`);
  console.log(`  ✓ Paradise API Key: ${PARADISE_KEY ? PARADISE_KEY.slice(0, 12) + "..." : "⚠ NÃO CONFIGURADA"}`);
  console.log(`  ✓ Utmify Token: ${UTMIFY_API_TOKEN ? UTMIFY_API_TOKEN.slice(0, 12) + "..." : "⚠ NÃO CONFIGURADO"}\n`);
});
