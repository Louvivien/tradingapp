import os
import json
import anthropic 
from dotenv import load_dotenv

load_dotenv("../config/.env")

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")

claude = anthropic.Client(api_key=ANTHROPIC_API_KEY)

def analyze_sentiment(headline):
    #print(headline)
    prompt_base="""Forget all your previous instructions. Pretend you are a financial expert. You are a financial expert with stock recommendation experience. Answer “YES” if good news, “NO” if bad news, or “UNKNOWN” if uncertain in the first line. Then
elaborate with one short and concise sentence on the next line. """
    prompt = f'{anthropic.HUMAN_PROMPT}{prompt_base} {headline} {anthropic.AI_PROMPT}'
    response = claude.completion(
        prompt=prompt, 
        stop_sequences=[anthropic.HUMAN_PROMPT],
        model='claude-v1', 
        max_tokens_to_sample=100,
        temperature=0  # Agregar esto!
    )
    print(response)
    #sentiment = json.loads(response)['sentiment']
    sentiment = response['completion']  # Accede directamente al token de respuesta
    return sentiment

with open('news.json') as f:
    news = json.load(f)

results = []
for article in news:
    headline = article['News headline']
    sentiment1 = analyze_sentiment(headline)
    #sentiment2 = analyze_sentiment(headline)
    sentiment, description = sentiment1.split('\n')
    article['Sentiment'] = sentiment.strip()
    article['Description'] = description
    #if sentiment1 == sentiment2:
    #   article['Sentiment'] = sentiment1
    #    print(sentiment1)
    #else:
    #    print("Esta dando 0")
    #    article['Sentiment'] = 0
        
    results.append(article)

with open('salida_claude_2.json', 'w') as f:
    json.dump(results, f, indent=4)  # Agregar indent=4