const OpenAI = require('openai');
const {
  parseComposerScript,
  collectTickersFromAst,
  buildEvaluationBlueprint,
} = require('./composerDslParser');

let cachedClient = null;

const getClient = () => {
  if (cachedClient) {
    return cachedClient;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
};

const extractJson = (text) => {
  if (!text) {
    return null;
  }
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch (error) {
    return null;
  }
};

const runComposerStrategy = async ({ strategyText, budget = 1000 }) => {
  const client = getClient();
  const cleanedScript = String(strategyText || '').trim();
  if (!cleanedScript) {
    throw new Error('Strategy text is required');
  }

  const numericBudget = Number.isFinite(Number(budget)) && Number(budget) > 0 ? Number(budget) : 1000;

  let parsedAst = null;
  let parsedJson = null;
  let blueprintSteps = [];
  let detectedTickers = [];

  try {
    parsedAst = parseComposerScript(cleanedScript);
    if (parsedAst) {
      parsedJson = JSON.stringify(parsedAst, null, 2);
      const tickerSet = collectTickersFromAst(parsedAst);
      if (tickerSet && typeof tickerSet.size === 'number') {
        detectedTickers = Array.from(tickerSet);
      }
      blueprintSteps = buildEvaluationBlueprint(parsedAst) || [];
    }
  } catch (error) {
    console.warn('[ComposerParser] Failed to parse strategy text:', error.message);
  }

  const blueprintText = blueprintSteps.length
    ? blueprintSteps.map((step, idx) => `${idx + 1}. ${step}`).join('\n')
    : 'Parsing assistance unavailable; follow the raw script carefully.';

  const parsedSection = parsedJson
    ? `Parsed structure (JSON):\n${parsedJson}\n`
    : 'Parsed structure: unavailable (fall back to interpreting the raw script).\n';

  const tickerSection = detectedTickers.length
    ? `Tickers referenced: ${detectedTickers.join(', ')}\n`
    : 'Tickers referenced: none detected explicitly (confirm during parsing).\n';

  const prompt = `You are provided with a Composer defsymphony strategy script. Interpret the strategy and evaluate it programmatically using Python inside the code interpreter container.

Strategy script:
${cleanedScript}

${parsedSection}
Evaluation blueprint:
${blueprintText}

${tickerSection}

Requirements for Python execution:
1. Parse the defsymphony DSL precisely. Recognize constructs such as weight-equal, group, filter, moving-average-return, stdev-return, select-top, asset, etc. The script follows Composer's semantics: filters are applied sequentially; select-top chooses the highest metric values; weight-equal assigns equal weights to remaining instruments or nested blocks.
2. Download historical price data for every referenced ticker using yfinance. Use daily data with at least 250 trading days (about 1 year) to ensure the windows (10, 63, 100 days) can be computed without NaN values.
3. Compute the metrics requested in the script exactly as described. Apply filters in the specified order to determine the surviving tickers at each stage. When multiple filters run sequentially, keep only the tickers that pass all prior filters.
4. Produce a final allocation with weights that sum to 1. When the script uses weight-equal, divide weight equally among the surviving tickers for that block. If any ticker lacks valid pricing data, drop it and re-normalize weights across remaining tickers.
5. Given a total capital of ${numericBudget} USD, compute share quantities for each selected ticker using the latest close price (use the greatest integer less than or equal to the affordable quantity). Exclude tickers priced at 0 or with missing data, and re-normalize weights if exclusion occurs.
6. Return a JSON object with the structure:
{
  "summary": string,
  "reasoning": [
    "Step 1: <data download>",
    "Step 2: <metric calculation>",
    "Step 3: <filter result>",
    "Step 4: <weighting and allocation>",
    "Step 5: <share sizing>"
  ],
  "positions": [
    {
      "symbol": string,
      "weight": number (0-1),
      "quantity": number,
      "estimated_cost": number,
      "rationale": string
    }
  ]
}
Ensure numeric values are floats (not strings) and weights sum to 1 (within floating point tolerance). Reference the reasoning steps when producing rationales for each position.
Respond using ONLY a JSON code fence. The final assistant message must be:
\`\`\`json
{ ... }
\`\`\`
Do not include commentary outside the JSON payload.
`;

  const response = await client.responses.create({
    model: process.env.OPENAI_COMPOSER_MODEL || 'o4-mini',
    reasoning: { effort: 'high' },
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
        ],
      },
    ],
    tools: [
      {
        type: 'code_interpreter',
        container: {
          type: 'auto',
          file_ids: [],
        },
      },
    ],
  });

  const messages = [];
  if (Array.isArray(response.output)) {
    response.output.forEach((entry) => {
      if (entry.type === 'message' && Array.isArray(entry.content)) {
        entry.content.forEach((piece) => {
          if (piece.type === 'output_text' && piece.text) {
            messages.push(piece.text);
          }
        });
      }
    });
  }

  let parsed = null;
  for (const text of messages) {
    parsed = extractJson(text);
    if (parsed) {
      break;
    }
  }

  if (!parsed) {
    if (messages.length) {
      console.warn('[ComposerStrategy] Code interpreter output without parseable JSON:', messages);
    }
    throw new Error('Failed to extract structured JSON from code interpreter response.');
  }

  if (parsed && typeof parsed === 'object') {
    parsed.meta = {
      codeInterpreter: {
        used: true,
        blueprint: Array.isArray(blueprintSteps) ? blueprintSteps : [],
        tickers: Array.isArray(detectedTickers) ? detectedTickers : [],
      },
    };
  }

  return parsed;
};

module.exports = {
  runComposerStrategy,
};
