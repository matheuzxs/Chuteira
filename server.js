require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const PARADISE_BASE = "https://multi.paradisepags.com/api/v1";
const PARADISE_KEY = process.env.PARADISE_API_KEY;

// transactionId → { paradiseId, paidSent }
const pixMap = new Map();

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

    pixMap.set(transactionId, { paradiseId: data.transaction_id, paidSent: false });

    console.log(`[PIX] Criado | ref=${transactionId} paradiseId=${data.transaction_id} R$${(cents / 100).toFixed(2)}`);

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

    const info = pixMap.get(txId);
    if (!info) return res.json({ status: "pending" });

    const apiRes = await fetch(
      `${PARADISE_BASE}/query.php?action=list_transactions&external_id=${encodeURIComponent(txId)}`,
      { headers: { "X-API-Key": PARADISE_KEY } },
    );

    const data = await apiRes.json();
    const tx = Array.isArray(data) ? data[0] : null;
    const rawStatus = tx?.status || "pending";

    // Paradise usa "approved" em vez de "paid"
    const status = rawStatus === "approved" ? "paid" : rawStatus;

    if (status === "paid" && !info.paidSent) {
      info.paidSent = true;
      console.log(`[PIX] Pago! ref=${txId} paradiseId=${info.paradiseId}`);
    }

    res.json({ status });
  } catch (err) {
    console.error("[Status] Exceção:", err);
    res.json({ status: "pending" });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✓ Servidor rodando em http://localhost:${PORT}`);
  console.log(`  ✓ Paradise API Key: ${PARADISE_KEY ? PARADISE_KEY.slice(0, 12) + "..." : "⚠ NÃO CONFIGURADA"}\n`);
});
