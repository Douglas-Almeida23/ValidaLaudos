const crypto = require("crypto");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Método não permitido." });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
  const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

  if (
    !SUPABASE_URL ||
    !SUPABASE_PUBLISHABLE_KEY ||
    !SUPABASE_SECRET_KEY ||
    !MP_ACCESS_TOKEN
  ) {
    return res.status(500).json({
      erro: "Configuração do servidor incompleta."
    });
  }

  const authorization = req.headers.authorization || "";
  const accessToken = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!accessToken) {
    return res.status(401).json({
      erro: "Faça login para continuar."
    });
  }

  try {
    // 1. Confirma a identidade do usuário no Supabase.
    const authResponse = await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const user = await authResponse.json();

    if (!authResponse.ok || !user.id || !user.email) {
      return res.status(401).json({
        erro: "Sessão inválida. Entre novamente na sua conta."
      });
    }

    // 2. Busca a assinatura pertencente a esse usuário.
    const consultaResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/assinaturas` +
      `?usuario_id=eq.${encodeURIComponent(user.id)}` +
      "&select=id,plano,status,mercado_pago_preapproval_id&limit=1",
      {
        headers: {
          apikey: SUPABASE_SECRET_KEY
        }
      }
    );

    const assinaturas = await consultaResponse.json();

    if (!consultaResponse.ok) {
      console.error("Erro ao consultar assinatura:", assinaturas);
      return res.status(500).json({
        erro: "Não foi possível consultar sua assinatura."
      });
    }

    if (!assinaturas.length) {
      return res.status(404).json({
        erro: "Assinatura não encontrada no banco de dados."
      });
    }

    const assinatura = assinaturas[0];

    if (
      assinatura.status === "ativa" &&
      ["mensal", "anual"].includes(assinatura.plano)
    ) {
      return res.status(409).json({
        erro: "Sua assinatura já está ativa."
      });
    }

    if (assinatura.mercado_pago_preapproval_id) {
      return res.status(409).json({
        erro: "Já existe uma assinatura em processamento para sua conta."
      });
    }

    // 3. Cria a assinatura recorrente no Mercado Pago.
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "https://validalaudos-git-desenvolvimento-seguro-valida-laudos.vercel.app";

    const mpResponse = await fetch(
      "https://api.mercadopago.com/preapproval",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
          "X-Idempotency-Key": crypto.randomUUID()
        },
        body: JSON.stringify({
          reason: "Valida Laudos Pro - Plano mensal",
          external_reference: user.id,
          payer_email: user.email,
          auto_recurring: {
            frequency: 1,
            frequency_type: "months",
            transaction_amount: 97,
            currency_id: "BRL"
          },
          back_url: `${baseUrl}/?assinatura=retorno`
        })
      }
    );

    const mpData = await mpResponse.json();

    if (!mpResponse.ok || !mpData.id || !mpData.init_point) {
      console.error(
        "Erro do Mercado Pago:",
        mpResponse.status,
        mpData
      );

      return res.status(502).json({
        erro: "O Mercado Pago não conseguiu criar a assinatura.",
        detalhe: mpData.message || mpData.error || "Erro na integração."
      });
    }

    // 4. Guarda o identificador no registro do próprio usuário.
    const salvarResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/assinaturas` +
      `?id=eq.${encodeURIComponent(assinatura.id)}` +
      "&mercado_pago_preapproval_id=is.null",
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          mercado_pago_preapproval_id: String(mpData.id)
        })
      }
    );

    const salvaDados = await salvarResponse.json();

    if (!salvarResponse.ok || !salvaDados.length) {
      console.error("Erro ao salvar identificador:", salvaDados);

      return res.status(500).json({
        erro: "A assinatura foi criada, mas não conseguimos registrá-la no banco. Entre em contato com o suporte."
      });
    }

    // 5. Entrega ao navegador o endereço oficial do checkout.
    return res.status(200).json({
      sucesso: true,
      checkout_url: mpData.init_point
    });

  } catch (error) {
    console.error("Erro ao criar assinatura:", error);

    return res.status(500).json({
      erro: "Erro interno ao iniciar a assinatura."
    });
  }
};
