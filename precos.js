// src/precos.js v3.1
// Fontes: CEPEA/ESALQ (preço ao produtor) + BCB (dólar PTAX)
// Cache em memória — busca real a cada 15-30min

const fetch = require('node-fetch');

const CACHE = {};
const TTL = { cepea: 30 * 60 * 1000, bcb: 15 * 60 * 1000 };
const cacheOk = (k, ttl) => CACHE[k] && (Date.now() - CACHE[k].ts) < ttl;

// ─── DÓLAR — BCB PTAX oficial ────────────────────────────────
async function buscarDolar() {
  if (cacheOk('dolar', TTL.bcb)) return CACHE['dolar'].valor;

  for (let d = 1; d <= 5; d++) {
    try {
      const dt = new Date(); dt.setDate(dt.getDate() - d);
      const mm = String(dt.getMonth()+1).padStart(2,'0');
      const dd = String(dt.getDate()).padStart(2,'0');
      const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@d)?@d='${mm}-${dd}-${dt.getFullYear()}'&$format=json&$select=cotacaoCompra,cotacaoVenda`;
      const res = await fetch(url, { timeout: 8000 });
      const data = await res.json();
      if (data?.value?.length > 0) {
        const c = data.value[data.value.length - 1];
        const valor = parseFloat(((c.cotacaoCompra + c.cotacaoVenda) / 2).toFixed(4));
        CACHE['dolar'] = { valor, ts: Date.now() };
        return valor;
      }
    } catch (e) { /* tenta dia anterior */ }
  }

  // Fallback Yahoo
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/USDBRL=X?interval=1d&range=3d',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    const data = await res.json();
    const v = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (v) { CACHE['dolar'] = { valor: parseFloat(v.toFixed(4)), ts: Date.now() }; return parseFloat(v.toFixed(4)); }
  } catch (e) {}
  return null;
}

// ─── CEPEA widget ────────────────────────────────────────────
// IDs do widget oficial CEPEA/ESALQ — preço ao produtor brasileiro
const CEPEA = {
  cafe:    { id: 28,  nome: 'Café Arábica ESALQ/SP',   unidade: 'saca 60kg' },
  soja:    { id: 50,  nome: 'Soja ESALQ/Paraná',       unidade: 'saca 60kg' },
  milho:   { id: 48,  nome: 'Milho ESALQ/Campinas',    unidade: 'saca 60kg' },
  boi:     { id: 25,  nome: 'Boi Gordo ESALQ/SP',      unidade: '@ 15kg'   },
  acucar:  { id: 100, nome: 'Açúcar Cristal ESALQ',    unidade: 'saca 50kg' },
  algodao: { id: 91,  nome: 'Algodão ESALQ/SP',        unidade: 'arroba'   },
  trigo:   { id: 102, nome: 'Trigo ESALQ/PR',          unidade: 'saca 60kg' },
};

const YAHOO = {
  cafe:    { t: 'KC=F', f: (p,d) => Math.round(p*1.32276*d) },
  soja:    { t: 'ZS=F', f: (p,d) => Math.round(p*0.2205*d)  },
  milho:   { t: 'ZC=F', f: (p,d) => Math.round(p*0.2362*d)  },
  boi:     { t: 'LE=F', f: (p,d) => Math.round(p*0.45359*d) },
  acucar:  { t: 'SB=F', f: (p,d) => Math.round(p*0.50*d)    },
  algodao: { t: 'CT=F', f: (p,d) => Math.round(p*0.15*d)    },
  trigo:   { t: 'ZW=F', f: (p,d) => Math.round(p*0.2205*d)  },
};

async function buscarCEPEA(cultura) {
  if (cacheOk('cepea_'+cultura, TTL.cepea)) return CACHE['cepea_'+cultura];

  const cfg = CEPEA[cultura];
  if (!cfg) return null;

  try {
    const res = await fetch(`https://www.cepea.org.br/br/widget/public/${cfg.id}.json`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.cepea.org.br' },
      timeout: 10000
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data?.data?.[0]) {
      const brl = parseFloat((data.data[0].preco || '0').toString().replace(',', '.'));
      if (brl > 0) {
        const result = { brl, fonte: 'CEPEA/ESALQ', ...cfg };
        CACHE['cepea_'+cultura] = { ...result, ts: Date.now() };
        return result;
      }
    }
  } catch (e) { console.warn(`CEPEA ${cultura}:`, e.message); }

  // Fallback Yahoo Finance
  const ycfg = YAHOO[cultura];
  if (!ycfg) return null;
  try {
    const dolar = await buscarDolar();
    if (!dolar) return null;
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ycfg.t}?interval=1d&range=3d`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
    const data = await res.json();
    const usd = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (usd) {
      const brl = ycfg.f(usd, dolar);
      const result = { brl, fonte: 'Yahoo Finance (estimativa)', ...(CEPEA[cultura] || { nome: cultura, unidade: 'unidade' }) };
      CACHE['cepea_'+cultura] = { ...result, ts: Date.now() };
      return result;
    }
  } catch (e) { console.warn(`Yahoo ${cultura}:`, e.message); }
  return null;
}

// ─── Histórico para score ─────────────────────────────────────
async function buscarHistorico(cultura, supabase) {
  try {
    const { data } = await supabase
      .from('historico_precos')
      .select('preco_brl, coletado_em')
      .eq('cultura', cultura)
      .order('coletado_em', { ascending: false })
      .limit(120);

    if (!data?.length) return {};
    const precos = data.map(r => r.preco_brl).filter(Boolean);
    return {
      media60d: Math.round(precos.reduce((a,b)=>a+b,0) / precos.length),
      preco7dAtras: data[Math.min(13, data.length-1)]?.preco_brl || null
    };
  } catch (e) { return {}; }
}

// ─── Função principal ─────────────────────────────────────────
async function buscarTodosPrecos(supabase) {
  const dolar = await buscarDolar();
  const culturas = Object.keys(CEPEA);

  const precos = {};
  await Promise.all(culturas.map(async c => {
    const p = await buscarCEPEA(c);
    const hist = supabase ? await buscarHistorico(c, supabase) : {};
    precos[c] = { ...p, ...hist, disponivel: p?.brl != null };
  }));

  // Salvar snapshot no histórico
  if (supabase) {
    const rows = Object.entries(precos)
      .filter(([,v]) => v.brl)
      .map(([cultura, v]) => ({ cultura, preco_brl: v.brl, dolar, fonte: v.fonte }));
    if (rows.length) await supabase.from('historico_precos').insert(rows).catch(()=>{});
  }

  // FIX 10: calcular média do dólar dos últimos 30 dias (score de câmbio funcional)
  let dolarMedia30d = null;
  if (supabase) {
    try {
      const { data: histDolar } = await supabase
        .from('historico_precos')
        .select('dolar')
        .not('dolar', 'is', null)
        .order('coletado_em', { ascending: false })
        .limit(60); // ~2 registros/dia x 30 dias
      if (histDolar?.length >= 5) {
        dolarMedia30d = parseFloat(
          (histDolar.reduce((s, r) => s + r.dolar, 0) / histDolar.length).toFixed(4)
        );
      }
    } catch (e) { console.warn('dolarMedia30d:', e.message); }
  }

  return { timestamp: new Date().toISOString(), dolar, dolarMedia30d, precos };
}

module.exports = { buscarTodosPrecos, buscarDolar };
