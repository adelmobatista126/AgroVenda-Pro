// src/auth.js
// Usa auth.users nativo do Supabase — sem guardar senha própria
// O Supabase cuida de bcrypt, recuperação de senha e confirmação de e-mail

const { createClient } = require('@supabase/supabase-js');

// Cliente com chave pública (anon) — usado para autenticar usuários
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Middleware: valida Bearer token emitido pelo Supabase Auth
async function autenticar(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ erro: 'Token não informado. Faça login.' });
  }

  // Verificar token com o Supabase (revogação em tempo real)
  const { data: { user }, error } = await supabaseAuth.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ erro: 'Token inválido ou expirado. Faça login novamente.' });
  }

  // Buscar perfil + plano no banco (service role — ignora RLS)
  const supabase = req.app.locals.supabase;
  const { data: perfil, error: errPerfil } = await supabase
    .from('perfis')
    .select(`
      id, nome, plano, ativo, validade, cargo,
      telegram_chat_id, culturas_interesse
    `)
    .eq('id', user.id)
    .single();

  if (errPerfil || !perfil) {
    return res.status(401).json({ erro: 'Perfil não encontrado.' });
  }

  if (!perfil.ativo) {
    return res.status(403).json({ erro: 'Conta suspensa. Entre em contato.' });
  }

  const hoje = new Date().toISOString().split('T')[0];
  if (perfil.validade < hoje) {
    return res.status(403).json({ erro: 'Assinatura vencida. Renove seu plano.' });
  }

  // Verificar limite de análises do plano (rate limit por dia)
  const { data: limite } = await supabase
    .from('planos_config')
    .select('analises_dia, alertas_ativos, culturas')
    .eq('plano', perfil.plano)
    .single();

  req.user = user;
  req.perfil = perfil;
  req.limite = limite || { analises_dia: 3, alertas_ativos: 1, culturas: 2 };

  // FIX audit: verificar consentimentos pendentes em rotas protegidas
  const rotasLivres = ['/auth/login','/auth/renovar','/legal','/consentimento','/'];
  const ehLivre = rotasLivres.some(r => (req.path||'').startsWith(r));
  if (!ehLivre) {
    try {
      const sbCheck = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { data: cs } = await sbCheck.rpc('verificar_consentimento', { p_user_id: user.id });
      if (cs && !cs.completo) {
        return res.status(403).json({
          erro:'Consentimento pendente', codigo:'CONSENT_REQUIRED',
          pendentes: cs.pendentes,
          mensagem:'Aceite os termos em POST /consentimento/todos para continuar.'
        });
      }
    } catch(e) { /* não bloquear por erro na verificação de consent */ }
  }

  next();
}

// FIX 7: verificar E consumir atomicamente (previne race condition)
// Substitui verificarLimiteIA (check) + registrarUsoIA (increment) por operação única
async function consumirAnalise(perfil_id, limite_dia, supabase) {
  const { data, error } = await supabase.rpc('consumir_analise', {
    p_perfil_id: perfil_id,
    p_limite: limite_dia
  });
  if (error) {
    console.warn('consumirAnalise RPC:', error.message);
    // Fallback seguro: negar em caso de erro (evita abuso)
    return { permitido: false, usadas: 0, limite: limite_dia, restantes: 0 };
  }
  return data; // { permitido, usadas, limite, restantes }
}

// Manter verificarLimiteIA como alias para compatibilidade
async function verificarLimiteIA(perfil_id, limite_dia, supabase) {
  return consumirAnalise(perfil_id, limite_dia, supabase);
}

// Registrar uso de IA (tokens + custo estimado)
async function registrarUsoIA(perfil_id, tokens_entrada, tokens_saida, supabase) {
  // Claude Sonnet: $3/M tokens entrada, $15/M tokens saída (USD)
  const custo = (tokens_entrada * 0.000003) + (tokens_saida * 0.000015);
  const hoje = new Date().toISOString().split('T')[0];

  // FIX 4: apenas o RPC — o upsert direto foi removido (causava double-write)
  const { error } = await supabase.rpc('incrementar_uso_ia', {
    p_perfil_id: perfil_id,
    p_data: hoje,
    p_analises: 1,
    p_tokens_entrada: tokens_entrada,
    p_tokens_saida: tokens_saida,
    p_custo: custo
  });
  if (error) console.warn('registrarUsoIA:', error.message);
}

// FIX 1: buscar token pontualmente — nunca fica no req.perfil
async function getBotToken(supabase, perfil_id) {
  const { data } = await supabase
    .from('perfis')
    .select('telegram_bot_token, telegram_chat_id')
    .eq('id', perfil_id)
    .single();
  return data || {};
}

module.exports = { autenticar, verificarLimiteIA, consumirAnalise, registrarUsoIA, supabaseAuth, getBotToken };
