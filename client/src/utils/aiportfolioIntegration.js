export const buildTradingAppStrategyEquityUrl = ({
  baseUrl,
  userId,
  strategyId,
  limit = 400,
}) => {
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  const uid = encodeURIComponent(String(userId || "").trim());
  const sid = encodeURIComponent(String(strategyId || "").trim());
  if (!origin || !uid || !sid) {
    return "";
  }
  const url = `${origin}/api/strategies/equity/${uid}/${sid}`;
  if (Number.isFinite(Number(limit)) && Number(limit) > 0) {
    return `${url}?limit=${Math.floor(Number(limit))}`;
  }
  return url;
};

export const suggestAiPortfolioSymbol = (portfolio) => {
  const id = String(portfolio?.strategy_id || portfolio?.id || "").trim();
  if (id) {
    const compact = id.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    if (compact) {
      return `STRAT_${compact.slice(0, 8)}`;
    }
  }

  const name = String(portfolio?.name || "").trim();
  if (!name) {
    return "STRATEGY";
  }
  const normalized = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized ? normalized.slice(0, 16) : "STRATEGY";
};

export const buildAiPortfolioIntegrationLink = ({
  symbol,
  displayName,
  apiUrl,
  apiToken,
  quantity,
  costPrice,
  tags,
}) => {
  const params = new URLSearchParams();
  if (symbol) params.set("symbol", String(symbol));
  if (displayName) params.set("display_name", String(displayName));
  if (apiUrl) params.set("api_url", String(apiUrl));
  if (apiToken) params.set("api_token", String(apiToken));
  if (quantity !== undefined && quantity !== null) params.set("quantity", String(quantity));
  if (costPrice !== undefined && costPrice !== null) params.set("cost_price", String(costPrice));
  if (Array.isArray(tags) && tags.length) params.set("tags", tags.join(","));
  return `aiportfolio://api-position?${params.toString()}`;
};

export const copyTextToClipboard = async (text) => {
  const value = String(text || "");
  if (!value) {
    return false;
  }

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // fall back to execCommand
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return Boolean(ok);
  } catch {
    return false;
  }
};

