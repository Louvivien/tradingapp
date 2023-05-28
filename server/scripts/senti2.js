const { Configuration, OpenAIApi } = require("openai");
const fs = require('fs');
const util = require('util');
const sleep = util.promisify(setTimeout);

class SentimentAnalyzer {
    constructor(apiKey) {
        const configuration = new Configuration({ apiKey: apiKey });
        this.openai = new OpenAIApi(configuration);
    }

    async analyzeSentiment(text) {
        const prompt = `Forget all your previous instructions. Pretend you are a financial expert. You are a financial expert with stock recommendation experience. Answer “YES” if good news, “NO” if bad news, or “UNKNOWN” if uncertain in the first line. Then
elaborate with one short and concise sentence on the next line`;
        const MODEL = "text-davinci-003";

        let retries = 0;
        let response;
        while (retries < 5) {
            try {
                response = await this.openai.createCompletion({
                    model: MODEL,
                    prompt: prompt + '\n' + text,
                    max_tokens: 60,
                    temperature: 0,
                });
                break;
            } catch (error) {
                if (error.status === 429) {
                    console.log("RateLimitError: That model is currently overloaded with other requests. Retrying in 10 seconds.");
                    await sleep(10000);
                    retries++;
                } else {
                    throw error;
                }
            }
        }

        if (retries === 5) {
            throw new Error("Failed to get response from OpenAI after 5 retries.");
        }

        return response.data.choices[0].text.trim();
    }

    async analyzeNews(file) {
        const news = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const results = [];

        for (let article of news) {
            //console.log(article['News headline']);
            const content = await this.analyzeSentiment(article['News headline']);
            console.log(content);
            
            // Extract sentiment and description using regex
            let sentiment = '';
            let description = '';
            
            const matched = content.trim().match(/^(?:[\s\S]*?)?(\bYES\b|\bNO\b|\bUNKNOWN\b)(?:\s*-)?\s*(.*)$/i);
            if (matched) {
                sentiment = matched[1].trim();
                description = matched[2].trim();
            } else {
                description = content.trim();
            }
        
            article['Sentiment'] = sentiment;
            article['Description'] = description;
            results.push(article);
        }
        
        
        
        
        

        return results;
    }
}

async function main() {
    const apiKey = process.env.OPENAI_API_KEY;
    const analyzer = new SentimentAnalyzer(apiKey);

    const results = await analyzer.analyzeNews('news.json');
    fs.writeFileSync('news_with_sentiment.json', JSON.stringify(results, null, 2), 'utf-8');
}

main().catch(error => console.error(error));

