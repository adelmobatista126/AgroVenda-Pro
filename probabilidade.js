// src/probabilidade.js v5.0
// Modelo estatístico de probabilidade de movimento de preço
// Usa: volatilidade histórica, tendência, sazonalidade, estoques, câmbio

const { SAZONALIDADE } = require('./score');

// Parâmetros por cultura (baseado em dados históricos CEPEA)
const PARAMETROS = {
  cafe:    { volatilidade_anual: 0.28, ciclo_bienal: true,  sensib_cambio: 0.85, sensib_clima: 0.70 },
  soja:    { volatilidade_anual: 0.22, ciclo_bienal: false, sensib_cambio: 0.90, sensib_clima: 0.60 },
  milho:   { volatilidade_anual: 0.25, ciclo_bienal: false, sensib_cambio: 0.75, sensib_clima: 0.65 },
  boi:     { volatilidade_anual: 0.18, ciclo_bienal: false, sensib_cambio: 0.50, sensib_clima: 0.40 },
  acucar:  { volatilidade_anual: 0.30, ciclo_bienal: false, sensib_cambio: 0.80, sensib_clima: 0.55 },
  algodao: { volatilidade_anual: 0.24, ciclo_bienal: false, sensib_cambio: 0.85, sensib_clima: 0.60 },
  trigo:   { volatilidade_anual: 0.26, ciclo_bienal: false, sensib_cambio: 0.70, sensib_clima: 0.65 },
};

// Calcular volatilidade realizada dos últimos N dias
function calcularVolatilidadeHistorica(precos) {
  if (!precos || precos.length < 5) return null;
  const retornos = [];
  for (let i = 1; i < precos.length; i++) {
    if (precos[i-1] > 0) retornos.push(Math.log(precos[i] / precos[i-1]));
  }
  if (retornos.length < 3) return null;
  const media = retornos.reduce((s,r) => s+r, 0) / retornos.length;
  const variancia = retornos.reduce((s,r) => s + Math.pow(r - media, 2), 0) / retornos.length;
  return Math.sqrt(variancia * 252); // anualizada
}

// Modelo principal de probabilidade
function calcularProbabilidade(params) {
  const {
    cultura, precoAtual, precoMedia60d, preco7dAtras, preco30dAtras,
    dolar, dolarMedia30d, estoqueStatus, climaImpacto,
    historicoPrecos = [],   // array de preços dos últimos 60 dias
    horizonte = 15           // dias à frente
  } = params;

  const cfg = PARAMETROS[cultura] || PARAMETROS.soja;
  const mes = new Date().getMonth();
  const sazon = (SAZONALIDADE[cultura] || SAZONALIDADE.soja)[mes];
  const sazonProximo = (SAZONALIDADE[cultura] || SAZONALIDADE.soja)[(mes + Math.floor(horizonte/30)) % 12];

  // ── Fator 1: Tendência recente (peso 30%) ──────────────────
  let fatorTendencia = 0.5; // neutro
  if (precoAtual && preco7dAtras) {
    const tend7d = (precoAtual - preco7dAtras) / preco7dAtras;
    fatorTendencia = tend7d > 0.03 ? 0.65 : tend7d > 0 ? 0.57 : tend7d > -0.03 ? 0.43 : 0.30;
  }

  // ── Fator 2: Posição vs média histórica (peso 25%) ─────────
  let fatorMedia = 0.5;
  if (precoAtual && precoMedia60d) {
    const posMedia = (precoAtual - precoMedia60d) / precoMedia60d;
    // Acima da média → mean reversion → prob de cair
    fatorMedia = posMedia > 0.15 ? 0.30 : posMedia > 0.05 ? 0.42 :
                 posMedia > -0.05 ? 0.50 : posMedia > -0.15 ? 0.60 : 0.70;
  }

  // ── Fator 3: Câmbio (peso 20%) ─────────────────────────────
  let fatorCambio = 0.5;
  if (dolar && dolarMedia30d && cfg.sensib_cambio > 0) {
    const varCambio = (dolar - dolarMedia30d) / dolarMedia30d;
    // Dólar subindo → commodity em BRL sobe
    fatorCambio = varCambio > 0.03 ? 0.65 : varCambio > 0 ? 0.55 :
                  varCambio > -0.03 ? 0.45 : 0.35;
    fatorCambio = 0.5 + (fatorCambio - 0.5) * cfg.sensib_cambio;
  }

  // ── Fator 4: Sazonalidade do horizonte (peso 15%) ──────────
  const fatorSazon = 0.3 + sazonProximo * 0.4; // 0.30 a 0.70

  // ── Fator 5: Estoques e clima (peso 10%) ───────────────────
  let fatorFundamental = 0.5;
  if (estoqueStatus === 'apertado') fatorFundamental += 0.12;
  if (estoqueStatus === 'folgado')  fatorFundamental -= 0.12;
  if (climaImpacto === 'positivo')  fatorFundamental += 0.08 * cfg.sensib_clima;
  if (climaImpacto === 'negativo')  fatorFundamental -= 0.08 * cfg.sensib_clima;
  fatorFundamental = Math.min(0.80, Math.max(0.20, fatorFundamental));

  // ── Composição ponderada ───────────────────────────────────
  const pesos = { tendencia:0.30, media:0.25, cambio:0.20, sazon:0.15, fundamental:0.10 };
  const probAlta =
    fatorTendencia * pesos.tendencia +
    fatorMedia * pesos.media +
    fatorCambio * pesos.cambio +
    fatorSazon * pesos.sazon +
    fatorFundamental * pesos.fundamental;

  // Ajuste por horizonte: incerteza cresce com o tempo
  const ajusteHorizonte = 1 - (horizonte / 365) * 0.3;
  const probAltaAjustada = 0.5 + (probAlta - 0.5) * ajusteHorizonte;

  const probAltaFinal = Math.min(0.88, Math.max(0.12, probAltaAjustada));
  const probQuedaFinal = 1 - probAltaFinal;

  // Volatilidade realizada
  const volHist = calcularVolatilidadeHistorica(historicoPrecos);
  const vol = volHist || cfg.volatilidade_anual;

  // Intervalo de confiança do preço (±1 desvio padrão para horizonte)
  const volHorizonte = vol * Math.sqrt(horizonte / 252);
  const precoBase = precoAtual || precoMedia60d || 100;
  const intervalo = {
    pessimista: Math.round(precoBase * (1 - volHorizonte * 1.5)),
    base:       Math.round(precoBase * (1 + (probAltaFinal - 0.5) * volHorizonte * 2)),
    otimista:   Math.round(precoBase * (1 + volHorizonte * 1.5))
  };

  // Confiança: baseada na quantidade de dados
  const dadosDisp = [precoAtual,precoMedia60d,preco7dAtras,dolar,climaImpacto].filter(Boolean).length;
  const confianca = Math.round(40 + (dadosDisp/5)*40 + (historicoPrecos.length>20?20:historicoPrecos.length));

  return {
    horizonte,
    prob_alta: Math.round(probAltaFinal * 100),
    prob_queda: Math.round(probQuedaFinal * 100),
    prob_lateral: Math.max(0, 100 - Math.round(probAltaFinal*100) - Math.round(probQuedaFinal*100)),
    intervalo,
    confianca: Math.min(95, confianca),
    volatilidade_anual_pct: Math.round(vol * 100),
    fatores: {
      tendencia: Math.round(fatorTendencia * 100),
      media_historica: Math.round(fatorMedia * 100),
      cambio: Math.round(fatorCambio * 100),
      sazonalidade: Math.round(fatorSazon * 100),
      fundamental: Math.round(fatorFundamental * 100)
    },
    interpretacao: probAltaFinal > 0.65
      ? `Probabilidade de alta em ${horizonte} dias: ${Math.round(probAltaFinal*100)}% — condições favoráveis`
      : probAltaFinal < 0.40
      ? `Risco de queda em ${horizonte} dias: ${Math.round(probQuedaFinal*100)}% — cautela recomendada`
      : `Mercado indefinido — aguardar sinal mais claro`
  };
}

// Calcular todos os horizontes de uma vez
function calcularTodosHorizontes(params) {
  return {
    horizonte_7d:  calcularProbabilidade({ ...params, horizonte: 7 }),
    horizonte_15d: calcularProbabilidade({ ...params, horizonte: 15 }),
    horizonte_30d: calcularProbabilidade({ ...params, horizonte: 30 }),
    horizonte_90d: calcularProbabilidade({ ...params, horizonte: 90 }),
  };
}


// Consultar serviço ML Python (se disponível) ou usar modelo estatístico
async function calcularProbabilidadeComML(params) {
  const ML_URL = process.env.ML_API_URL;
  const ML_SECRET = process.env.ML_API_SECRET;

  // Se ML_API_URL não configurado, usar modelo estatístico
  if (!ML_URL) {
    return calcularTodosHorizontes(params);
  }

  try {
    const fetch = require('node-fetch');
    const res = await fetch(`${ML_URL}/predict/todos?horizonte=15`, {
      headers: { 'x-ml-secret': ML_SECRET || '' },
      timeout: 8000
    });

    if (!res.ok) throw new Error(`ML API HTTP ${res.status}`);
    const data = await res.json();

    if (!data.ok || !data.resultados?.[params.cultura]) {
      throw new Error('Resultado ML inválido');
    }

    const r = data.resultados[params.cultura];
    if (r.erro || r.modelo === 'none') throw new Error(r.erro || 'ML indisponível');

    // Resultado do LightGBM — completar horizontes faltantes com estatístico
    const estatistico = calcularTodosHorizontes(params);
    return {
      horizonte_7d:  estatistico.horizonte_7d,    // ML não retorna 7d ainda
      horizonte_15d: {
        horizonte: 15,
        prob_alta:  r.prob_alta,
        prob_queda: r.prob_queda,
        prob_lateral: Math.max(0, 100 - r.prob_alta - r.prob_queda),
        confianca:  r.confianca,
        interpretacao: r.prob_alta > 65
          ? `Probabilidade de alta em 15 dias: ${r.prob_alta}% — condições favoráveis (LightGBM)`
          : r.prob_queda > 55
          ? `Risco de queda em 15 dias: ${r.prob_queda}% — cautela recomendada (LightGBM)`
          : 'Mercado indefinido — aguardar sinal mais claro (LightGBM)',
        modelo: r.modelo   // 'lightgbm' ou 'estatistico'
      },
      horizonte_30d: estatistico.horizonte_30d,
      horizonte_90d: estatistico.horizonte_90d,
    };
  } catch(e) {
    // Fallback silencioso para modelo estatístico
    console.warn('ML Service indisponível, usando modelo estatístico:', e.message);
    const resultado = calcularTodosHorizontes(params);
    // Marcar como estatístico para transparência
    resultado.horizonte_15d.modelo = 'estatistico_fallback';
    return resultado;
  }
}

module.exports = {
  calcularProbabilidade, calcularTodosHorizontes,
  calcularProbabilidadeComML,
  calcularVolatilidadeHistorica
};

