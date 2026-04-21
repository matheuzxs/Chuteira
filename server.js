require("dotenv").config();
const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const PARADISE_BASE = "https://multi.paradisepags.com/api/v1";
const PARADISE_KEY = process.env.PARADISE_API_KEY;
const UTMIFY_API_TOKEN = process.env.UTMIFY_API_TOKEN || "";
const UTMIFY_API_URL = "https://api.utmify.com.br/api-credentials/orders";
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || "";

// ── Active visitors ─────────────────────────────────────────────────────
const activeVisitors = new Map();

function cleanStale() {
  const now = Date.now();
  for (const [id, v] of activeVisitors) {
    if (now - v.lastSeen > 90_000) activeVisitors.delete(id);
  }
}
setInterval(cleanStale, 30_000);

function activeCount() { cleanStale(); return activeVisitors.size; }

// ── Discord ─────────────────────────────────────────────────────────────
const discordQueue = [];
let discordTimer = null;

function flushDiscord() {
  discordTimer = null;
  if (!discordQueue.length || !DISCORD_WEBHOOK) return;
  const embeds = discordQueue.splice(0, 10);
  fetch(DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds }),
  }).catch(e => console.error("[Discord]", e.message));
}

function discord(embed) {
  if (!DISCORD_WEBHOOK) return;
  embed.timestamp = new Date().toISOString();
  embed.footer = { text: `👥 ${activeCount()} online agora` };
  discordQueue.push(embed);
  if (!discordTimer) discordTimer = setTimeout(flushDiscord, 1500);
}

function getIP(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "?";
}

function parseUA(ua) {
  if (!ua) return "Desconhecido";
  if (/iphone/i.test(ua)) return "iPhone";
  if (/ipad/i.test(ua)) return "iPad";
  if (/android/i.test(ua)) {
    const m = ua.match(/;\s*([^;)]+)\s*Build/i);
    return m ? m[1].trim() : "Android";
  }
  if (/windows/i.test(ua)) return "Windows PC";
  if (/macintosh/i.test(ua)) return "Mac";
  if (/linux/i.test(ua)) return "Linux";
  return "Outro";
}

function fmtTime(sec) {
  if (!sec || sec < 0) return "0s";
  if (sec < 60) return sec + "s";
  return Math.floor(sec / 60) + "m " + (sec % 60) + "s";
}

// ── UTMify ──────────────────────────────────────────────────────────────
const pixMap = new Map();

async function sendUtmifyEvent(orderInfo, status) {
  if (!UTMIFY_API_TOKEN) return;
  const now = new Date().toISOString().replace("T", " ").substring(0, 19);
  const utms = orderInfo.tracking || {};
  const payload = {
    orderId: String(orderInfo.transactionId),
    platform: "OwnPlatform", paymentMethod: "pix", status,
    createdAt: orderInfo.createdAt || now,
    approvedDate: status === "paid" ? now : null,
    refundedAt: null,
    customer: {
      name: orderInfo.name || "Cliente", email: orderInfo.email || "",
      phone: (orderInfo.phone || "").replace(/\D/g, "") || null,
      document: (orderInfo.document || "").replace(/\D/g, "") || null,
      country: "BR", ip: orderInfo.ip || null,
    },
    products: [{
      id: "chuteira-kintsugi", name: "Chuteira Futsal Pro 5 Bump Kintsugi Unissex",
      planId: null, planName: null, quantity: 1, priceInCents: orderInfo.cents || 0,
    }],
    trackingParameters: {
      src: utms.src || null, sck: utms.sck || null,
      utm_source: utms.utm_source || null, utm_campaign: utms.utm_campaign || null,
      utm_medium: utms.utm_medium || null, utm_content: utms.utm_content || null,
      utm_term: utms.utm_term || null,
    },
    commission: {
      totalPriceInCents: orderInfo.cents || 0, gatewayFeeInCents: 0,
      userCommissionInCents: orderInfo.cents || 0, currency: "BRL",
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

// ── Middleware ───────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname), { index: "index.html", etag: false, maxAge: 0 }));
app.use((req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

// ── Frontend events ─────────────────────────────────────────────────────
app.post("/api/event", (req, res) => {
  const { event, page, visitorId, timeOnSite } = req.body;
  const ip = getIP(req);
  const device = parseUA(req.headers["user-agent"]);
  const time = fmtTime(timeOnSite);

  if (visitorId && event !== "left") {
    activeVisitors.set(visitorId, { ip, device, page, lastSeen: Date.now() });
  }
  if (visitorId && event === "left") {
    activeVisitors.delete(visitorId);
  }

  const base = [
    { name: "📱 Aparelho", value: device, inline: true },
    { name: "🌐 IP", value: `\`${ip}\``, inline: true },
    { name: "⏱️ Tempo no site", value: time, inline: true },
  ];

  switch (event) {
    case "page_view":
      discord({
        title: "Novo visitante entrou",
        description: "Um usuário mobile real acessou a página principal.",
        color: 0x3B82F6,
        fields: base,
      });
      break;

    case "redirected":
      discord({
        title: "Bloqueado — Redirecionado",
        description: `Detectado como **${req.body.reason || "bot/desktop"}** e mandado para \`comprar.html\``,
        color: 0xF59E0B,
        fields: [
          { name: "📱 Aparelho", value: device, inline: true },
          { name: "🌐 IP", value: `\`${ip}\``, inline: true },
        ],
      });
      break;

    case "scroll":
      discord({
        title: `Scrollou ${req.body.percent}% da página`,
        description: req.body.percent >= 75 ? "Está lendo bastante — interesse alto." : "Explorando o site...",
        color: 0x64748B,
        fields: base,
      });
      break;

    case "select_size":
      discord({
        title: `Selecionou tamanho ${req.body.size}`,
        description: "Escolheu um tamanho do produto. Interesse confirmado.",
        color: 0x8B5CF6,
        fields: base,
      });
      break;

    case "click_buy":
      discord({
        title: "Clicou em COMPRAR",
        description: "Pressionou o botão de comprar/adicionar ao carrinho.",
        color: 0xEC4899,
        fields: base,
      });
      break;

    case "checkout_open":
      discord({
        title: "Abriu o checkout",
        description: "O formulário de dados apareceu. Está prestes a comprar.",
        color: 0xA855F7,
        fields: base,
      });
      break;

    case "fill_field":
      discord({
        title: `Preencheu: ${req.body.field}`,
        description: "Está digitando os dados pessoais no checkout.",
        color: 0x6366F1,
        fields: base,
      });
      break;

    case "pix_screen":
      discord({
        title: "Tela do PIX aberta",
        description: "QR Code gerado e aparecendo na tela. Falta só pagar.",
        color: 0x06B6D4,
        fields: base,
      });
      break;

    case "pix_copy":
      discord({
        title: "Copiou o código PIX",
        description: "Clicou pra copiar. Provavelmente vai colar no app do banco agora.",
        color: 0x0EA5E9,
        fields: base,
      });
      break;

    case "left":
      discord({
        title: "Saiu do site",
        description: `Ficou **${fmtTime(req.body.totalTime)}** no total.`,
        color: 0x374151,
        fields: [
          { name: "📱 Aparelho", value: device, inline: true },
          { name: "🌐 IP", value: `\`${ip}\``, inline: true },
        ],
      });
      break;
  }

  res.json({ ok: true });
});

app.post("/api/heartbeat", (req, res) => {
  const { visitorId, page } = req.body;
  if (visitorId) {
    activeVisitors.set(visitorId, {
      ip: getIP(req), device: parseUA(req.headers["user-agent"]),
      page, lastSeen: Date.now(),
    });
  }
  res.json({ active: activeCount() });
});

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
    const ip = getIP(req);

    const body = {
      amount: cents,
      description: productName || description || "Chuteira Futsal Pro 5 Bump Kintsugi Unissex",
      reference: transactionId,
      source: "api_externa",
      customer: {
        name: payerName || customer?.name || "Cliente",
        email: customer?.email || "sem@email.com",
        document: doc, phone,
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

    const apiRes = await fetch(`${PARADISE_BASE}/transaction.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": PARADISE_KEY },
      body: JSON.stringify(body),
    });

    const data = await apiRes.json();

    if (data.status !== "success") {
      console.error("[Paradise] Erro:", JSON.stringify(data, null, 2));
      return res.status(400).json({ error: data.message || "Erro ao criar PIX na gateway" });
    }

    const orderInfo = {
      transactionId, paradiseId: data.transaction_id, cents,
      name: payerName || customer?.name || "",
      email: customer?.email || "", phone, document: doc,
      tracking: tracking || {}, ip,
      createdAt: new Date().toISOString().replace("T", " ").substring(0, 19),
      paidSent: false,
    };
    pixMap.set(transactionId, orderInfo);

    console.log(`[PIX] Criado | ref=${transactionId} R$${(cents / 100).toFixed(2)}`);
    sendUtmifyEvent(orderInfo, "waiting_payment");

    discord({
      title: "PIX Gerado — Aguardando pagamento",
      description: `**${orderInfo.name}** gerou um PIX de **R$ ${(cents / 100).toFixed(2)}**`,
      color: 0xEF4444,
      fields: [
        { name: "👤 Nome", value: orderInfo.name || "—", inline: true },
        { name: "💰 Valor", value: `R$ ${(cents / 100).toFixed(2)}`, inline: true },
        { name: "📧 Email", value: orderInfo.email || "—", inline: true },
        { name: "📱 Telefone", value: phone || "—", inline: true },
        { name: "📄 CPF", value: doc ? doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.***.***-$4") : "—", inline: true },
        { name: "🌐 IP", value: `\`${ip}\``, inline: true },
      ],
    });

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
      console.log(`[PIX] Pago! ref=${txId}`);
      sendUtmifyEvent(orderInfo, "paid");

      discord({
        title: "VENDA CONFIRMADA",
        description: `**${orderInfo.name}** pagou **R$ ${(orderInfo.cents / 100).toFixed(2)}**! Dinheiro na conta.`,
        color: 0x22C55E,
        thumbnail: { url: "https://em-content.zobj.net/source/apple/391/money-bag_1f4b0.png" },
        fields: [
          { name: "👤 Nome", value: orderInfo.name || "—", inline: true },
          { name: "💰 Valor", value: `R$ ${(orderInfo.cents / 100).toFixed(2)}`, inline: true },
          { name: "📧 Email", value: orderInfo.email || "—", inline: true },
          { name: "📱 Telefone", value: orderInfo.phone || "—", inline: true },
          { name: "🆔 Referência", value: `\`${txId}\``, inline: false },
        ],
      });
    }

    res.json({ status });
  } catch (err) {
    console.error("[Status] Exceção:", err);
    res.json({ status: "pending" });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✓ Servidor rodando em http://localhost:${PORT}`);
  console.log(`  ✓ Paradise: ${PARADISE_KEY ? "OK" : "⚠ NÃO CONFIGURADA"}`);
  console.log(`  ✓ Utmify: ${UTMIFY_API_TOKEN ? "OK" : "⚠"}`);
  console.log(`  ✓ Discord: ${DISCORD_WEBHOOK ? "OK" : "⚠"}\n`);
});
