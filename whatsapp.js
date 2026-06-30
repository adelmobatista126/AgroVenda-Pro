// src/whatsapp.js v4.0
// Integração WhatsApp via Evolution API (self-hosted ou cloud)
// Produtor envia mensagem e recebe análise sem abrir o app

const fetch = require('node-fetch');

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || '';
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'agrovenda';

// Enviar mensagem WhatsApp
async function enviarWhatsApp(numero, mensagem) {
  if (!EVOLUTION_URL || !EVOLUTION_KEY) {
    console.warn('WhatsApp não configurado (EVOLUTION_API_URL/KEY ausentes)');
    return { ok: false, erro: 'WhatsApp não configurado' };
  }

  try {
    // Normalizar número (apenas dígitos)
    const tel = numero.replace(/\D/g, '');
    const numFmt = tel.startsWith('55') ? tel : `55${tel}`;

    const res = await fetch(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_KEY
      },
      body: JSON.stringify({
        number: numFmt,
        textMessage: { text: mensagem }
      }),
      timeout: 15000
    });

    const data = await res.json();
    return { ok: res.ok, data };
  } catch (e) {
    console.error('WhatsApp envio:', e.message);
    return { ok: false, erro: e.message };
  }
}

// Identificar intenção da mensagem do produtor
function identificarIntencao(texto) {
  const t = texto.toLowerCase().trim();

  // Preços
  if (/caf[eé]|soja|milho|boi|a[çc][uú]car|algod[aã]o|trigo/.test(t) && /pre[çc]o|cota[çc]/.test(t))
    return { tipo: 'preco', cultura: extrairCultura(t) };
  if (/pre[çc]o|cota[çc]|quanto|valor/.test(t))
    return { tipo: 'preco', cultura: extrairCultura(t) };

  // Score/análise
  if (/score|an[aá]lise|vendo|vender|hora|momento/.test(t))
    return { tipo: 'analise', cultura: extrairCultura(t) };

  // Câmbio
  if (/d[oó]lar|c[aâ]mbio|usd|brl/.test(t))
    return { tipo: 'cambio' };

  // Clima
  if (/clima|chuva|seca|temp/.test(t))
    return { tipo: 'clima' };

  // Ajuda
  if (/ajuda|help|oi|ol[aá]|menu|comandos/.test(t))
    return { tipo: 'ajuda' };

  return { tipo: 'desconhecido' };
}

function extrairCultura(texto) {
  if (/caf[eé]/.test(texto)) return 'cafe';
  if (/soja/.test(texto)) return 'soja';
  if (/milho/.test(texto)) return 'milho';
  if (/boi|gado/.test(texto)) return 'boi';
  if (/a[çc][uú]car/.test(texto)) return 'acucar';
  if (/algod[aã]o/.test(texto)) return 'algodao';
  if (/trigo/.test(texto)) return 'trigo';
  return null;
}

// Processar mensagem recebida
async function processarMensagem(supabase, webhook) {
  try {
    // Extrair dados do webhook Evolution API
    const numero = webhook?.data?.key?.remoteJid?.replace('@s.whatsapp.net', '') || '';
    const texto = webhook?.data?.message?.conversation
      || webhook?.data?.message?.extendedTextMessage?.text
      || '';

    if (!numero || !texto || texto.length < 2) return;

    // Buscar produtor pelo telefone
    const tel = numero.replace(/\D/g, '').replace(/^55/, '');
    const { data: perfil } = await supabase
      .from('perfis')
      .select('id, nome, plano, ativo, validade, culturas_interesse')
      .or(`telefone.eq.${tel},telefone.eq.55${tel}`)
      .single();

    if (!perfil) {
      await enviarWhatsApp(numero,
        `🌾 *AgroVenda Pro*\n\nOlá! Não encontrei sua conta vinculada a este número.\n\nCadastre seu WhatsApp no app: ${process.env.FRONTEND_URL || 'agrovenda.pro'}`
      );
      return;
    }

    if (!perfil.ativo) {
      await enviarWhatsApp(numero, '❌ Sua conta está suspensa. Entre em contato com o suporte.');
      return;
    }

    const intencao = identificarIntencao(texto);
    let resposta = '';

    const { buscarTodosPrecos } = require('./precos');
    const { calcularScore, CLASSIFICACAO } = require('./score');
    const precos = await buscarTodosPrecos(supabase);

    switch (intencao.tipo) {
      case 'preco': {
        const culturas = intencao.cultura
          ? [intencao.cultura]
          : (perfil.culturas_interesse || ['cafe','soja','milho','boi']).slice(0,4);

        const linhas = culturas.map(c => {
          const p = precos.precos[c];
          const nomes = {cafe:'Café ☕',soja:'Soja 🌱',milho:'Milho 🌽',boi:'Boi 🐂',acucar:'Açúcar 🍬',algodao:'Algodão 🌸',trigo:'Trigo 🌾'};
          return p?.brl ? `${nomes[c]}: *R$ ${p.brl.toLocaleString('pt-BR')}*` : null;
        }).filter(Boolean).join('\n');

        resposta = `📊 *Cotações agora*\n\n${linhas}\n\n💵 Dólar: *R$ ${precos.dolar?.toFixed(2) || 'N/D'}*\n\n_Fonte: CEPEA/ESALQ + BCB_`;
        break;
      }

      case 'analise': {
        const cultura = intencao.cultura || (perfil.culturas_interesse?.[0] || 'soja');
        const p = precos.precos[cultura];
        if (!p?.brl) { resposta = `❌ Preço de ${cultura} indisponível agora. Tente em alguns minutos.`; break; }

        const score = calcularScore({
          cultura, precoAtual: p.brl, precoMedia60d: p.media60d,
          preco7dAtras: p.preco7dAtras, dolar: precos.dolar,
          dolarMedia30d: precos.dolarMedia30d, estoqueStatus: 'neutro',
          volatilidadeAlta: false
        });

        const nomesCultura = {cafe:'Café',soja:'Soja',milho:'Milho',boi:'Boi Gordo',acucar:'Açúcar',algodao:'Algodão',trigo:'Trigo'};
        resposta =
          `🎯 *Score AgroVenda — ${nomesCultura[cultura]}*\n\n` +
          `${score.emoji} *${score.score}/100 — ${score.acao}*\n\n` +
          `💰 Preço: R$ ${p.brl.toLocaleString('pt-BR')}\n` +
          `💵 Dólar: R$ ${precos.dolar?.toFixed(2)}\n\n` +
          Object.values(score.itens).slice(0,4).map(v =>
            `${v.status==='positivo'?'✅':v.status==='negativo'?'❌':'➖'} ${v.desc}`
          ).join('\n') +
          `\n\n_AgroVenda Pro • CEPEA/ESALQ_`;
        break;
      }

      case 'cambio':
        resposta = `💵 *Dólar hoje*\n\nR$ ${precos.dolar?.toFixed(4) || 'N/D'} (PTAX Banco Central)\n\n_Atualizado: ${new Date().toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo'})}_`;
        break;

      case 'ajuda':
      default:
        resposta =
          `🌾 *AgroVenda Pro*\n\nOlá, ${perfil.nome.split(' ')[0]}!\n\n` +
          `*Comandos disponíveis:*\n` +
          `📊 "preço do café" — cotação atual\n` +
          `🎯 "analisar soja" — score de venda\n` +
          `💵 "dólar" — câmbio atual\n` +
          `📋 "preços" — todas as culturas\n\n` +
          `_Plano: ${perfil.plano}_`;
    }

    if (resposta) {
      await enviarWhatsApp(numero, resposta);
      // Salvar no histórico de chat
      await supabase.from('chat_ia').insert({
        perfil_id: perfil.id,
        canal: 'whatsapp',
        pergunta: texto.substring(0, 500),
        resposta: resposta.substring(0, 2000),
        dados_utilizados: { intencao, dolar: precos.dolar }
      }).catch(() => {});
    }
  } catch (e) {
    console.error('processarMensagem WhatsApp:', e.message);
  }
}

module.exports = { enviarWhatsApp, processarMensagem, identificarIntencao };
