// src/logs.js
// Auditoria de eventos — registra tudo no banco via RPC

const EVENTOS = {
  LOGIN:             'login',
  LOGIN_FALHOU:      'login_falhou',
  LOGOUT:            'logout',
  ANALISE_FEITA:     'analise_feita',
  ANALISE_LIMITE:    'analise_limite_atingido',
  ALERTA_ENVIADO:    'alerta_enviado',
  ALERTA_FALHOU:     'alerta_falhou',
  PLANO_ATIVADO:     'plano_ativado',
  PLANO_EXPIRADO:    'plano_expirado',
  PAGAMENTO_RECEBIDO:'pagamento_recebido',
  WEBHOOK_DUPLICADO: 'webhook_duplicado',
  TELEGRAM_CONFIG:   'telegram_configurado',
  ERRO_IA:           'erro_ia',
  ERRO_PRECO:        'erro_preco',
  ADMIN_ACESSO:      'admin_acesso',
};

async function log(supabase, { perfil_id, evento, nivel = 'info', detalhe = null, ip = null }) {
  try {
    await supabase.rpc('registrar_evento', {
      p_perfil_id: perfil_id || null,
      p_evento: evento,
      p_nivel: nivel,
      p_detalhe: detalhe ? JSON.parse(JSON.stringify(detalhe)) : null,
      p_ip: ip || null
    });
  } catch (e) {
    // Log nunca deve quebrar a aplicação
    console.warn('Log falhou (não crítico):', e.message);
  }
}

// Helper para extrair IP real (Railway/proxy)
function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.connection?.remoteAddress
    || null;
}

module.exports = { log, EVENTOS, getIP };
