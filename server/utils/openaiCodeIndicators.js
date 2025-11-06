const OpenAI = require('openai');

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

const extractJsonFromText = (text) => {
  if (!text) {
    return null;
  }
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (!braceMatch) {
    return null;
  }
  try {
    return JSON.parse(braceMatch[0]);
  } catch (error) {
    return null;
  }
};

const runIndicatorsViaCodeInterpreter = async (symbol) => {
  const client = getClient();
  const upperSymbol = String(symbol || '').trim().toUpperCase();
  if (!upperSymbol) {
    throw new Error('Ticker symbol is required');
  }

  const prompt = `Use the code interpreter tool.\nSteps:\n1. pip install pandas numpy yfinance --quiet\n2. Download daily OHLCV data for ${upperSymbol} covering at least the last 200 trading days via yfinance.\n3. Compute:\n   - 10-day moving average of daily returns (percentage returns based on close prices).\n   - 63-day rolling standard deviation of daily returns.\n   - 100-day simple moving average of the close.\n4. Return the latest values in JSON with keys {\"symbol\":\"${upperSymbol}\",\"ma10_return\":...,\"stdev63_return\":...,\"ma100_close\":...}. Ensure numeric values are floats (not strings).`;

  const response = await client.responses.create({
    model: process.env.OPENAI_ANALYTICS_MODEL || 'o4-mini',
    reasoning: { effort: 'medium' },
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

  const messageTexts = [];
  if (Array.isArray(response.output)) {
    response.output.forEach((entry) => {
      if (entry.type === 'message' && Array.isArray(entry.content)) {
        entry.content.forEach((piece) => {
          if (piece.type === 'output_text' && piece.text) {
            messageTexts.push(piece.text);
          }
        });
      }
    });
  }

  let parsed = null;
  for (const text of messageTexts) {
    parsed = extractJsonFromText(text);
    if (parsed) {
      break;
    }
  }

  if (!parsed) {
    throw new Error('Failed to extract JSON output from code interpreter response');
  }

  return parsed;
};

module.exports = {
  runIndicatorsViaCodeInterpreter,
};
