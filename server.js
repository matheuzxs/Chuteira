require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const VENO_BASE = "https://beta.venopayments.com/api/v1";
const VENO_KEY = process.env.VENO_API_KEY;
const UTMIFY_API_TOKEN = process.env.UTMIFY_API_TOKEN || "";
const UTMIFY_API_URL = "https://api.utmify.com.br/api-credentials/orders";

// transactionId → { venoId, amount, customer, tracking, paidSent }
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
      ttclid: utms.ttclid || null,
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

    console.log("[PIX] Body recebido do frontend:", JSON.stringify(req.body, null, 2));

    const venoBody = {
      amount: cents,
      external_id: transactionId,
      description: description || productName || "Pagamento PIX",
      payer: {
        name: payerName || customer?.name || "",
        document: payerDocument || "",
        email: customer?.email || "",
        phone: customer?.phone || "",
        address: [customer?.endereco, customer?.numero, customer?.complemento, customer?.bairro].filter(Boolean).join(", ") || "",
        city: customer?.cidade || "",
        state: (customer?.estado || "").slice(0, 2).toUpperCase(),
        zip_code: (customer?.cep || "").replace(/\D/g, ""),
      },
    };

    if (tracking) {
      if (tracking.utm_source)   venoBody.utm_source   = tracking.utm_source;
      if (tracking.utm_campaign) venoBody.utm_campaign = tracking.utm_campaign;
      if (tracking.utm_medium)   venoBody.utm_medium   = tracking.utm_medium;
      if (tracking.utm_content)  venoBody.utm_content  = tracking.utm_content;
      if (tracking.utm_term)     venoBody.utm_term     = tracking.utm_term;
      if (tracking.src)          venoBody.src          = tracking.src;
      if (tracking.sck)          venoBody.sck          = tracking.sck;
    }

    const venoRes = await fetch(`${VENO_BASE}/pix`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VENO_KEY}`,
      },
      body: JSON.stringify(venoBody),
    });

    const venoData = await venoRes.json();

    if (!venoRes.ok) {
      console.error("[Veno] Erro ao criar PIX:", venoData);
      return res.status(venoRes.status).json({
        error: venoData.message || "Erro ao criar PIX na gateway",
      });
    }

    const orderInfo = {
      venoId: venoData.id,
      transactionId,
      cents,
      name: payerName || customer?.name || "",
      email: customer?.email || "",
      phone: customer?.phone || "",
      document: payerDocument || "",
      tracking: tracking || {},
      ip: req.headers["x-forwarded-for"]?.split(",")[0] || req.socket?.remoteAddress || "",
      createdAt: new Date().toISOString().replace("T", " ").substring(0, 19),
      paidSent: false,
    };
    pixMap.set(transactionId, orderInfo);

    console.log(`[PIX] Criado | txId=${transactionId} venoId=${venoData.id} R$${(cents / 100).toFixed(2)}`);

    sendUtmifyEvent(orderInfo, "waiting_payment");

    res.json({
      copyPaste: venoData.pix_copy_paste || venoData.qr_code,
      qrcodeUrl: venoData.qr_code_image || null,
      qrCodeBase64: null,
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

    const venoRes = await fetch(`${VENO_BASE}/pix/${orderInfo.venoId}/status`, {
      headers: { Authorization: `Bearer ${VENO_KEY}` },
    });

    const venoData = await venoRes.json();
    const st = venoData.status || "pending";

    if ((st === "paid" || st === "approved") && !orderInfo.paidSent) {
      orderInfo.paidSent = true;
      sendUtmifyEvent(orderInfo, "paid");
    }

    res.json({ status: st });
  } catch (err) {
    console.error("[Status] Exceção:", err);
    res.json({ status: "pending" });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✓ Servidor rodando em http://localhost:${PORT}`);
  console.log(`  ✓ Veno API Key: ${VENO_KEY ? VENO_KEY.slice(0, 16) + "..." : "⚠ NÃO CONFIGURADA"}\n`);
});
