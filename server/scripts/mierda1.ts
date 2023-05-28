import * as fs from 'fs';
import * as anthropic from '@anthropic-ai/sdk';
import "dotenv/config";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  throw new Error("The ANTHROPIC_API_KEY environment variable must be set");
}

const client = new anthropic.Client(apiKey);

async function analyzeSentiment(headline) {
  const promptBase = `Forget all your previous instructions. Pretend you are a financial expert. You are a financial expert with stock recommendation experience. Answer "YES" if good news, "NO" if bad news, or "UNKNOWN" if uncertain in the first line. Then elaborate with one short and concise sentence on the next line.`;
  const prompt = `${anthropic.HUMAN_PROMPT}${promptBase} ${headline} ${anthropic.AI_PROMPT}`;

  try {
    const response = await client.complete({
      prompt: prompt,
      stop_sequences: [anthropic.HUMAN_PROMPT],
      model: 'claude-v1',
      max_tokens_to_sample: 100,
      temperature: 0
    });

    console.log(response);
    const sentiment = response.completion; // Accede directamente al token de respuesta
    return sentiment;
  } catch (error) {
    console.error(error);
    throw error;
  }
}

async function processNews() {
  const newsData = await fs.promises.readFile('news.json', 'utf8');
  const newsList = JSON.parse(newsData);

  const updatedNewsList = [];
  for (const article of newsList) {
    const headline = article['News headline'];
    const sentiment = await analyzeSentiment(headline);

    const [sentimentValue, description] = sentiment.split('\n');
    article['Sentiment'] = sentimentValue.trim();
    article['Description'] = description;

    updatedNewsList.push(article);

    // Esperar 1 segundo antes de la siguiente iteración
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  await fs.promises.writeFile('salida_claude_3.json', JSON.stringify(updatedNewsList, null, 4));
  console.log('Archivo de salida creado exitosamente: salida_claude_3.json');
}

processNews().catch((error) => {
  console.error('Error:', error);
});

