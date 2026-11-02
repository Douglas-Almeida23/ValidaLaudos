
const crypto = require("crypto");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Método não permitido." });
  }

  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
  const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

  if (
    !MP_ACCESS_TOKEN ||
    !MP_WEBHOOK_SECRET ||
    !SUPABASE_URL ||
    !SUPABASE_SECRET_KEY
  ) {
    console.error("Configuração do webhook incompleta.");
    return res.status(500).json({ erro: "Configuração incompleta." });
  }

  // 1. Validar assinatura criptográfica da notificação.
  const signature = req.headers["x-signature"];
  const requestId = req.headers["x-request-id"];
  const dataId = req.query?.["data.id"];

  if (!signature || !requestId || !dataId) {
    return res.status(401).json({ erro: "Assinatura ausente." });
  }

  const parts = Object.fromEntries(
    String(signature)
      .split(",")
      .map(part => {
        const [key, ...value] = part.trim().split("=");
        return [key, value.join("=")];
      })
  );

  const ts = parts.ts;
  const receivedHash = parts.v1;

  if (
    !ts ||
    !receivedHash ||
    !/^[a-f0-9]{64}$/i.test(receivedHash)
  ) {
    return res.status(401).json({ erro: "Assinatura inválida." });
  }

  const manifest =
    `id:${String(dataId).toLowerCase()};` +
    `request-id:${requestId};` +
    `ts:${ts};`;

  const calculatedHash = crypto
    .createHmac("sha256", MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest("hex");

  const expected = Buffer.from(calculatedHash, "hex");
  const received = Buffer.from(receivedHash, "hex");

  if (
    expected.length !== received.length ||
    !crypto.timingSafeEqual(expected, received)
  ) {
    return res.status(401).json({ erro: "Origem não autenticada." });
  }

  try {
    const topic = req.body?.type || req.query?.type || req.query?.topic;
    const resourceId = String(dataId);

    // Função para consultar recursos oficiais do Mercado Pago.
    async function consultarMercadoPago(endpoint) {
      const response = await fetch(
        `https://api.mercadopago.com${endpoint}`,
        {
          headers: {
            Authorization: `Bearer ${MP_ACCESS_TOKEN}`
          }
        }
      );

      const data = await response.json();

      if (!response.ok) {
        console.error("Erro ao consultar Mercado Pago:", response.status);
        throw new Error("Falha na consulta do Mercado Pago.");
      }

      return data;
    }

    // 2. Localizar assinatura no Supabase.
    async function localizarAssinatura(preapprovalId) {
      const url =
        `${SUPABASE_URL}/rest/v1/assinaturas` +
        `?mercado_pago_preapproval_id=eq.${encodeURIComponent(preapprovalId)}` +
        "&select=id,usuario_id,plano,status&limit=1";

      const response = await fetch(url, {
        headers: {
          apikey: SUPABASE_SECRET_KEY
        }
      });

      const rows = await response.json();

      if (!response.ok) {
        throw new Error("Falha ao consultar assinatura no Supabase.");
      }

      return rows[0] || null;
    }

    // 3. Atualizar o registro da assinatura.
    async function atualizarAssinatura(assinatura, dados) {
      const url =
        `${SUPABASE_URL}/rest/v1/assinaturas` +
        `?id=eq.${encodeURIComponent(assinatura.id)}`;

      const response = await fetch(url, {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(dados)
      });

      const rows = await response.json();

      if (!response.ok || !rows.length) {
        throw new Error("Não foi possível atualizar a assinatura.");
      }

      return rows[0];
    }

    // 4. Evento de criação, autorização ou cancelamento.
    if (topic === "subscription_preapproval") {
      const preapproval = await consultarMercadoPago(
        `/preapproval/${encodeURIComponent(resourceId)}`
      );

      const assinatura = await localizarAssinatura(preapproval.id);

      if (!assinatura) {
        console.warn("Assinatura não encontrada para notificação.");
        return res.status(200).json({ recebido: true });
      }

      if (
        preapproval.external_reference &&
        String(preapproval.external_reference) !==
          String(assinatura.usuario_id)
      ) {
        return res.status(200).json({ recebido: true });
      }

      // Autorização da assinatura, sozinha, NÃO libera o PRO.
      if (preapproval.status === "cancelled") {
        await atualizarAssinatura(assinatura, {
          status: "cancelada"
        });
      }

      return res.status(200).json({ recebido: true });
    }

    // 5. Evento de cobrança recorrente.
    if (topic === "subscription_authorized_payment") {
      const fatura = await consultarMercadoPago(
        `/authorized_payments/${encodeURIComponent(resourceId)}`
      );

      if (!fatura.preapproval_id) {
        return res.status(200).json({ recebido: true });
      }

      const assinaturaMP = await consultarMercadoPago(
        `/preapproval/${encodeURIComponent(fatura.preapproval_id)}`
      );

      const assinatura = await localizarAssinatura(
        fatura.preapproval_id
      );

      if (!assinatura) {
        console.warn("Fatura sem assinatura correspondente.");
        return res.status(200).json({ recebido: true });
      }

      if (
        String(assinaturaMP.external_reference) !==
        String(assinatura.usuario_id)
      ) {
        console.error("Referência de usuário divergente.");
        return res.status(200).json({ recebido: true });
      }

      // Só libera quando a cobrança estiver realmente aprovada.
      const pagamentoAprovado =
        fatura.payment?.status === "approved";

      const valorCorreto =
        Number(fatura.transaction_amount) === 97;

      const moedaCorreta =
        fatura.currency_id === "BRL";

      const assinaturaAutorizada =
        assinaturaMP.status === "authorized";

      if (
        pagamentoAprovado &&
        valorCorreto &&
        moedaCorreta &&
        assinaturaAutorizada
      ) {
        await atualizarAssinatura(assinatura, {
          plano: "mensal",
          status: "ativa",
          pagamento_confirmado_em: new Date().toISOString()
        });

        console.log("Pagamento aprovado e assinatura atualizada.");
      }

      return res.status(200).json({ recebido: true });
    }

    // Eventos que não fazem parte da integração são ignorados.
    return res.status(200).json({ recebido: true });

  } catch (error) {
    console.error("Erro no webhook:", error.message);

    // Retornar erro permite que o Mercado Pago tente novamente.
    return res.status(500).json({ erro: "Falha no processamento." });
  }
};
